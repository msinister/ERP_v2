import { AuditAction, Prisma } from '@/generated/tenant';
import type { PrismaClient } from '@/generated/tenant';
import { audit, type AuditContext } from '@/lib/audit/audit';

// =============================================================================
// FifoLayer backfill — Part 5 of the costing engine slice.
//
// Repairs RECEIVE InventoryMovement rows that don't have an associated
// FifoLayer. Two scenarios:
//   1. Pre-Phase-1A receives (predates the FIFO migration; movement.unitCost
//      is NULL because the column didn't exist when the row was inserted,
//      and no ReceiptLine link exists either).
//   2. Defensive: any future test fixture or environment-setup that creates
//      a RECEIVE without going through postReceipt would leave an orphan
//      that this script can repair.
//
// Per-movement transaction shape: each movement is processed in its own
// db.$transaction. A single bad movement doesn't roll back successful
// backfills earlier in the batch. Failures land in the structured result's
// `skipped` array with a reason. Fatal errors (connection drop, schema
// mismatch) propagate to the caller.
//
// Three recovery cases for cost data:
//   movement       — movement.unitCost IS NOT NULL → use directly
//   receipt_line   — movement.unitCost IS NULL but a ReceiptLine link
//                    exists → walk to ReceiptLine.unitCost +
//                    ReceiptLine.qtyReceived
//   override       — neither of the above; operator supplied an explicit
//                    unitCost via the overrides input map
//
// Skip reasons (4 values, all live):
//   irrecoverable_no_cost_data — case 3 with no override supplied. Includes
//                                a soft-deleted-ReceiptLine sub-detail when
//                                the cost-recovery walk fell through
//                                because the linked ReceiptLine is soft-
//                                deleted; operator can un-delete or supply
//                                an explicit override.
//   negative_qty               — RECEIVE with qty <= 0 (defensive; should
//                                never exist in practice)
//   untracked_consume_in_bin   — bin (variantId, warehouseId) has CONSUME
//                                movements with no FifoConsumption rows
//                                AND not negativeAllocation=true. Creating
//                                a layer here would mis-state the bin's
//                                qtyRemaining. Operator must clean up
//                                legacy consumes before re-running.
//   transaction_failed         — per-movement db.$transaction threw an
//                                unexpected error (FK violation, CHECK
//                                constraint violation, connection blip,
//                                etc.). The original error message is in
//                                the skip details for operator triage.
//                                Distinguished from irrecoverable_no_cost_
//                                data because the failure mode is different
//                                — the cost data was resolvable; the write
//                                failed.
// =============================================================================

export type BackfillSource = 'movement' | 'receipt_line' | 'override';

export type BackfillSkipReason =
  | 'irrecoverable_no_cost_data'
  | 'negative_qty'
  | 'untracked_consume_in_bin'
  | 'transaction_failed';

export type BackfillResult = {
  totalScanned: number;
  totalBackfilled: number;
  totalSkipped: number;
  totalAlreadyHasLayer: number;
  byCase: {
    fromMovement: number;
    fromReceiptLine: number;
    fromOverride: number;
  };
  skipped: Array<{
    movementId: string;
    reason: BackfillSkipReason;
    details?: string;
  }>;
  backfilled: Array<{
    movementId: string;
    layerId: string;
    qty: string;
    unitCost: string;
    source: BackfillSource;
  }>;
};

export type BackfillFifoLayersInput = {
  // Optional explicit-overrides map: movementId → unitCost. Used to
  // recover case-3 movements (no movement.unitCost, no ReceiptLine).
  // The unitCost value can be string / number / Decimal; coerced to
  // Prisma.Decimal at apply time.
  overrides?: Record<string, string | number | Prisma.Decimal>;
  // When true, validate + report what would be backfilled but make no
  // DB writes. Useful for operator preview before a real run.
  dryRun?: boolean;
  // When provided, restrict the scan to this set of movement IDs.
  // Empty / undefined means "scan all RECEIVE movements." Two intended
  // uses:
  //   1. Test scoping — TAG-prefixed fixtures pass their movement IDs
  //      so the suite operates without depending on global DB state.
  //   2. Production batch scoping — operator-controlled batches like
  //      "backfill only this CSV import's movements" or "backfill
  //      only the movements created during last night's data load."
  //      The CLI's --movement-ids flag (when added) feeds this.
  movementIds?: string[];
};

function toDecimal(v: string | number | Prisma.Decimal): Prisma.Decimal {
  if (v instanceof Prisma.Decimal) return v;
  return new Prisma.Decimal(v);
}

// Bin-key cache for the untracked-consume safety check. Detection cost
// is one query per bin touched by the scan; results are cached so a
// second orphan in the same bin doesn't re-query.
type BinKey = string; // `${variantId}:${warehouseId}`
function binKey(variantId: string, warehouseId: string): BinKey {
  return `${variantId}:${warehouseId}`;
}

async function binHasUntrackedConsume(
  db: PrismaClient,
  variantId: string,
  warehouseId: string,
  cache: Map<BinKey, { has: boolean; details?: string }>,
): Promise<{ has: boolean; details?: string }> {
  const key = binKey(variantId, warehouseId);
  const cached = cache.get(key);
  if (cached) return cached;

  // A CONSUME movement is "untracked" if:
  //   - it has zero FifoConsumption rows, AND
  //   - negativeAllocation is false (true CONSUME-on-empty-bin movements
  //     legitimately have zero consumption rows by design — see
  //     schema.prisma:294-297)
  const candidates = await db.inventoryMovement.findMany({
    where: {
      variantId,
      warehouseId,
      type: 'CONSUME',
      negativeAllocation: false,
      fifoConsumptions: { none: {} },
    },
    select: { id: true },
  });

  const result = candidates.length === 0
    ? { has: false }
    : {
        has: true,
        details: `bin (${variantId}, ${warehouseId}) has ${candidates.length} CONSUME movement(s) with no FifoConsumption rows: [${candidates.map((c) => c.id).join(', ')}]`,
      };
  cache.set(key, result);
  return result;
}

export async function backfillFifoLayers(
  db: PrismaClient,
  input: BackfillFifoLayersInput = {},
): Promise<BackfillResult> {
  const overrides = input.overrides ?? {};
  const dryRun = input.dryRun ?? false;

  // ---- Scan: find candidate orphan RECEIVE movements ----
  const scanWhere: Prisma.InventoryMovementWhereInput = {
    type: 'RECEIVE',
    fifoLayer: { is: null },
  };
  if (input.movementIds && input.movementIds.length > 0) {
    scanWhere.id = { in: input.movementIds };
  }

  // Use ascending createdAt order so deterministic test assertions and
  // operator review align with movement chronology.
  const orphans = await db.inventoryMovement.findMany({
    where: scanWhere,
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      variantId: true,
      warehouseId: true,
      qty: true,
      unitCost: true,
      createdAt: true,
      reference: true,
    },
  });

  // For "totalAlreadyHasLayer" we count RECEIVEs that DO have a layer,
  // scoped to the same movementIds filter when supplied. This gives the
  // operator a complete picture of the scan space.
  const alreadyHasLayerWhere: Prisma.InventoryMovementWhereInput = {
    type: 'RECEIVE',
    fifoLayer: { isNot: null },
  };
  if (input.movementIds && input.movementIds.length > 0) {
    alreadyHasLayerWhere.id = { in: input.movementIds };
  }
  const alreadyHasLayerCount = await db.inventoryMovement.count({
    where: alreadyHasLayerWhere,
  });

  const result: BackfillResult = {
    totalScanned: orphans.length,
    totalBackfilled: 0,
    totalSkipped: 0,
    totalAlreadyHasLayer: alreadyHasLayerCount,
    byCase: { fromMovement: 0, fromReceiptLine: 0, fromOverride: 0 },
    skipped: [],
    backfilled: [],
  };

  if (orphans.length === 0) return result;

  // ---- Per-movement processing loop ----
  const binCache = new Map<BinKey, { has: boolean; details?: string }>();

  for (const m of orphans) {
    // Defensive guards. The scan filter already excludes non-RECEIVE
    // movements, but the explicit-IDs path can pass arbitrary IDs.
    if (m.qty.lessThanOrEqualTo(0)) {
      result.skipped.push({
        movementId: m.id,
        reason: 'negative_qty',
        details: `qty=${m.qty.toString()}`,
      });
      result.totalSkipped += 1;
      continue;
    }

    // Untracked-consume safety check on the bin.
    const binCheck = await binHasUntrackedConsume(
      db,
      m.variantId,
      m.warehouseId,
      binCache,
    );
    if (binCheck.has) {
      result.skipped.push({
        movementId: m.id,
        reason: 'untracked_consume_in_bin',
        details: binCheck.details,
      });
      result.totalSkipped += 1;
      continue;
    }

    // Resolve cost source. Three cases in priority order:
    //   1. movement.unitCost not null → 'movement'
    //   2. ReceiptLine link → 'receipt_line'
    //   3. overrides[m.id] supplied → 'override'
    //   else → skip 'irrecoverable_no_cost_data'
    let source: BackfillSource;
    let unitCost: Prisma.Decimal;
    let qtyForLayer: Prisma.Decimal;
    let receivedDate: Date;
    let sourceReceiptLineId: string | null = null;

    if (m.unitCost != null) {
      source = 'movement';
      unitCost = m.unitCost;
      qtyForLayer = m.qty;
      receivedDate = m.createdAt;
      // Even when sourcing from movement, opportunistically link to
      // ReceiptLine if one exists — it makes future audit walks
      // (Receipt → Line → Layer) work without changing the data.
      const rl = await db.receiptLine.findUnique({
        where: { inventoryMovementId: m.id },
        select: { id: true, deletedAt: true },
      });
      if (rl && !rl.deletedAt) sourceReceiptLineId = rl.id;
    } else {
      // movement.unitCost IS NULL — try ReceiptLine walk.
      const rl = await db.receiptLine.findUnique({
        where: { inventoryMovementId: m.id },
        select: {
          id: true,
          qtyReceived: true,
          unitCost: true,
          deletedAt: true,
          receipt: { select: { receivedAt: true } },
        },
      });
      if (rl && !rl.deletedAt) {
        // Case 2: ReceiptLine present (regardless of parent Receipt
        // soft-delete state — see Q3 in design notes; backfill proceeds
        // because the inventory event is real ledger truth).
        source = 'receipt_line';
        unitCost = rl.unitCost;
        qtyForLayer = rl.qtyReceived;
        // Prefer Receipt.receivedAt if available (the business event
        // date), fall back to movement.createdAt (the system clock).
        receivedDate = rl.receipt?.receivedAt ?? m.createdAt;
        sourceReceiptLineId = rl.id;
      } else if (overrides[m.id] != null) {
        // Case 3 with override.
        source = 'override';
        unitCost = toDecimal(overrides[m.id]);
        qtyForLayer = m.qty;
        receivedDate = m.createdAt;
      } else {
        // Case 3 without override — irrecoverable. Surface the
        // actionable signal when the fall-through was specifically
        // because of a soft-deleted ReceiptLine: operator can un-delete
        // or supply an override.
        const skipDetails = rl && rl.deletedAt
          ? `unitCost=NULL, ReceiptLine ${rl.id} is soft-deleted (un-delete or supply override), no override supplied (reference='${m.reference ?? ''}')`
          : `unitCost=NULL, no ReceiptLine link, no override supplied (reference='${m.reference ?? ''}')`;
        result.skipped.push({
          movementId: m.id,
          reason: 'irrecoverable_no_cost_data',
          details: skipDetails,
        });
        result.totalSkipped += 1;
        continue;
      }
    }

    // Defensive: unitCost must be >= 0. The CHECK constraint at the DB
    // level catches this on insert, but a TS-level guard yields a
    // friendlier error message that includes the source case.
    if (unitCost.lessThan(0)) {
      result.skipped.push({
        movementId: m.id,
        reason: 'irrecoverable_no_cost_data',
        details: `negative unitCost ${unitCost.toString()} from source=${source}`,
      });
      result.totalSkipped += 1;
      continue;
    }

    // Dry-run: record what we would have done without writing.
    if (dryRun) {
      result.backfilled.push({
        movementId: m.id,
        layerId: '<dry-run>',
        qty: qtyForLayer.toString(),
        unitCost: unitCost.toString(),
        source,
      });
      result.totalBackfilled += 1;
      if (source === 'movement') result.byCase.fromMovement += 1;
      else if (source === 'receipt_line') result.byCase.fromReceiptLine += 1;
      else result.byCase.fromOverride += 1;
      continue;
    }

    // ---- Per-movement transaction: layer create + audit ----
    try {
      const layer = await db.$transaction(async (tx) => {
        const created = await tx.fifoLayer.create({
          data: {
            variantId: m.variantId,
            warehouseId: m.warehouseId,
            qtyReceived: qtyForLayer,
            qtyConsumed: new Prisma.Decimal(0),
            qtyRemaining: qtyForLayer,
            unitCost,
            receivedDate,
            sourceReceiptLineId,
            sourceMovementId: m.id,
          },
        });

        const ctx: AuditContext = {
          userId: null,
          reason: 'backfill-fifo-layers',
        };
        await audit(tx, {
          action: AuditAction.CREATE,
          entityType: 'FifoLayer',
          entityId: created.id,
          after: {
            ...created,
            backfillSource: source,
            backfillMovementId: m.id,
          },
          ctx,
        });

        return created;
      });

      result.backfilled.push({
        movementId: m.id,
        layerId: layer.id,
        qty: qtyForLayer.toString(),
        unitCost: unitCost.toString(),
        source,
      });
      result.totalBackfilled += 1;
      if (source === 'movement') result.byCase.fromMovement += 1;
      else if (source === 'receipt_line') result.byCase.fromReceiptLine += 1;
      else result.byCase.fromOverride += 1;
    } catch (e) {
      // Per-movement failure: record and continue. The cost data was
      // resolvable (we got past the case routing) but the write itself
      // failed — distinct from irrecoverable_no_cost_data. Common
      // causes: FK violation (variant or warehouse soft-deleted between
      // scan and write), CHECK constraint (qtyReceived > 0 fails on
      // boundary), connection blip. The original error message is
      // preserved in details for operator triage.
      const msg = e instanceof Error ? e.message : String(e);
      result.skipped.push({
        movementId: m.id,
        reason: 'transaction_failed',
        details: `transaction failed: ${msg}`,
      });
      result.totalSkipped += 1;
    }
  }

  return result;
}
