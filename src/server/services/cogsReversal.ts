import { AuditAction, InventoryMovementType, Prisma } from '@/generated/tenant';
import { audit, type AuditContext } from '@/lib/audit/audit';
import { post } from '@/lib/gl/post';
import { createFifoLayerForReturnTx } from '@/server/services/fifoLayers';
import { recomputeOnHand } from '@/server/services/movements';

// =============================================================================
// COGS reversal service — Part 3.5 of the costing engine slice.
//
// Two entry points, one shared per-(warehouse, variant) aggregation pattern:
//
//   reverseCogsForInvoiceTx — full reversal of an Invoice's posted COGS.
//     Used by voidInvoice. Walks Invoice → InvoiceLine → SalesOrderLine →
//     InventoryMovement → FifoConsumption. Aggregates per (warehouse,
//     variant). Creates RMA_RETURN movement + new FifoLayer per (warehouse,
//     variant) touched. Posts JE: N DR <warehouse-Inventory> / 1 CR 5100
//     (COGS) — DR lines collapse to one per warehouse even when multiple
//     variants hit the same warehouse, since they share an inventory account.
//
//   reverseCogsForCreditMemoTx — partial-or-full reversal driven by an
//     RMA-confirmed CreditMemo. Routes by category.lossAccountId + RMA
//     state:
//       GOODS-BACK PATH (lossAccountId=null AND rma.returnless=false AND
//       rma.receivedAt IS NOT NULL): pro-rate per RmaLine.qty over the
//       FIFO-covered consumption. Create RMA_RETURN movement + new layer
//       per (warehouse, variant). Post N DR Inventory / 1 CR COGS.
//
//       LOSS-RECLASSIFICATION PATH (lossAccountId set): pro-rate the same
//       way but DON'T restore inventory. Post 1 DR <lossAccount> / 1 CR
//       COGS. No FifoLayer creation. No RMA_RETURN movement.
//
//       PURE-AR PATH (lossAccountId=null AND (rma.returnless=true OR
//       rma.receivedAt IS NULL)): no-op. Existing AR-side reversal stays
//       as the only effect.
//
// Pro-rata numerator (CM path): CmLine.qty — the approved-credit qty —
// NOT RmaLine.qty (what physically came back). These can diverge after
// operator edits to the CM draft (e.g. "10 came back but we only credit
// 7 because 3 were unsellable damage we're absorbing"). Using CmLine.qty
// keeps inventory restoration symmetric with AR reversal: restore
// exactly what we credited. The "physical surplus" case (more came back
// than we credited) is an operator decision needing separate write-off
// handling, NOT something the automatic flow should silently absorb.
//
// Pro-rata denominator: SUM(FifoConsumption.qty for the original CONSUME
// movement). NOT SalesOrderLine.qtyShipped. Reason — for negative_allocation
// sub-case B (FIFO covered partial, neg-inv flag ON), qtyShipped exceeds
// SUM(FifoConsumption.qty) by the over-draw amount. Pro-rating against
// qtyShipped would incorrectly attribute "cost" to the over-draw portion
// (which has no FifoConsumption rows because the layer was empty when it
// drained). Using SUM(FifoConsumption.qty) keeps the reversal honest about
// the partial: only the FIFO-covered portion has known cost, and reversal
// only touches that portion. The over-draw portion stays as future retro-
// adjustment work for the back-fill slice. For non-negative-allocation
// movements, SUM(FifoConsumption.qty) === qtyShipped, so the formula
// degenerates to the "intuitive" denominator.
//
// Idempotency layered for defense in depth (same pattern as cogsPosting.ts):
//   - Invoice-side / CM-side flag pre-check returns early no-op
//   - gl.post's (entityType, entityId, description) duplicate guard catches
//     same-tx replays as a backstop
//   - Description partitions cleanly: 'Reverse COGS for invoice {n}' vs.
//     'Reverse COGS for credit memo {n}' vs. 'Loss reclassification for
//     credit memo {n}' so multi-event invoices don't conflict.
//
// Strict throw on null Warehouse.inventoryAccountId — matches
// postCogsForInvoiceTx's behavior exactly. Configuration error surfaces
// loud at reversal time. Error message uses the entry-point function name
// as prefix to aid debugging.
// =============================================================================

const COGS_ACCOUNT = '5100';

export type ReversalSkippedLine = {
  lineId: string; // invoiceLineId for invoice path; cmLineId for CM path
  reason: 'no_so_link' | 'no_inventory_movement' | 'zero_cogs';
};

export type ReverseCogsResult = {
  skipped: 'already_reversed' | 'cogs_not_posted' | 'pure_ar' | 'zero_reversal' | null;
  jeId: string | null;
  reversalAmount: Prisma.Decimal;
  warehousesReversed: string[];
  layersCreated: string[]; // FifoLayer ids; empty for loss-reclass and pure-ar paths
  skippedLines: ReversalSkippedLine[];
};

// ---------------------------------------------------------------------------
// reverseCogsForInvoiceTx — voidInvoice's COGS-reversal hook.
// ---------------------------------------------------------------------------

export async function reverseCogsForInvoiceTx(
  tx: Prisma.TransactionClient,
  invoiceId: string,
  ctx?: AuditContext,
): Promise<ReverseCogsResult> {
  const invoice = await tx.invoice.findUnique({
    where: { id: invoiceId },
    select: {
      id: true,
      number: true,
      cogsPosted: true,
      cogsReversed: true,
      deletedAt: true,
    },
  });
  if (!invoice) {
    throw new Error(`reverseCogsForInvoiceTx: Invoice not found: ${invoiceId}`);
  }
  if (invoice.deletedAt) {
    throw new Error(
      `reverseCogsForInvoiceTx: Invoice is soft-deleted (id=${invoiceId})`,
    );
  }

  // Layer-1 idempotency: already reversed.
  if (invoice.cogsReversed) {
    return emptyResult('already_reversed');
  }

  // Nothing to reverse if COGS was never posted (zero-COGS invoice or
  // pre-Part-3 invoice). Flip the cogsReversed flag anyway so semantics
  // are consistent ("we considered reversing, no work to do") and re-runs
  // short-circuit on the layer-1 check.
  if (!invoice.cogsPosted) {
    await tx.invoice.update({
      where: { id: invoiceId },
      data: { cogsReversed: true },
    });
    await audit(tx, {
      action: AuditAction.UPDATE,
      entityType: 'Invoice',
      entityId: invoiceId,
      before: { cogsReversed: false },
      after: {
        cogsReversed: true,
        reversalAmount: '0',
        warehousesReversed: [],
        reason: 'cogs_not_posted',
      },
      ctx,
    });
    return emptyResult('cogs_not_posted');
  }

  const invoiceLines = await tx.invoiceLine.findMany({
    where: { invoiceId, deletedAt: null },
    select: { id: true, salesOrderLineId: true },
  });
  if (invoiceLines.length === 0) {
    throw new Error(
      `reverseCogsForInvoiceTx: invoice ${invoice.number} has no lines`,
    );
  }

  // Per-(warehouse, variant) aggregation: walk each line's CONSUME movement,
  // sum its FifoConsumption rows. Full reversal — every consumed unit comes
  // back. Each line's full FifoConsumption set contributes; pro-rata factor = 1.
  const binTotals = new Map<string, BinAggregate>();
  const skippedLines: ReversalSkippedLine[] = [];

  for (const il of invoiceLines) {
    const result = await accumulateLineReversal(tx, {
      invoiceLineId: il.id,
      salesOrderLineId: il.salesOrderLineId,
      proRataFactor: new Prisma.Decimal(1),
      functionName: 'reverseCogsForInvoiceTx',
    });
    if (result.skip) {
      skippedLines.push({ lineId: il.id, reason: result.skip });
      continue;
    }
    mergeBinTotal(binTotals, result.bin);
  }

  return finalizeGoodsBackReversal(tx, {
    entityType: 'Invoice',
    entityId: invoice.id,
    entityNumber: invoice.number,
    description: `Reverse COGS for invoice ${invoice.number}`,
    binTotals,
    skippedLines,
    flagSetter: async () => {
      await tx.invoice.update({
        where: { id: invoiceId },
        data: { cogsReversed: true },
      });
    },
    auditEntityType: 'Invoice',
    auditEntityId: invoiceId,
    ctx,
  });
}

// ---------------------------------------------------------------------------
// reverseCogsForCreditMemoTx — creditFromRma's COGS-reversal hook.
// ---------------------------------------------------------------------------

export async function reverseCogsForCreditMemoTx(
  tx: Prisma.TransactionClient,
  creditMemoId: string,
  ctx?: AuditContext,
): Promise<ReverseCogsResult> {
  const cm = await tx.creditMemo.findUnique({
    where: { id: creditMemoId },
    select: {
      id: true,
      number: true,
      cogsReversed: true,
      deletedAt: true,
      lines: {
        where: { deletedAt: null },
        select: {
          id: true,
          invoiceLineId: true,
          qty: true,
        },
      },
      category: {
        select: {
          code: true,
          lossAccountId: true,
          lossAccount: { select: { code: true } },
        },
      },
      rma: {
        select: {
          id: true,
          returnless: true,
          receivedAt: true,
          lines: { select: { id: true, invoiceLineId: true, qty: true } },
        },
      },
    },
  });
  if (!cm) {
    throw new Error(
      `reverseCogsForCreditMemoTx: CreditMemo not found: ${creditMemoId}`,
    );
  }
  if (cm.deletedAt) {
    throw new Error(
      `reverseCogsForCreditMemoTx: CreditMemo is soft-deleted (id=${creditMemoId})`,
    );
  }

  // Layer-1 idempotency: already reversed.
  if (cm.cogsReversed) {
    return emptyResult('already_reversed');
  }

  // Routing decision.
  const hasLossAccount = cm.category.lossAccountId != null;
  const goodsBack =
    !hasLossAccount &&
    cm.rma != null &&
    !cm.rma.returnless &&
    cm.rma.receivedAt != null;
  const lossReclass = hasLossAccount;
  // Otherwise: pure-AR path (no RMA, returnless RMA, or RMA without
  // receivedAt — manager-discretion / standalone CM / damaged-in-transit).

  if (!goodsBack && !lossReclass) {
    // Pure-AR path: no JE, no state change. Existing AR-side reversal
    // (already posted by confirmCreditMemoTx) stays the only effect.
    return emptyResult('pure_ar');
  }

  // Both goods-back and loss-reclass walk the same data: CmLine →
  // InvoiceLine → SOLine → InventoryMovement → FifoConsumption, pro-rated
  // by RmaLine.qty / SUM(FifoConsumption.qty for the movement).
  //
  // Edge case: if the CM has lossAccount set but no RMA, that's an
  // operator-error scenario (loss-reclass requires an RMA to anchor the
  // returned-line qty). Today there's no UI to create a standalone-CM
  // with lossAccount, but defending against it: treat as zero-reversal.
  if (lossReclass && !cm.rma) {
    await tx.creditMemo.update({
      where: { id: creditMemoId },
      data: { cogsReversed: true },
    });
    await audit(tx, {
      action: AuditAction.UPDATE,
      entityType: 'CreditMemo',
      entityId: creditMemoId,
      before: { cogsReversed: false },
      after: {
        cogsReversed: true,
        reversalAmount: '0',
        reason: 'loss_reclass_without_rma',
      },
      ctx,
    });
    return emptyResult('zero_reversal');
  }

  const rma = cm.rma!;
  const rmaLines = rma.lines;
  const rmaQtyByInvoiceLine = new Map(
    rmaLines.map((rl) => [rl.invoiceLineId, rl] as const),
  );

  const binTotals = new Map<string, BinAggregate>();
  const skippedLines: ReversalSkippedLine[] = [];

  // Walk CM lines (each linked to an invoice line). The rmaQtyByInvoiceLine
  // lookup is used to VALIDATE that the CM line points at a returnable
  // invoice line (one that has a matching RmaLine on the same RMA) — it
  // is NOT used for qty math. Qty math uses cmLine.qty per the header's
  // pro-rata-numerator note.
  for (const cmLine of cm.lines) {
    if (!cmLine.invoiceLineId) {
      skippedLines.push({ lineId: cmLine.id, reason: 'no_so_link' });
      continue;
    }
    const rmaLine = rmaQtyByInvoiceLine.get(cmLine.invoiceLineId);
    if (!rmaLine) {
      // CM line for an invoice line that isn't on the RMA. Treat as not
      // returnable through this CM and skip — the AR-side already credited
      // it but there's no goods-back signal to anchor a reversal.
      skippedLines.push({ lineId: cmLine.id, reason: 'no_so_link' });
      continue;
    }

    const il = await tx.invoiceLine.findUnique({
      where: { id: cmLine.invoiceLineId },
      select: { salesOrderLineId: true },
    });
    if (!il) {
      skippedLines.push({ lineId: cmLine.id, reason: 'no_so_link' });
      continue;
    }

    const result = await accumulateLineReversal(tx, {
      invoiceLineId: cmLine.invoiceLineId,
      salesOrderLineId: il.salesOrderLineId,
      proRataNumerator: new Prisma.Decimal(cmLine.qty),
      functionName: 'reverseCogsForCreditMemoTx',
    });
    if (result.skip) {
      skippedLines.push({ lineId: cmLine.id, reason: result.skip });
      continue;
    }
    mergeBinTotal(binTotals, result.bin);
  }

  // Loss-reclassification path: post DR <lossAccount> / CR COGS. No
  // inventory restoration. No FifoLayer creation. No RMA_RETURN movement.
  if (lossReclass) {
    return finalizeLossReclassReversal(tx, {
      cm,
      binTotals,
      skippedLines,
      ctx,
    });
  }

  // Goods-back path.
  return finalizeGoodsBackReversal(tx, {
    entityType: 'CreditMemo',
    entityId: cm.id,
    entityNumber: cm.number,
    description: `Reverse COGS for credit memo ${cm.number}`,
    binTotals,
    skippedLines,
    flagSetter: async () => {
      await tx.creditMemo.update({
        where: { id: creditMemoId },
        data: { cogsReversed: true },
      });
    },
    auditEntityType: 'CreditMemo',
    auditEntityId: creditMemoId,
    ctx,
  });
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

type BinAggregate = {
  warehouseId: string;
  variantId: string;
  inventoryAccountCode: string;
  cogs: Prisma.Decimal;
  qty: Prisma.Decimal;
};

type LineAccumulateInput = {
  invoiceLineId: string;
  salesOrderLineId: string | null;
  // Either fixed factor (1.0 for full reversal) or numerator-only
  // (denominator computed from FifoConsumption sum).
  proRataFactor?: Prisma.Decimal;
  proRataNumerator?: Prisma.Decimal;
  functionName: 'reverseCogsForInvoiceTx' | 'reverseCogsForCreditMemoTx';
};

type LineAccumulateResult =
  | { skip: ReversalSkippedLine['reason']; bin?: never }
  | { skip?: never; bin: BinAggregate };

async function accumulateLineReversal(
  tx: Prisma.TransactionClient,
  input: LineAccumulateInput,
): Promise<LineAccumulateResult> {
  if (!input.salesOrderLineId) {
    return { skip: 'no_so_link' };
  }
  const sol = await tx.salesOrderLine.findUnique({
    where: { id: input.salesOrderLineId },
    select: {
      variantId: true,
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
  if (!sol) return { skip: 'no_so_link' };
  if (!sol.inventoryMovementId) return { skip: 'no_inventory_movement' };

  if (!sol.warehouse.inventoryAccount?.code) {
    throw new Error(
      `${input.functionName}: warehouse '${sol.warehouse.code}' has no inventoryAccountId — link it to a GL account before reversing COGS for this line`,
    );
  }

  const consumptions = await tx.fifoConsumption.findMany({
    where: { movementId: sol.inventoryMovementId },
    select: { qty: true, unitCost: true },
  });
  if (consumptions.length === 0) {
    return { skip: 'zero_cogs' };
  }
  let totalConsumedQty = new Prisma.Decimal(0);
  let totalConsumedCost = new Prisma.Decimal(0);
  for (const c of consumptions) {
    totalConsumedQty = totalConsumedQty.plus(c.qty);
    totalConsumedCost = totalConsumedCost.plus(c.qty.times(c.unitCost));
  }
  if (totalConsumedQty.lessThanOrEqualTo(0)) {
    return { skip: 'zero_cogs' };
  }

  // Resolve pro-rata factor.
  let factor: Prisma.Decimal;
  if (input.proRataFactor != null) {
    factor = input.proRataFactor;
  } else if (input.proRataNumerator != null) {
    factor = input.proRataNumerator.dividedBy(totalConsumedQty);
    if (factor.greaterThan(1)) factor = new Prisma.Decimal(1);
  } else {
    throw new Error(
      'accumulateLineReversal: caller must supply proRataFactor or proRataNumerator',
    );
  }

  const reversedQty = totalConsumedQty.times(factor);
  const reversedCost = totalConsumedCost.times(factor);
  if (reversedCost.lessThanOrEqualTo(0)) {
    return { skip: 'zero_cogs' };
  }

  return {
    bin: {
      warehouseId: sol.warehouse.id,
      variantId: sol.variantId,
      inventoryAccountCode: sol.warehouse.inventoryAccount.code,
      cogs: reversedCost,
      qty: reversedQty,
    },
  };
}

function mergeBinTotal(map: Map<string, BinAggregate>, add: BinAggregate): void {
  const key = `${add.warehouseId}:${add.variantId}`;
  const existing = map.get(key);
  if (existing) {
    existing.cogs = existing.cogs.plus(add.cogs);
    existing.qty = existing.qty.plus(add.qty);
  } else {
    map.set(key, { ...add });
  }
}

function emptyResult(skipped: ReverseCogsResult['skipped']): ReverseCogsResult {
  return {
    skipped,
    jeId: null,
    reversalAmount: new Prisma.Decimal(0),
    warehousesReversed: [],
    layersCreated: [],
    skippedLines: [],
  };
}

type GoodsBackArgs = {
  entityType: 'Invoice' | 'CreditMemo';
  entityId: string;
  entityNumber: string;
  description: string;
  binTotals: Map<string, BinAggregate>;
  skippedLines: ReversalSkippedLine[];
  flagSetter: () => Promise<void>;
  auditEntityType: 'Invoice' | 'CreditMemo';
  auditEntityId: string;
  ctx?: AuditContext;
};

async function finalizeGoodsBackReversal(
  tx: Prisma.TransactionClient,
  args: GoodsBackArgs,
): Promise<ReverseCogsResult> {
  let totalCogs = new Prisma.Decimal(0);
  for (const b of args.binTotals.values()) totalCogs = totalCogs.plus(b.cogs);

  if (totalCogs.lessThanOrEqualTo(0)) {
    // Zero-reversal short-circuit. Flip the flag, audit, return.
    await args.flagSetter();
    await audit(tx, {
      action: AuditAction.UPDATE,
      entityType: args.auditEntityType,
      entityId: args.auditEntityId,
      before: { cogsReversed: false },
      after: {
        cogsReversed: true,
        reversalAmount: '0',
        warehousesReversed: [],
        reason: 'zero_reversal',
      },
      ctx: args.ctx,
    });
    return {
      skipped: 'zero_reversal',
      jeId: null,
      reversalAmount: totalCogs,
      warehousesReversed: [],
      layersCreated: [],
      skippedLines: args.skippedLines,
    };
  }

  // Order bins by warehouseId then variantId for deterministic movement
  // creation order and JE line stability.
  const orderedBins = Array.from(args.binTotals.values()).sort((a, b) => {
    const cmp = a.warehouseId.localeCompare(b.warehouseId);
    return cmp !== 0 ? cmp : a.variantId.localeCompare(b.variantId);
  });

  const layerIds: string[] = [];
  const returnDate = new Date();
  for (const b of orderedBins) {
    const movementUnitCost = b.qty.greaterThan(0)
      ? b.cogs.dividedBy(b.qty)
      : new Prisma.Decimal(0);
    const movement = await tx.inventoryMovement.create({
      data: {
        variantId: b.variantId,
        warehouseId: b.warehouseId,
        type: InventoryMovementType.RMA_RETURN,
        qty: b.qty,
        unitCost: movementUnitCost,
        reference: args.entityNumber,
        notes: `${args.entityType} ${args.entityNumber} reversal`,
      },
    });

    const layer = await createFifoLayerForReturnTx(
      tx,
      {
        variantId: b.variantId,
        warehouseId: b.warehouseId,
        qty: b.qty,
        unitCost: movementUnitCost,
        returnDate,
        sourceMovementId: movement.id,
      },
      args.ctx,
    );
    layerIds.push(layer.id);

    // Recompute onHand for THIS (variantId, warehouseId) bin. Each iteration
    // is its own bin; recomputeOnHand aggregates over all movements for the
    // bin so the just-created RMA_RETURN is picked up automatically.
    await recomputeOnHand(tx, b.variantId, b.warehouseId);
  }

  // Per warehouse: SUM cogs across variants → one DR line per inventory
  // account. Variants in the same warehouse share an inventory account
  // (Warehouse.inventoryAccountId is per-warehouse, not per-variant), so
  // collapsing keeps the JE clean.
  const cogsByWarehouse = new Map<
    string,
    { accountCode: string; cogs: Prisma.Decimal }
  >();
  for (const b of orderedBins) {
    const existing = cogsByWarehouse.get(b.warehouseId);
    if (existing) {
      existing.cogs = existing.cogs.plus(b.cogs);
    } else {
      cogsByWarehouse.set(b.warehouseId, {
        accountCode: b.inventoryAccountCode,
        cogs: b.cogs,
      });
    }
  }
  const orderedWarehouses = Array.from(cogsByWarehouse.entries()).sort(
    ([a], [b]) => a.localeCompare(b),
  );

  const jeLines: Array<{
    accountCode: string;
    debit?: Prisma.Decimal;
    credit?: Prisma.Decimal;
    memo?: string;
  }> = [];
  for (const [, w] of orderedWarehouses) {
    jeLines.push({
      accountCode: w.accountCode,
      debit: w.cogs,
      memo: `Inventory restored — ${args.entityType.toLowerCase()} ${args.entityNumber}`,
    });
  }
  jeLines.push({
    accountCode: COGS_ACCOUNT,
    credit: totalCogs,
    memo: `COGS reversal — ${args.entityType.toLowerCase()} ${args.entityNumber}`,
  });

  const je = await post(tx, {
    entityType: args.entityType,
    entityId: args.entityId,
    description: args.description,
    lines: jeLines,
  });

  await args.flagSetter();
  await audit(tx, {
    action: AuditAction.UPDATE,
    entityType: args.auditEntityType,
    entityId: args.auditEntityId,
    before: { cogsReversed: false },
    after: {
      cogsReversed: true,
      reversalJournalEntryId: je.id,
      reversalAmount: totalCogs.toString(),
      warehousesReversed: orderedWarehouses.map(([whId]) => whId),
      layersCreated: layerIds,
    },
    ctx: args.ctx,
  });

  return {
    skipped: null,
    jeId: je.id,
    reversalAmount: totalCogs,
    warehousesReversed: orderedWarehouses.map(([whId]) => whId),
    layersCreated: layerIds,
    skippedLines: args.skippedLines,
  };
}

type LossReclassArgs = {
  cm: {
    id: string;
    number: string;
    category: { lossAccount: { code: string } | null };
  };
  binTotals: Map<string, BinAggregate>;
  skippedLines: ReversalSkippedLine[];
  ctx?: AuditContext;
};

async function finalizeLossReclassReversal(
  tx: Prisma.TransactionClient,
  args: LossReclassArgs,
): Promise<ReverseCogsResult> {
  const lossAccountCode = args.cm.category.lossAccount?.code;
  if (!lossAccountCode) {
    throw new Error(
      `reverseCogsForCreditMemoTx: lossAccountId set but GlAccount could not be resolved (cm=${args.cm.number})`,
    );
  }

  let totalCogs = new Prisma.Decimal(0);
  for (const b of args.binTotals.values()) totalCogs = totalCogs.plus(b.cogs);

  if (totalCogs.lessThanOrEqualTo(0)) {
    await tx.creditMemo.update({
      where: { id: args.cm.id },
      data: { cogsReversed: true },
    });
    await audit(tx, {
      action: AuditAction.UPDATE,
      entityType: 'CreditMemo',
      entityId: args.cm.id,
      before: { cogsReversed: false },
      after: {
        cogsReversed: true,
        reversalAmount: '0',
        reason: 'zero_reversal',
      },
      ctx: args.ctx,
    });
    return {
      skipped: 'zero_reversal',
      jeId: null,
      reversalAmount: totalCogs,
      warehousesReversed: [],
      layersCreated: [],
      skippedLines: args.skippedLines,
    };
  }

  // Loss-reclass JE: 1 DR <lossAccount> / 1 CR COGS. No per-warehouse
  // breakdown — the loss is recognized in aggregate at the loss-account
  // level, not per-bin (the inventory ledger isn't touched).
  const je = await post(tx, {
    entityType: 'CreditMemo',
    entityId: args.cm.id,
    description: `Loss reclassification for credit memo ${args.cm.number}`,
    lines: [
      {
        accountCode: lossAccountCode,
        debit: totalCogs,
        memo: `Loss recognition — credit memo ${args.cm.number}`,
      },
      {
        accountCode: COGS_ACCOUNT,
        credit: totalCogs,
        memo: `COGS reclassified to loss — credit memo ${args.cm.number}`,
      },
    ],
  });

  await tx.creditMemo.update({
    where: { id: args.cm.id },
    data: { cogsReversed: true },
  });
  await audit(tx, {
    action: AuditAction.UPDATE,
    entityType: 'CreditMemo',
    entityId: args.cm.id,
    before: { cogsReversed: false },
    after: {
      cogsReversed: true,
      reversalJournalEntryId: je.id,
      reversalAmount: totalCogs.toString(),
      lossAccountCode,
      reason: 'loss_reclass',
    },
    ctx: args.ctx,
  });

  return {
    skipped: null,
    jeId: je.id,
    reversalAmount: totalCogs,
    warehousesReversed: [],
    layersCreated: [],
    skippedLines: args.skippedLines,
  };
}
