import { AuditAction, Prisma } from '@/generated/tenant';
import { audit, type AuditContext } from '@/lib/audit/audit';
import { post } from '@/lib/gl/post';

// =============================================================================
// COGS posting service — Part 3 of the costing engine slice.
//
// postCogsForInvoiceTx walks Invoice → InvoiceLine → SalesOrderLine →
// InventoryMovement (CONSUME) → FifoConsumption to compute COGS at the
// per-warehouse granularity, posts ONE JE with one DR COGS line and N CR
// Inventory lines (one per warehouse touched), and flips
// Invoice.cogsPosted = true. Idempotent against re-call (Invoice-side flag
// pre-check; gl.post's (entityType, entityId, description) guard is the
// belt-and-suspenders second line of defense).
//
// Sequence inside closeSalesOrder is:
//   1. consumeInventoryTx per line (creates CONSUME + FifoConsumption rows)
//   2. SOLine.update(qtyShipped, qtyReserved, inventoryMovementId)
//   3. SalesOrder.update(status=CLOSED)
//   4. recomputeReservedForBin per bin
//   5. generateInvoiceForClosedSOTx (creates Invoice + AR/Revenue JE)
//   6. postCogsForInvoiceTx (creates COGS JE, flips cogsPosted)  ← this
//
// JE shape (matches docs/08-gl-costing-reporting.md):
//   DR 5100 Cost of Goods Sold        SUM over all lines
//   CR <warehouse.inventoryAccount>   per-warehouse FIFO subtotal
//
// Drop-ship + service lines naturally produce no FifoConsumption rows
// (they don't trigger consumeInventoryTx through closeSalesOrder), so
// they contribute $0 to COGS. If TOTAL COGS is $0 we set the flag and
// skip the JE entirely — gl.post requires SUM(Dr) === SUM(Cr) > 0.
//
// TODO (deferred): when the GL slice ships AccountingPeriod with hard-
// vs. soft-close, this function should refuse posting into a hard-closed
// period and set Invoice.cogsPostingBlocked instead of throwing. Field +
// gate not added in Part 3; see docs/08-gl-costing-reporting.md.
//
// TODO (deferred to Part 3.5): COGS reversal on voidInvoice + creditFromRma
// (DR Inventory / CR COGS, restore FifoLayer state). Forward path only
// here — voidInvoice's existing AR-side reversal stays as-is.
// =============================================================================

const COGS_ACCOUNT = '5100';

export type SkippedLine = {
  invoiceLineId: string;
  reason: 'no_so_link' | 'no_inventory_movement' | 'zero_cogs';
};

export type PostCogsResult = {
  skipped: 'already_posted' | 'zero_cogs' | null;
  jeId: string | null;
  cogsAmount: Prisma.Decimal;
  warehousesPosted: string[];
  skippedLines: SkippedLine[];
};

export async function postCogsForInvoiceTx(
  tx: Prisma.TransactionClient,
  invoiceId: string,
  ctx?: AuditContext,
): Promise<PostCogsResult> {
  const invoice = await tx.invoice.findUnique({
    where: { id: invoiceId },
    select: {
      id: true,
      number: true,
      cogsPosted: true,
      deletedAt: true,
    },
  });
  if (!invoice) {
    throw new Error(`postCogsForInvoiceTx: Invoice not found: ${invoiceId}`);
  }
  if (invoice.deletedAt) {
    throw new Error(
      `postCogsForInvoiceTx: Invoice is soft-deleted (id=${invoiceId})`,
    );
  }

  // Idempotency layer 1: Invoice-side flag pre-check. Same-tx re-calls
  // see this and return early without touching gl.post.
  if (invoice.cogsPosted) {
    return {
      skipped: 'already_posted',
      jeId: null,
      cogsAmount: new Prisma.Decimal(0),
      warehousesPosted: [],
      skippedLines: [],
    };
  }

  // Walk Invoice → InvoiceLine → SOLine → CONSUME movement → FifoConsumption.
  // Group consumptions by the warehouse of the parent SOLine (NOT the
  // layer's warehouse — they're identical because consumeFromLayersTx
  // filters layers by the bin, but the SOLine's warehouseId is the
  // semantic source for the credit-account decision).
  const invoiceLines = await tx.invoiceLine.findMany({
    where: { invoiceId, deletedAt: null },
    select: {
      id: true,
      salesOrderLineId: true,
    },
  });

  if (invoiceLines.length === 0) {
    throw new Error(
      `postCogsForInvoiceTx: invoice ${invoice.number} has no lines`,
    );
  }

  // Per-warehouse running totals. Map keyed by warehouseId so multi-bin
  // invoices produce one CR Inventory line per bin in deterministic order.
  type BinTotal = {
    warehouseId: string;
    inventoryAccountCode: string;
    cogs: Prisma.Decimal;
  };
  const binTotals = new Map<string, BinTotal>();
  const skippedLines: SkippedLine[] = [];

  // Skip conditions for the per-line walk below — observability matters
  // for future debugging of "where did COGS go?":
  //
  //   1. no_so_link            InvoiceLine.salesOrderLineId is null.
  //                            Drop-ship, service, or manual-add line.
  //                            No FIFO cost path exists, by design.
  //
  //   2. no_inventory_movement SOLine.inventoryMovementId is null.
  //                            Either a legacy pre-Part-3 close (no
  //                            backfill — see schema comment), or some
  //                            future build/component path that doesn't
  //                            go through consumeInventoryTx.
  //
  //   3. zero_cogs             FifoConsumption rows summed to <= 0.
  //                            Three sub-causes:
  //                            (a) no consumptions at all (shouldn't
  //                                happen if (1)+(2) passed; defensive)
  //                            (b) pure negative-allocation movement —
  //                                consume hit a bin with no layers and
  //                                neg-inv flag was ON; the cost is
  //                                "unknown" until back-fill ships
  //                            (c) legitimate $0 layer (free goods)
  //
  // NOT skipped: negative-allocation sub-case B (some layers covered
  // partially, more was drawn than they held). The covered portion
  // contributes its known cost to COGS; the over-draw portion sits as
  // future retro-adjustment work for the back-fill slice. Movement.
  // negativeAllocation=true is the auditor's flag — COGS today is
  // honest about the partial.
  for (const il of invoiceLines) {
    if (!il.salesOrderLineId) {
      skippedLines.push({ invoiceLineId: il.id, reason: 'no_so_link' });
      continue;
    }
    const sol = await tx.salesOrderLine.findUnique({
      where: { id: il.salesOrderLineId },
      select: {
        id: true,
        warehouseId: true,
        inventoryMovementId: true,
        warehouse: {
          select: {
            id: true,
            code: true,
            inventoryAccount: { select: { code: true } },
          },
        },
      },
    });
    if (!sol) {
      skippedLines.push({ invoiceLineId: il.id, reason: 'no_so_link' });
      continue;
    }
    if (!sol.inventoryMovementId) {
      skippedLines.push({ invoiceLineId: il.id, reason: 'no_inventory_movement' });
      continue;
    }

    if (!sol.warehouse.inventoryAccount?.code) {
      throw new Error(
        `postCogsForInvoiceTx: warehouse '${sol.warehouse.code}' has no inventoryAccountId — link it to a GL account before closing SOs that ship from it`,
      );
    }

    const consumptions = await tx.fifoConsumption.findMany({
      where: { movementId: sol.inventoryMovementId },
      select: { qty: true, unitCost: true },
    });

    let lineCogs = new Prisma.Decimal(0);
    for (const c of consumptions) {
      lineCogs = lineCogs.plus(c.qty.times(c.unitCost));
    }
    if (lineCogs.lessThanOrEqualTo(0)) {
      skippedLines.push({ invoiceLineId: il.id, reason: 'zero_cogs' });
      continue;
    }

    const accountCode = sol.warehouse.inventoryAccount.code;
    const existing = binTotals.get(sol.warehouse.id);
    if (existing) {
      existing.cogs = existing.cogs.plus(lineCogs);
    } else {
      binTotals.set(sol.warehouse.id, {
        warehouseId: sol.warehouse.id,
        inventoryAccountCode: accountCode,
        cogs: lineCogs,
      });
    }
  }

  // Total COGS across all bins.
  let totalCogs = new Prisma.Decimal(0);
  for (const b of binTotals.values()) totalCogs = totalCogs.plus(b.cogs);

  // Zero-COGS short-circuit. Drop-ship-only / service-only invoices land
  // here — flip the flag (so re-runs no-op via the layer-1 idempotency
  // check) but skip the JE. gl.post would reject SUM(Dr)=0 anyway.
  if (totalCogs.lessThanOrEqualTo(0)) {
    await tx.invoice.update({
      where: { id: invoiceId },
      // Snapshot 0 so MARGIN-basis commission accrual sees a definite
      // zero, not NULL — distinguishes "this invoice produced no
      // COGS" from "this invoice predates the field."
      data: { cogsPosted: true, cogsAtClose: new Prisma.Decimal(0) },
    });
    await audit(tx, {
      action: AuditAction.UPDATE,
      entityType: 'Invoice',
      entityId: invoiceId,
      before: { cogsPosted: false },
      after: {
        cogsPosted: true,
        cogsJournalEntryId: null,
        cogsAmount: '0',
        warehousesPosted: [],
        reason: 'zero_cogs',
      },
      ctx,
    });
    return {
      skipped: 'zero_cogs',
      jeId: null,
      cogsAmount: totalCogs,
      warehousesPosted: [],
      skippedLines,
    };
  }

  // Sort credit lines by warehouse id for deterministic JE line order.
  const orderedBins = Array.from(binTotals.values()).sort((a, b) =>
    a.warehouseId.localeCompare(b.warehouseId),
  );

  const jeLines: Array<{
    accountCode: string;
    debit?: Prisma.Decimal;
    credit?: Prisma.Decimal;
    memo?: string;
  }> = [
    {
      accountCode: COGS_ACCOUNT,
      debit: totalCogs,
      memo: `COGS — invoice ${invoice.number}`,
    },
  ];
  for (const b of orderedBins) {
    jeLines.push({
      accountCode: b.inventoryAccountCode,
      credit: b.cogs,
      memo: `Inventory relief — invoice ${invoice.number}`,
    });
  }

  // Idempotency layer 2: gl.post's own (entityType, entityId, description)
  // guard. If a non-reversed COGS JE already exists for this invoice, it
  // throws — but the layer-1 check above means we'd never reach here on a
  // re-call. The double guard is defense-in-depth against a future caller
  // that bypasses the cogsPosted flag (e.g., manual JE edit + reset).
  const je = await post(tx, {
    entityType: 'Invoice',
    entityId: invoice.id,
    description: `Post COGS for invoice ${invoice.number}`,
    lines: jeLines,
  });

  await tx.invoice.update({
    where: { id: invoiceId },
    // Snapshot total COGS for fast MARGIN-basis commission accrual
    // lookups. Same value as the JE's debit total; storing it avoids
    // re-walking FifoConsumption per payment-application.
    data: { cogsPosted: true, cogsAtClose: totalCogs },
  });

  await audit(tx, {
    action: AuditAction.UPDATE,
    entityType: 'Invoice',
    entityId: invoiceId,
    before: { cogsPosted: false },
    after: {
      cogsPosted: true,
      cogsAtClose: totalCogs.toString(),
      cogsJournalEntryId: je.id,
      cogsAmount: totalCogs.toString(),
      warehousesPosted: orderedBins.map((b) => b.warehouseId),
    },
    ctx,
  });

  return {
    skipped: null,
    jeId: je.id,
    cogsAmount: totalCogs,
    warehousesPosted: orderedBins.map((b) => b.warehouseId),
    skippedLines,
  };
}
