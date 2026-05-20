import {
  AdjustmentStatus,
  AuditAction,
  InventoryMovementType,
  Prisma,
} from '@/generated/tenant';
import type {
  InventoryAdjustment,
  InventoryAdjustmentLine,
  PrismaClient,
} from '@/generated/tenant';
import { audit, type AuditContext } from '@/lib/audit/audit';
import { post } from '@/lib/gl/post';
import { lockBin } from '@/server/services/locks';
import { consumeFromLayersTx } from '@/server/services/fifoLayers';
import { createFifoLayerForReturnTx } from '@/server/services/fifoLayers';
import { getNegativeInventoryAllowed } from '@/server/services/negativeInventory';
import { recomputeOnHand } from '@/server/services/movements';
import { computeWac, getLastPurchaseCost } from '@/server/services/wac';
import { getNextSequence } from '@/lib/sequences/sequences';
import {
  quickAdjustmentInputSchema,
  voidAdjustmentInputSchema,
  type QuickAdjustmentInput,
  type VoidAdjustmentInput,
} from '@/lib/validation/inventoryAdjustments';

// =============================================================================
// Inventory adjustments — costing-correct shrink/gain.
//
//   Loss (qtyChange < 0): consumes oldest FIFO layers (same engine as sales)
//     → movement.unitCost = consumed WAC. JE: DR 5200 / CR <wh inventory>.
//   Gain (qtyChange > 0): creates a NEW FIFO layer at WAC (fallback last
//     cost, then 0). JE: DR <wh inventory> / CR 5200.
//
// Void = compensating reversal: each line's opposite is applied. A voided
// LOSS re-adds the qty as a new layer at the originally-consumed cost; a
// voided GAIN consumes the qty back out (FIFO). Originals are never mutated.
//
// JEs post under entityType 'InventoryAdjustment' / entityId = adjustment.id
// so the detail page + reports can find every leg. Amount-zero legs (no cost
// basis) skip post() — post() rejects a leg with both sides zero.
// =============================================================================

const ADJUSTMENT_EXPENSE_ACCOUNT = '5200';
const SEQUENCE_NAME = 'inventory-adjustment';
const SEQUENCE_PREFIX = 'ADJ';

export type InventoryAdjustmentWithLines = InventoryAdjustment & {
  lines: InventoryAdjustmentLine[];
};

// ---------------------------------------------------------------------------
// Per-line apply — the costing core. Composes the FIFO primitives + JE.
// ---------------------------------------------------------------------------

type ApplyLineParams = {
  adjustmentId: string;
  reference: string; // adjustment number (movement breadcrumb)
  warehouseId: string;
  variantId: string;
  qtyChange: Prisma.Decimal; // signed, non-zero
  inventoryAccountCode: string;
  variantSku: string;
  warehouseCode: string;
  notes: string | null;
  // For void-of-loss: create the gain layer at the originally-consumed
  // cost instead of recomputing WAC.
  gainUnitCostOverride?: Prisma.Decimal | null;
  ctx?: AuditContext;
};

async function applyAdjustmentLineTx(
  tx: Prisma.TransactionClient,
  p: ApplyLineParams,
): Promise<{ unitCost: Prisma.Decimal }> {
  const zero = new Prisma.Decimal(0);
  await lockBin(tx, p.variantId, p.warehouseId);

  if (p.qtyChange.greaterThan(0)) {
    // ---- GAIN ----------------------------------------------------------
    const qty = p.qtyChange;
    let unitCost: Prisma.Decimal;
    if (p.gainUnitCostOverride != null) {
      unitCost = p.gainUnitCostOverride;
    } else {
      unitCost =
        (await computeWac(tx, p.variantId, p.warehouseId)) ??
        (await getLastPurchaseCost(tx, p.variantId, p.warehouseId)) ??
        zero;
    }

    const movement = await tx.inventoryMovement.create({
      data: {
        variantId: p.variantId,
        warehouseId: p.warehouseId,
        type: InventoryMovementType.ADJUST,
        qty,
        unitCost,
        reference: p.reference,
        notes: p.notes,
        createdById: p.ctx?.userId ?? null,
      },
    });
    await createFifoLayerForReturnTx(
      tx,
      {
        variantId: p.variantId,
        warehouseId: p.warehouseId,
        qty,
        unitCost,
        returnDate: new Date(),
        sourceMovementId: movement.id,
      },
      p.ctx,
    );
    await recomputeOnHand(tx, p.variantId, p.warehouseId);

    const amount = qty.times(unitCost);
    if (amount.greaterThan(0)) {
      await post(tx, {
        entityType: 'InventoryAdjustment',
        entityId: p.adjustmentId,
        description: `Inventory gain — ${p.variantSku} at ${p.warehouseCode}`,
        lines: [
          {
            accountCode: p.inventoryAccountCode,
            debit: amount,
            memo: `Inventory restored — ${p.variantSku} at ${p.warehouseCode}`,
          },
          {
            accountCode: ADJUSTMENT_EXPENSE_ACCOUNT,
            credit: amount,
            memo: `Gain adjustment — ${p.variantSku} at ${p.warehouseCode}`,
          },
        ],
      });
    }
    await audit(tx, {
      action: AuditAction.CREATE,
      entityType: 'InventoryMovement',
      entityId: movement.id,
      after: movement,
      ctx: p.ctx,
    });
    return { unitCost };
  }

  // ---- LOSS ------------------------------------------------------------
  const absQty = p.qtyChange.abs();
  const item = await tx.inventoryItem.findUnique({
    where: {
      variantId_warehouseId: {
        variantId: p.variantId,
        warehouseId: p.warehouseId,
      },
    },
    select: { onHand: true },
  });
  const onHand = item?.onHand ?? zero;

  // Movement first (FifoConsumption.movementId FK), placeholder cost.
  let movement = await tx.inventoryMovement.create({
    data: {
      variantId: p.variantId,
      warehouseId: p.warehouseId,
      type: InventoryMovementType.ADJUST,
      qty: p.qtyChange, // negative
      unitCost: null,
      negativeAllocation: false,
      reference: p.reference,
      notes: p.notes,
      createdById: p.ctx?.userId ?? null,
    },
  });

  const layerResult = await consumeFromLayersTx(tx, {
    variantId: p.variantId,
    warehouseId: p.warehouseId,
    qty: absQty,
    movementId: movement.id,
  });
  const noLayers = layerResult.consumptions.length === 0;

  let unitCost = zero;
  if (layerResult.fullyAllocated) {
    unitCost = layerResult.weightedAverageCost ?? zero;
    movement = await tx.inventoryMovement.update({
      where: { id: movement.id },
      data: { unitCost },
    });
  } else if (noLayers && onHand.greaterThanOrEqualTo(absQty)) {
    // On-hand covers it but no FIFO layers exist (test-seeded stock).
    // No cost basis → unitCost stays 0 / movement.unitCost null.
  } else {
    const negAllowed = await getNegativeInventoryAllowed(tx);
    if (!negAllowed) {
      throw new Error(
        `Insufficient stock to remove ${absQty.toString()} of ${p.variantSku} at ${p.warehouseCode} (on hand ${onHand.toString()})`,
      );
    }
    movement = await tx.inventoryMovement.update({
      where: { id: movement.id },
      data: { negativeAllocation: true },
    });
  }

  await recomputeOnHand(tx, p.variantId, p.warehouseId);

  const amount = absQty.times(unitCost);
  if (amount.greaterThan(0)) {
    await post(tx, {
      entityType: 'InventoryAdjustment',
      entityId: p.adjustmentId,
      description: `Inventory loss — ${p.variantSku} at ${p.warehouseCode}`,
      lines: [
        {
          accountCode: ADJUSTMENT_EXPENSE_ACCOUNT,
          debit: amount,
          memo: `Loss adjustment — ${p.variantSku} at ${p.warehouseCode}`,
        },
        {
          accountCode: p.inventoryAccountCode,
          credit: amount,
          memo: `Inventory relief — ${p.variantSku} at ${p.warehouseCode}`,
        },
      ],
    });
  }
  await audit(tx, {
    action: AuditAction.CREATE,
    entityType: 'InventoryMovement',
    entityId: movement.id,
    after: movement,
    ctx: p.ctx,
  });
  return { unitCost };
}

// ---------------------------------------------------------------------------
// postQuickAdjustment — single-line, posts immediately.
// ---------------------------------------------------------------------------

export async function postQuickAdjustment(
  db: PrismaClient,
  input: QuickAdjustmentInput,
  ctx?: AuditContext,
): Promise<InventoryAdjustmentWithLines> {
  const data = quickAdjustmentInputSchema.parse(input);
  return db.$transaction(async (tx) => {
    const warehouse = await tx.warehouse.findUnique({
      where: { id: data.warehouseId },
      select: { code: true, inventoryAccount: { select: { code: true } } },
    });
    if (!warehouse) throw new Error(`Warehouse not found: ${data.warehouseId}`);
    if (!warehouse.inventoryAccount?.code) {
      throw new Error(
        `Warehouse '${warehouse.code}' has no inventory GL account — link one before posting adjustments`,
      );
    }
    const variant = await tx.productVariant.findUnique({
      where: { id: data.variantId },
      select: { sku: true },
    });
    if (!variant) throw new Error(`Variant not found: ${data.variantId}`);

    const seq = await getNextSequence(tx, {
      name: SEQUENCE_NAME,
      prefix: SEQUENCE_PREFIX,
      useYear: true,
    });

    const qtyChange = new Prisma.Decimal(data.qtyChange);
    const adjustment = await tx.inventoryAdjustment.create({
      data: {
        number: seq.formatted,
        warehouseId: data.warehouseId,
        adjustmentDate: data.adjustmentDate ?? new Date(),
        category: data.category,
        reason: data.reason,
        internalNotes: data.notes ?? null,
        status: AdjustmentStatus.POSTED,
        postedAt: new Date(),
        createdById: ctx?.userId ?? null,
      },
    });
    await audit(tx, {
      action: AuditAction.CREATE,
      entityType: 'InventoryAdjustment',
      entityId: adjustment.id,
      after: adjustment,
      ctx: { ...ctx, reason: data.reason },
    });

    const { unitCost } = await applyAdjustmentLineTx(tx, {
      adjustmentId: adjustment.id,
      reference: adjustment.number,
      warehouseId: data.warehouseId,
      variantId: data.variantId,
      qtyChange,
      inventoryAccountCode: warehouse.inventoryAccount.code,
      variantSku: variant.sku,
      warehouseCode: warehouse.code,
      notes: data.notes ?? null,
      ctx,
    });

    await tx.inventoryAdjustmentLine.create({
      data: {
        adjustmentId: adjustment.id,
        variantId: data.variantId,
        qtyChange,
        unitCost,
        notes: data.notes ?? null,
      },
    });

    return tx.inventoryAdjustment.findUniqueOrThrow({
      where: { id: adjustment.id },
      include: { lines: true },
    });
  });
}

// ---------------------------------------------------------------------------
// voidAdjustment — compensating reversal.
// ---------------------------------------------------------------------------

export async function voidAdjustment(
  db: PrismaClient,
  adjustmentId: string,
  input: VoidAdjustmentInput,
  ctx?: AuditContext,
): Promise<InventoryAdjustmentWithLines> {
  const data = voidAdjustmentInputSchema.parse(input);
  return db.$transaction(async (tx) => {
    const adj = await tx.inventoryAdjustment.findUnique({
      where: { id: adjustmentId },
      include: {
        lines: true,
        warehouse: {
          select: { code: true, inventoryAccount: { select: { code: true } } },
        },
      },
    });
    if (!adj) throw new Error(`Adjustment not found: ${adjustmentId}`);
    if (adj.deletedAt) throw new Error('Adjustment is deleted');
    if (adj.status !== AdjustmentStatus.POSTED) {
      throw new Error(
        `Only POSTED adjustments can be voided (status ${adj.status})`,
      );
    }
    if (!adj.warehouse.inventoryAccount?.code) {
      throw new Error(
        `Warehouse '${adj.warehouse.code}' has no inventory GL account`,
      );
    }
    const inventoryAccountCode = adj.warehouse.inventoryAccount.code;

    for (const line of adj.lines) {
      const variant = await tx.productVariant.findUnique({
        where: { id: line.variantId },
        select: { sku: true },
      });
      // Original LOSS (qtyChange < 0) → void re-adds at the consumed cost.
      // Original GAIN (qtyChange > 0) → void consumes back out (FIFO).
      const gainUnitCostOverride = line.qtyChange.lessThan(0)
        ? line.unitCost
        : null;
      await applyAdjustmentLineTx(tx, {
        adjustmentId: adj.id,
        reference: adj.number,
        warehouseId: adj.warehouseId,
        variantId: line.variantId,
        qtyChange: line.qtyChange.negated(),
        inventoryAccountCode,
        variantSku: variant?.sku ?? line.variantId,
        warehouseCode: adj.warehouse.code,
        notes: `Void of ${adj.number}`,
        gainUnitCostOverride,
        ctx,
      });
    }

    await tx.inventoryAdjustment.update({
      where: { id: adj.id },
      data: {
        status: AdjustmentStatus.VOIDED,
        voidedAt: new Date(),
        voidReason: data.reason,
      },
    });
    await audit(tx, {
      action: AuditAction.VOID,
      entityType: 'InventoryAdjustment',
      entityId: adj.id,
      before: { status: adj.status },
      after: { status: AdjustmentStatus.VOIDED },
      ctx: { ...ctx, reason: data.reason },
    });

    return tx.inventoryAdjustment.findUniqueOrThrow({
      where: { id: adj.id },
      include: { lines: true },
    });
  });
}
