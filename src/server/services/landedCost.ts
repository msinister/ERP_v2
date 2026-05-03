import { AllocationMethod, AuditAction, Prisma } from '@/generated/tenant';
import type { PrismaClient } from '@/generated/tenant';
import { audit, type AuditContext } from '@/lib/audit/audit';
import { post } from '@/lib/gl/post';

// =============================================================================
// Late landed cost retroactive adjustment — Part 4 of the costing engine slice.
//
// Two entry points:
//
//   applyLandedCostToReceipts — operator action: "freight bill of $X arrived
//     covering receipts [r1, r2, ...]; allocate by UNIT_COUNT or VALUE."
//     Walks Receipt → ReceiptLine → FifoLayer (1:1 via sourceReceiptLineId),
//     mutates each layer's unitCost, then walks each affected layer's
//     FifoConsumption rows. For each consumption:
//       - movement has no SOLine link → skip with reason 'orphan_consume',
//         layer cost still mutates, no JE for this consume.
//       - SOLine.salesOrder.invoice null OR invoice.cogsPosted=false → mutate
//         FifoConsumption.unitCost in place to match the new layer cost.
//         No COGS adjustment JE — the eventual cogsPosting run will read the
//         updated snapshot and post correct COGS in one shot.
//       - invoice.cogsPosted=true → aggregate per (invoice, warehouse) and
//         post ONE backdated COGS adjustment JE per pair. JE.postedAt is
//         set to the original CONSUME movement's createdAt for period
//         accuracy (spec docs/08-gl-costing-reporting.md:167).
//
//   reverseLandedCostAllocation — undo. Reads LandedCostAllocationLine rows,
//     restores each layer.unitCost from originalUnitCost (NOT a delta-subtract
//     — the snapshot is the source of truth, immune to other allocations that
//     stacked on top before reversal). Posts mirror-sign reversal JEs (same
//     postedAt as the forward JE) for every cogsAdjustmentJeId on file.
//     Idempotent against re-call: a non-null reversedAt short-circuits.
//
// OPERATOR POLICY (pilot scope): "reverse-then-reapply." If a freight
// bill is corrected from $100 to $120, the operator REVERSES the $100
// allocation (undoing both layer cost mutations and any GL JEs), then
// APPLIES the corrected $120 as a fresh allocation. This avoids
// delta-of-delta math and keeps the audit trail clean: each
// LandedCostAllocation is either active or reversed; corrections are
// separate rows. Multi-allocation interleaving (allocation B applied
// on top of allocation A, then A is reversed without first reversing
// B) is a deferred concern — the reverse path's "restore from snapshot"
// semantic would undo B's deltas too, requiring B to be re-applied
// afterward.
//
// Concurrency: all mutations live inside one db.$transaction. If any layer
// update or JE post fails, the whole allocation rolls back and the caller
// can retry without partial state. No advisory locks needed beyond the
// transaction's row-level locks on FifoLayer (Prisma's UPDATE acquires
// FOR UPDATE implicitly when used inside a $transaction with default
// isolation).
//
// Period gating: not implemented. Posts unconditionally to the original
// sale date.
// TODO: gate on AccountingPeriod.status === HARD_CLOSED when GL slice
// lands. The full GL slice (Module 7) ships AccountingPeriod with soft/
// hard close. Until then, late landed cost on a hard-closed period would
// silently rewrite that period's reported COGS — operationally harmless
// in pilot since there's no formal period-close process yet.
//
// Two GL accounts referenced. COGS_ACCOUNT mirrors cogsPosting.ts +
// cogsReversal.ts. INVENTORY_ACCOUNT_FALLBACK isn't used directly — we
// always read the warehouse's inventoryAccount.code. The fallback constant
// exists only as documentation of the expected default code per the spec.
// =============================================================================

const COGS_ACCOUNT = '5100';

export type ApplyLandedCostInput = {
  receiptIds: string[];
  totalLandedCost: string | number | Prisma.Decimal;
  allocationMethod: AllocationMethod;
  notes?: string;
};

export type LayerUpdateSummary = {
  fifoLayerId: string;
  originalUnitCost: Prisma.Decimal;
  newUnitCost: Prisma.Decimal;
  deltaUnitCost: Prisma.Decimal;
  deltaTotal: Prisma.Decimal;
  cogsAdjustmentJeId: string | null;
  consumptionsMutatedInPlace: number;
  consumptionsAdjustedViaJe: number;
  orphanConsumes: number;
};

export type ApplyLandedCostResult = {
  allocationId: string;
  layersUpdated: LayerUpdateSummary[];
  cogsAdjustmentJeIds: string[];
  totalAllocated: Prisma.Decimal;
};

export type ReverseLandedCostInput = {
  allocationId: string;
  reason: string;
};

export type ReverseLandedCostResult = {
  skipped: 'already_reversed' | null;
  reversalJeIds: string[];
  layersRestored: number;
};

// Walks a FifoConsumption row up the chain to its (invoice, warehouseId,
// originalSaleDate, cogsPosted) tuple. Returns null when the chain breaks
// (orphan CONSUME — no SOLine link). When SOLine exists but the SO has no
// invoice OR the invoice has cogsPosted=false, returns a tuple with
// invoice=null so the caller mutates consumption.unitCost in place rather
// than posting a JE.
type ConsumptionChain = {
  invoice: { id: string; number: string } | null;
  warehouseId: string;
  warehouseInventoryAccountCode: string | null;
  originalSaleDate: Date;
  invoiceCogsPosted: boolean;
};

async function walkConsumptionChain(
  tx: Prisma.TransactionClient,
  movementId: string,
): Promise<ConsumptionChain | null> {
  const movement = await tx.inventoryMovement.findUnique({
    where: { id: movementId },
    select: {
      createdAt: true,
      salesOrderLine: {
        select: {
          warehouseId: true,
          warehouse: {
            select: {
              inventoryAccount: { select: { code: true } },
            },
          },
          salesOrder: {
            select: {
              invoice: {
                select: { id: true, number: true, cogsPosted: true },
              },
            },
          },
        },
      },
    },
  });
  if (!movement) {
    throw new Error(
      `landedCost: FifoConsumption.movementId ${movementId} points to a missing InventoryMovement`,
    );
  }
  if (!movement.salesOrderLine) {
    return null; // orphan CONSUME (manual adjustment, transfer, etc.)
  }
  const sol = movement.salesOrderLine;
  return {
    invoice: sol.salesOrder.invoice
      ? { id: sol.salesOrder.invoice.id, number: sol.salesOrder.invoice.number }
      : null,
    warehouseId: sol.warehouseId,
    warehouseInventoryAccountCode: sol.warehouse.inventoryAccount?.code ?? null,
    originalSaleDate: movement.createdAt,
    invoiceCogsPosted: sol.salesOrder.invoice?.cogsPosted ?? false,
  };
}

function toDecimal(v: string | number | Prisma.Decimal): Prisma.Decimal {
  if (v instanceof Prisma.Decimal) return v;
  return new Prisma.Decimal(v);
}

export async function applyLandedCostToReceipts(
  db: PrismaClient,
  input: ApplyLandedCostInput,
  ctx?: AuditContext,
): Promise<ApplyLandedCostResult> {
  // ---- Input validation ----
  if (
    input.allocationMethod !== AllocationMethod.UNIT_COUNT &&
    input.allocationMethod !== AllocationMethod.VALUE
  ) {
    throw new Error(
      'applyLandedCostToReceipts: WEIGHT and BOX_COUNT allocation methods are deferred to a future slice. Use UNIT_COUNT or VALUE.',
    );
  }
  if (input.receiptIds.length === 0) {
    throw new Error('applyLandedCostToReceipts: receiptIds must be non-empty');
  }
  const totalLandedCost = toDecimal(input.totalLandedCost);
  if (totalLandedCost.lessThanOrEqualTo(0)) {
    throw new Error(
      `applyLandedCostToReceipts: totalLandedCost must be > 0 (got ${totalLandedCost.toString()})`,
    );
  }

  return db.$transaction(async (tx) => {
    // ---- Validate receipts exist, are POSTED, not soft-deleted ----
    const receipts = await tx.receipt.findMany({
      where: { id: { in: input.receiptIds } },
      select: { id: true, number: true, status: true, deletedAt: true },
    });
    const foundIds = new Set(receipts.map((r) => r.id));
    for (const id of input.receiptIds) {
      if (!foundIds.has(id)) {
        throw new Error(
          `applyLandedCostToReceipts: receipt not found: ${id}`,
        );
      }
    }
    for (const r of receipts) {
      if (r.deletedAt) {
        throw new Error(
          `applyLandedCostToReceipts: receipt is soft-deleted (id=${r.id} number=${r.number})`,
        );
      }
      if (r.status !== 'POSTED') {
        throw new Error(
          `applyLandedCostToReceipts: receipt is not POSTED (id=${r.id} number=${r.number} status=${r.status})`,
        );
      }
    }

    // ---- Gather all FifoLayers tied to these receipts via ReceiptLine ----
    const receiptLines = await tx.receiptLine.findMany({
      where: {
        receiptId: { in: input.receiptIds },
        deletedAt: null,
      },
      select: {
        id: true,
        fifoLayer: {
          select: {
            id: true,
            qtyReceived: true,
            unitCost: true,
            deletedAt: true,
          },
        },
      },
    });

    type LayerCtx = {
      id: string;
      qtyReceived: Prisma.Decimal;
      currentUnitCost: Prisma.Decimal;
      basis: Prisma.Decimal;
    };
    const layers: LayerCtx[] = [];
    for (const rl of receiptLines) {
      if (!rl.fifoLayer || rl.fifoLayer.deletedAt) continue;
      let basis: Prisma.Decimal;
      if (input.allocationMethod === AllocationMethod.UNIT_COUNT) {
        basis = rl.fifoLayer.qtyReceived;
      } else {
        // VALUE: extended cost = qty × unitCost
        basis = rl.fifoLayer.qtyReceived.times(rl.fifoLayer.unitCost);
      }
      layers.push({
        id: rl.fifoLayer.id,
        qtyReceived: rl.fifoLayer.qtyReceived,
        currentUnitCost: rl.fifoLayer.unitCost,
        basis,
      });
    }

    if (layers.length === 0) {
      throw new Error(
        'applyLandedCostToReceipts: no live FifoLayers found for the given receipts (all soft-deleted or missing)',
      );
    }

    let totalBasis = new Prisma.Decimal(0);
    for (const l of layers) totalBasis = totalBasis.plus(l.basis);
    if (totalBasis.lessThanOrEqualTo(0)) {
      throw new Error(
        `applyLandedCostToReceipts: cannot allocate to zero-basis layers (method=${input.allocationMethod} totalBasis=${totalBasis.toString()})`,
      );
    }

    // ---- Create the LandedCostAllocation header up-front so JE memos can
    //      reference its id. Receipt join rows next. ----
    const allocation = await tx.landedCostAllocation.create({
      data: {
        totalLandedCost,
        allocationMethod: input.allocationMethod,
        appliedById: ctx?.userId ?? null,
        notes: input.notes ?? null,
      },
    });
    for (const receiptId of input.receiptIds) {
      await tx.landedCostAllocationReceipt.create({
        data: { allocationId: allocation.id, receiptId },
      });
    }

    // ---- Per-layer apply pass ----
    const layersUpdated: LayerUpdateSummary[] = [];
    const cogsAdjustmentJeIds: string[] = [];

    // Sort layers by id for deterministic processing order. Allocation math
    // is additive over layers so order doesn't affect dollar correctness,
    // but stable order makes test assertions predictable and makes audit
    // log review tractable.
    layers.sort((a, b) => a.id.localeCompare(b.id));

    for (const layer of layers) {
      // Layer's share of the total dollar pool, then per-unit delta.
      const layerDelta = totalLandedCost.times(layer.basis).dividedBy(totalBasis);
      const deltaUnitCost = layerDelta.dividedBy(layer.qtyReceived);
      const deltaTotal = deltaUnitCost.times(layer.qtyReceived);
      const newUnitCost = layer.currentUnitCost.plus(deltaUnitCost);

      // Mutate layer.unitCost.
      await tx.fifoLayer.update({
        where: { id: layer.id },
        data: { unitCost: newUnitCost },
      });

      // Walk consumptions on this layer.
      const consumptions = await tx.fifoConsumption.findMany({
        where: { layerId: layer.id },
        select: { id: true, movementId: true, qty: true },
        orderBy: { id: 'asc' },
      });

      // Per-(invoice, warehouse) aggregator for COGS adjustment JE lines.
      type InvoiceAggKey = string; // `${invoiceId}:${warehouseId}`
      type InvoiceAggValue = {
        invoiceId: string;
        invoiceNumber: string;
        warehouseId: string;
        inventoryAccountCode: string;
        delta: Prisma.Decimal;
        // Earliest createdAt across all consumptions feeding this aggregator
        // — used as the JE postedAt. Multiple consumptions can flow into one
        // (invoice, warehouse) pair only when the same invoice consumed from
        // the same layer twice in different movements (rare but possible
        // across multi-line invoices targeting the same bin). Earliest is
        // the conservative period choice.
        postedAt: Date;
      };
      const invoiceAgg = new Map<InvoiceAggKey, InvoiceAggValue>();

      let mutatedInPlace = 0;
      let adjustedViaJe = 0;
      let orphanCount = 0;

      for (const c of consumptions) {
        const chain = await walkConsumptionChain(tx, c.movementId);
        if (chain === null) {
          // Orphan CONSUME — manual adjustment / transfer. Layer cost still
          // mutates (already done above); no JE, no snapshot mutation.
          orphanCount += 1;
          continue;
        }

        if (!chain.invoice || !chain.invoiceCogsPosted) {
          // GL hasn't realized this consume yet. Mutate the snapshot in place
          // so the eventual cogsPosting run uses the new layer cost.
          await tx.fifoConsumption.update({
            where: { id: c.id },
            data: { unitCost: newUnitCost },
          });
          mutatedInPlace += 1;
          continue;
        }

        // Realized consume → schedule a backdated COGS adjustment JE.
        if (!chain.warehouseInventoryAccountCode) {
          throw new Error(
            `applyLandedCostToReceipts: warehouse ${chain.warehouseId} has no inventoryAccount linked — cannot post COGS adjustment for invoice ${chain.invoice.number}`,
          );
        }
        const adjustment = c.qty.times(deltaUnitCost);
        const key = `${chain.invoice.id}:${chain.warehouseId}`;
        const existing = invoiceAgg.get(key);
        if (existing) {
          existing.delta = existing.delta.plus(adjustment);
          if (chain.originalSaleDate < existing.postedAt) {
            existing.postedAt = chain.originalSaleDate;
          }
        } else {
          invoiceAgg.set(key, {
            invoiceId: chain.invoice.id,
            invoiceNumber: chain.invoice.number,
            warehouseId: chain.warehouseId,
            inventoryAccountCode: chain.warehouseInventoryAccountCode,
            delta: adjustment,
            postedAt: chain.originalSaleDate,
          });
        }
        adjustedViaJe += 1;
      }

      // Post one COGS adjustment JE per (invoice, warehouse) pair touched
      // by this layer. JE shape: forward (positive delta) DR COGS / CR
      // Inventory; if delta were negative (e.g., negative landed cost
      // correction in a future slice) we'd flip — but the migration's
      // CHECK ensures totalLandedCost > 0, so delta sign here is always
      // non-negative. Skip zero-delta defensively.
      // For Part 4 we record only ONE cogsAdjustmentJeId per
      // LandedCostAllocationLine (= per layer). When a layer touches
      // multiple (invoice, warehouse) pairs we record the FIRST JE id
      // by (invoiceNumber asc, warehouseId asc) — sufficient for audit
      // drill-down because all sibling JEs share the allocationId in
      // their description and entityType='Invoice'. A query like
      //   SELECT * FROM JournalEntry
      //   WHERE description LIKE 'Late landed cost adjustment%' || :allocationId
      // returns them all.
      const orderedAggs = Array.from(invoiceAgg.values()).sort((a, b) => {
        const cmp = a.invoiceNumber.localeCompare(b.invoiceNumber);
        return cmp !== 0 ? cmp : a.warehouseId.localeCompare(b.warehouseId);
      });
      let firstJeId: string | null = null;
      for (const agg of orderedAggs) {
        if (agg.delta.lessThanOrEqualTo(0)) continue;
        const je = await post(tx, {
          entityType: 'Invoice',
          entityId: agg.invoiceId,
          description: `Late landed cost adjustment for invoice ${agg.invoiceNumber}: allocation ${allocation.id}`,
          postedAt: agg.postedAt,
          lines: [
            {
              accountCode: COGS_ACCOUNT,
              debit: agg.delta,
              memo: `COGS adjustment — invoice ${agg.invoiceNumber} (allocation ${allocation.id})`,
            },
            {
              accountCode: agg.inventoryAccountCode,
              credit: agg.delta,
              memo: `Inventory landed-cost increment — invoice ${agg.invoiceNumber} (allocation ${allocation.id})`,
            },
          ],
        });
        cogsAdjustmentJeIds.push(je.id);
        if (!firstJeId) firstJeId = je.id;
      }

      // Write the per-layer LandedCostAllocationLine row.
      await tx.landedCostAllocationLine.create({
        data: {
          allocationId: allocation.id,
          fifoLayerId: layer.id,
          deltaUnitCost,
          deltaTotal,
          originalUnitCost: layer.currentUnitCost,
          cogsAdjustmentJeId: firstJeId,
        },
      });

      layersUpdated.push({
        fifoLayerId: layer.id,
        originalUnitCost: layer.currentUnitCost,
        newUnitCost,
        deltaUnitCost,
        deltaTotal,
        cogsAdjustmentJeId: firstJeId,
        consumptionsMutatedInPlace: mutatedInPlace,
        consumptionsAdjustedViaJe: adjustedViaJe,
        orphanConsumes: orphanCount,
      });
    }

    // ---- Audit + return ----
    await audit(tx, {
      action: AuditAction.CREATE,
      entityType: 'LandedCostAllocation',
      entityId: allocation.id,
      after: {
        allocationId: allocation.id,
        totalLandedCost: totalLandedCost.toString(),
        allocationMethod: input.allocationMethod,
        receiptIds: input.receiptIds,
        layersUpdated: layersUpdated.length,
        cogsAdjustmentJeIds,
      },
      ctx,
    });

    return {
      allocationId: allocation.id,
      layersUpdated,
      cogsAdjustmentJeIds,
      totalAllocated: totalLandedCost,
    };
  });
}

export async function reverseLandedCostAllocation(
  db: PrismaClient,
  input: ReverseLandedCostInput,
  ctx?: AuditContext,
): Promise<ReverseLandedCostResult> {
  return db.$transaction(async (tx) => {
    const allocation = await tx.landedCostAllocation.findUnique({
      where: { id: input.allocationId },
      select: {
        id: true,
        reversedAt: true,
        deletedAt: true,
      },
    });
    if (!allocation) {
      throw new Error(
        `reverseLandedCostAllocation: allocation not found: ${input.allocationId}`,
      );
    }
    if (allocation.deletedAt) {
      throw new Error(
        `reverseLandedCostAllocation: allocation is soft-deleted (id=${input.allocationId})`,
      );
    }
    if (allocation.reversedAt) {
      // Idempotent re-call.
      return { skipped: 'already_reversed', reversalJeIds: [], layersRestored: 0 };
    }

    // Read all lines for this allocation. Order by id for deterministic
    // processing (same as the apply pass).
    const lines = await tx.landedCostAllocationLine.findMany({
      where: { allocationId: allocation.id },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        fifoLayerId: true,
        deltaUnitCost: true,
        originalUnitCost: true,
        cogsAdjustmentJeId: true,
      },
    });

    const reversalJeIds: string[] = [];
    let layersRestored = 0;

    for (const line of lines) {
      // Restore layer.unitCost from the snapshot. Source-of-truth approach
      // (NOT subtract deltaUnitCost) so any other allocations that stacked
      // on top of this one are reverted in the same step — at the cost of
      // those other allocations' deltas being undone too. Operator policy
      // in Part 4 is "reverse-then-reapply" — operator reverses the latest
      // allocation, then reapplies any others that should remain.
      // (Linear stacking in pilot scope; multi-allocation interleaving
      // semantics are a deferred concern.)
      await tx.fifoLayer.update({
        where: { id: line.fifoLayerId },
        data: { unitCost: line.originalUnitCost },
      });
      layersRestored += 1;

      // Walk consumptions on this layer to find every (invoice, warehouse)
      // pair that received a forward COGS adjustment JE for this allocation.
      // Mirror-sign reversal: DR Inventory / CR COGS at the same postedAt.
      // Symmetric query to the apply pass — if forward path mutated a
      // consumption.unitCost in place (not yet cogsPosted), the reverse
      // path also mutates it back via in-place update; if forward path
      // posted a JE, the reverse path posts a mirror JE.
      const consumptions = await tx.fifoConsumption.findMany({
        where: { layerId: line.fifoLayerId },
        select: { id: true, movementId: true, qty: true },
        orderBy: { id: 'asc' },
      });

      type RevAggValue = {
        invoiceId: string;
        invoiceNumber: string;
        warehouseId: string;
        inventoryAccountCode: string;
        delta: Prisma.Decimal;
        postedAt: Date;
      };
      const revAgg = new Map<string, RevAggValue>();

      // Snapshot vs. JE asymmetry in reverse path:
      //   - If cogsPosted=false at reverse time (and was false at forward time
      //     too), forward mutated the snapshot in place; reverse restores it.
      //   - If cogsPosted=true at reverse time (whether it was true at forward
      //     time or became true between forward and reverse via cogsPosting):
      //     the snapshot represents what cogsPosting actually used to compute
      //     GL COGS. We do NOT revert the snapshot — it's a permanent record
      //     of "the cost at GL realization." The reverse JE captures the
      //     differential separately (DR Inventory / CR COGS). Snapshot stays
      //     post-allocation; GL is reverted to pre-allocation via the JE.
      //   - This means a forward LandedCostAllocationLine might have
      //     cogsAdjustmentJeId=null (because at forward time the consume
      //     wasn't realized) but the reverse path still posts a JE (because
      //     cogsPosting realized the consume between forward and reverse).
      //     The reverse JE is findable via the description LIKE query.
      for (const c of consumptions) {
        const chain = await walkConsumptionChain(tx, c.movementId);
        if (chain === null) continue; // orphan — never had a JE in forward path
        if (!chain.invoice || !chain.invoiceCogsPosted) {
          // Forward path mutated the snapshot in place; reverse the snapshot
          // back. Use originalUnitCost (the layer's pre-allocation cost) to
          // restore. NOTE: this is exact only when no OTHER allocation was
          // applied between this allocation and the reversal. Operator
          // policy "reverse-then-reapply" is the contract that keeps this
          // exact in pilot scope.
          await tx.fifoConsumption.update({
            where: { id: c.id },
            data: { unitCost: line.originalUnitCost },
          });
          continue;
        }
        if (!chain.warehouseInventoryAccountCode) {
          throw new Error(
            `reverseLandedCostAllocation: warehouse ${chain.warehouseId} has no inventoryAccount linked — cannot reverse COGS adjustment for invoice ${chain.invoice.number}`,
          );
        }
        const adjustment = c.qty.times(line.deltaUnitCost);
        const key = `${chain.invoice.id}:${chain.warehouseId}`;
        const existing = revAgg.get(key);
        if (existing) {
          existing.delta = existing.delta.plus(adjustment);
          if (chain.originalSaleDate < existing.postedAt) {
            existing.postedAt = chain.originalSaleDate;
          }
        } else {
          revAgg.set(key, {
            invoiceId: chain.invoice.id,
            invoiceNumber: chain.invoice.number,
            warehouseId: chain.warehouseId,
            inventoryAccountCode: chain.warehouseInventoryAccountCode,
            delta: adjustment,
            postedAt: chain.originalSaleDate,
          });
        }
      }

      const orderedRev = Array.from(revAgg.values()).sort((a, b) => {
        const cmp = a.invoiceNumber.localeCompare(b.invoiceNumber);
        return cmp !== 0 ? cmp : a.warehouseId.localeCompare(b.warehouseId);
      });
      for (const agg of orderedRev) {
        if (agg.delta.lessThanOrEqualTo(0)) continue;
        const je = await post(tx, {
          entityType: 'Invoice',
          entityId: agg.invoiceId,
          description: `Reverse late landed cost adjustment for invoice ${agg.invoiceNumber}: allocation ${allocation.id}`,
          postedAt: agg.postedAt,
          lines: [
            {
              accountCode: agg.inventoryAccountCode,
              debit: agg.delta,
              memo: `Inventory landed-cost reversal — invoice ${agg.invoiceNumber} (allocation ${allocation.id})`,
            },
            {
              accountCode: COGS_ACCOUNT,
              credit: agg.delta,
              memo: `COGS adjustment reversal — invoice ${agg.invoiceNumber} (allocation ${allocation.id})`,
            },
          ],
        });
        reversalJeIds.push(je.id);
      }
    }

    await tx.landedCostAllocation.update({
      where: { id: allocation.id },
      data: {
        reversedAt: new Date(),
        reversedReason: input.reason,
      },
    });

    await audit(tx, {
      action: AuditAction.UPDATE,
      entityType: 'LandedCostAllocation',
      entityId: allocation.id,
      before: { reversedAt: null },
      after: {
        reversedAt: new Date().toISOString(),
        reversedReason: input.reason,
        reversalJeIds,
        layersRestored,
      },
      ctx,
    });

    return { skipped: null, reversalJeIds, layersRestored };
  });
}
