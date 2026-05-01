import { Prisma, AuditAction, InventoryMovementType } from '@/generated/tenant';
import type { InventoryMovement, PrismaClient } from '@/generated/tenant';
import { randomUUID } from 'node:crypto';
import { audit, type AuditContext } from '@/lib/audit/audit';
import { lockBin, lockBinsOrdered } from '@/server/services/locks';
import { consumeFromLayersTx } from '@/server/services/fifoLayers';
import { getNegativeInventoryAllowed } from '@/server/services/negativeInventory';
import {
  adjustmentInputSchema,
  receiveInputSchema,
  consumeInputSchema,
  transferInputSchema,
  reverseReceiveInputSchema,
  type AdjustmentInput,
  type ReceiveInput,
  type ConsumeInput,
  type TransferInput,
  type ReverseReceiveInput,
} from '@/lib/validation/inventory';

async function recomputeOnHand(
  tx: Prisma.TransactionClient,
  variantId: string,
  warehouseId: string,
): Promise<void> {
  const agg = await tx.inventoryMovement.aggregate({
    where: { variantId, warehouseId },
    _sum: { qty: true },
  });
  const onHand = agg._sum.qty ?? new Prisma.Decimal(0);

  await tx.inventoryItem.upsert({
    where: { variantId_warehouseId: { variantId, warehouseId } },
    create: { variantId, warehouseId, onHand },
    update: { onHand },
  });
}

// ---------------------------------------------------------------------------
// Tx variants — accept an existing Prisma.TransactionClient so callers (e.g.
// the receipts service) can compose a movement into their own transaction
// without nesting. The advisory lock + audit row commit atomically with the
// caller's other work.
// ---------------------------------------------------------------------------

export async function createAdjustmentTx(
  tx: Prisma.TransactionClient,
  input: AdjustmentInput,
  ctx?: AuditContext,
): Promise<InventoryMovement> {
  const data = adjustmentInputSchema.parse(input);
  await lockBin(tx, data.variantId, data.warehouseId);
  const movement = await tx.inventoryMovement.create({
    data: {
      variantId: data.variantId,
      warehouseId: data.warehouseId,
      type: InventoryMovementType.ADJUST,
      qty: new Prisma.Decimal(data.qty),
      reference: data.reference,
      notes: data.notes,
      createdById: data.createdById,
    },
  });
  await recomputeOnHand(tx, data.variantId, data.warehouseId);
  await audit(tx, {
    action: AuditAction.CREATE,
    entityType: 'InventoryMovement',
    entityId: movement.id,
    after: movement,
    ctx: {
      userId: ctx?.userId ?? data.createdById ?? null,
      ipAddress: ctx?.ipAddress,
      reason: ctx?.reason ?? data.notes ?? null,
    },
  });
  return movement;
}

export async function receiveInventoryTx(
  tx: Prisma.TransactionClient,
  input: ReceiveInput,
  ctx?: AuditContext,
): Promise<InventoryMovement> {
  const data = receiveInputSchema.parse(input);
  await lockBin(tx, data.variantId, data.warehouseId);
  const movement = await tx.inventoryMovement.create({
    data: {
      variantId: data.variantId,
      warehouseId: data.warehouseId,
      type: InventoryMovementType.RECEIVE,
      qty: new Prisma.Decimal(data.qty),
      reference: data.reference,
      notes: data.notes,
      createdById: data.createdById,
    },
  });
  await recomputeOnHand(tx, data.variantId, data.warehouseId);
  await audit(tx, {
    action: AuditAction.CREATE,
    entityType: 'InventoryMovement',
    entityId: movement.id,
    after: movement,
    ctx: {
      userId: ctx?.userId ?? data.createdById ?? null,
      ipAddress: ctx?.ipAddress,
      reason: ctx?.reason ?? null,
    },
  });
  return movement;
}

// Outcome-first CONSUME (Phase 1C). Walks FifoLayers oldest-first via
// consumeFromLayersTx, then branches:
//   covered_by_layers           — layers fully covered qty; movement.unitCost = WAC
//   covered_by_onhand_no_layers — no layers exist but onHand >= qty (option-A
//                                  back-compat for tests that seed via
//                                  receiveInventoryTx without going through
//                                  postReceipt); movement.unitCost = NULL
//   negative_allocation         — insufficient stock + neg-inv flag ON;
//                                  movement.unitCost = NULL, negativeAllocation=true
//   throw                       — insufficient stock + neg-inv flag OFF
//
// FK ordering: FifoConsumption.movementId is a non-deferred FK to
// InventoryMovement.id, so the movement row must exist BEFORE the layer
// walk inserts FifoConsumption rows. Mirrors postReceipt's create-movement-
// then-create-layer ordering. The movement is created with placeholder
// unitCost=null / negativeAllocation=false and then UPDATEd to the final
// values once the outcome is decided. A throw rolls the entire tx back —
// movement and any FifoConsumption / FifoLayer mutations vanish together.
type ConsumeOutcome =
  | 'covered_by_layers'
  | 'covered_by_onhand_no_layers'
  | 'negative_allocation'
  | 'throw';

export async function consumeInventoryTx(
  tx: Prisma.TransactionClient,
  input: ConsumeInput,
  ctx?: AuditContext,
): Promise<InventoryMovement> {
  const data = consumeInputSchema.parse(input);
  const qty = new Prisma.Decimal(data.qty);

  await lockBin(tx, data.variantId, data.warehouseId);

  const item = await tx.inventoryItem.findUnique({
    where: {
      variantId_warehouseId: {
        variantId: data.variantId,
        warehouseId: data.warehouseId,
      },
    },
  });
  const onHand = item?.onHand ?? new Prisma.Decimal(0);
  const onHandSufficient = onHand.greaterThanOrEqualTo(qty);

  // Step 1: create movement with placeholders. Satisfies the
  // FifoConsumption.movementId FK before the layer walk runs.
  let movement = await tx.inventoryMovement.create({
    data: {
      variantId: data.variantId,
      warehouseId: data.warehouseId,
      type: InventoryMovementType.CONSUME,
      qty: qty.negated(),
      unitCost: null,
      negativeAllocation: false,
      reference: data.reference,
      notes: data.notes,
      createdById: data.createdById,
    },
  });

  // Step 2: walk layers oldest-first. The FOR UPDATE inside
  // consumeFromLayersTx serializes against concurrent consumes / late-
  // landed-cost flows on the same bin.
  const layerResult = await consumeFromLayersTx(tx, {
    variantId: data.variantId,
    warehouseId: data.warehouseId,
    qty,
    movementId: movement.id,
  });
  const noLayers = layerResult.consumptions.length === 0;

  // Step 3: decide outcome.
  let outcome: ConsumeOutcome;
  if (layerResult.fullyAllocated) {
    outcome = 'covered_by_layers';
  } else if (noLayers && onHandSufficient) {
    outcome = 'covered_by_onhand_no_layers';
  } else {
    const negAllowed = await getNegativeInventoryAllowed(tx);
    outcome = negAllowed ? 'negative_allocation' : 'throw';
  }

  // Step 4: execute.
  switch (outcome) {
    case 'throw':
      throw new Error(
        `Insufficient stock for ${data.variantId} in ${data.warehouseId}: onHand=${onHand.toString()}, requested=${qty.toString()}`,
      );
    case 'covered_by_layers':
      movement = await tx.inventoryMovement.update({
        where: { id: movement.id },
        data: { unitCost: layerResult.weightedAverageCost },
      });
      break;
    case 'covered_by_onhand_no_layers':
      // Placeholder values are correct for this outcome — no update needed.
      break;
    case 'negative_allocation':
      movement = await tx.inventoryMovement.update({
        where: { id: movement.id },
        data: { negativeAllocation: true },
      });
      break;
  }

  await recomputeOnHand(tx, data.variantId, data.warehouseId);
  await audit(tx, {
    action: AuditAction.CREATE,
    entityType: 'InventoryMovement',
    entityId: movement.id,
    after: movement,
    ctx: {
      userId: ctx?.userId ?? data.createdById ?? null,
      ipAddress: ctx?.ipAddress,
      reason: ctx?.reason ?? null,
    },
  });
  return movement;
}

// reverseReceiveTx — reverses a previously-posted RECEIVE. Input qty is
// positive; the resulting movement has signed quantity = -qty and type
// RECEIVE_REVERSE so inventory adjustment reports stay separated from
// receipt cancellations and future GL posting can branch on type.
export async function reverseReceiveTx(
  tx: Prisma.TransactionClient,
  input: ReverseReceiveInput,
  ctx?: AuditContext,
): Promise<InventoryMovement> {
  const data = reverseReceiveInputSchema.parse(input);
  await lockBin(tx, data.variantId, data.warehouseId);
  const movement = await tx.inventoryMovement.create({
    data: {
      variantId: data.variantId,
      warehouseId: data.warehouseId,
      type: InventoryMovementType.RECEIVE_REVERSE,
      qty: new Prisma.Decimal(data.qty).negated(),
      reference: data.reference,
      notes: data.notes,
      createdById: data.createdById,
    },
  });
  await recomputeOnHand(tx, data.variantId, data.warehouseId);
  await audit(tx, {
    action: AuditAction.REVERSE,
    entityType: 'InventoryMovement',
    entityId: movement.id,
    after: movement,
    ctx: {
      userId: ctx?.userId ?? data.createdById ?? null,
      ipAddress: ctx?.ipAddress,
      reason: ctx?.reason ?? null,
    },
  });
  return movement;
}

export async function transferInventoryTx(
  tx: Prisma.TransactionClient,
  input: TransferInput,
  ctx?: AuditContext,
): Promise<{ out: InventoryMovement; in: InventoryMovement }> {
  const data = transferInputSchema.parse(input);
  const qty = new Prisma.Decimal(data.qty);
  const transferGroupId = randomUUID();

  await lockBinsOrdered(
    tx,
    data.variantId,
    data.fromWarehouseId,
    data.toWarehouseId,
  );

  const sourceItem = await tx.inventoryItem.findUnique({
    where: {
      variantId_warehouseId: {
        variantId: data.variantId,
        warehouseId: data.fromWarehouseId,
      },
    },
  });
  const sourceOnHand = sourceItem?.onHand ?? new Prisma.Decimal(0);
  if (sourceOnHand.lessThan(qty)) {
    throw new Error(
      `Insufficient stock at source warehouse: onHand=${sourceOnHand.toString()} requested=${qty.toString()}`,
    );
  }

  const out = await tx.inventoryMovement.create({
    data: {
      variantId: data.variantId,
      warehouseId: data.fromWarehouseId,
      type: InventoryMovementType.TRANSFER_OUT,
      qty: qty.negated(),
      transferGroupId,
      reference: data.reference,
      notes: data.notes,
      createdById: data.createdById,
    },
  });
  const inMv = await tx.inventoryMovement.create({
    data: {
      variantId: data.variantId,
      warehouseId: data.toWarehouseId,
      type: InventoryMovementType.TRANSFER_IN,
      qty,
      transferGroupId,
      reference: data.reference,
      notes: data.notes,
      createdById: data.createdById,
    },
  });

  await recomputeOnHand(tx, data.variantId, data.fromWarehouseId);
  await recomputeOnHand(tx, data.variantId, data.toWarehouseId);

  const auditCtx = {
    userId: ctx?.userId ?? data.createdById ?? null,
    ipAddress: ctx?.ipAddress,
    reason: ctx?.reason ?? null,
  };
  // Two audit rows — one per leg. Each afterJson carries the full movement
  // record (including transferGroupId), which is the linkage an investigator
  // uses to pivot to the paired leg.
  await audit(tx, {
    action: AuditAction.CREATE,
    entityType: 'InventoryMovement',
    entityId: out.id,
    after: out,
    ctx: auditCtx,
  });
  await audit(tx, {
    action: AuditAction.CREATE,
    entityType: 'InventoryMovement',
    entityId: inMv.id,
    after: inMv,
    ctx: auditCtx,
  });

  return { out, in: inMv };
}

// ---------------------------------------------------------------------------
// Public wrappers — open a transaction and delegate to the *Tx variant. These
// preserve the existing API for callers that aren't already inside a tx.
// ---------------------------------------------------------------------------

export async function createAdjustment(
  db: PrismaClient,
  input: AdjustmentInput,
  ctx?: AuditContext,
): Promise<InventoryMovement> {
  return db.$transaction((tx) => createAdjustmentTx(tx, input, ctx));
}

export async function receiveInventory(
  db: PrismaClient,
  input: ReceiveInput,
  ctx?: AuditContext,
): Promise<InventoryMovement> {
  return db.$transaction((tx) => receiveInventoryTx(tx, input, ctx));
}

export async function consumeInventory(
  db: PrismaClient,
  input: ConsumeInput,
  ctx?: AuditContext,
): Promise<InventoryMovement> {
  return db.$transaction((tx) => consumeInventoryTx(tx, input, ctx));
}

export async function transferInventory(
  db: PrismaClient,
  input: TransferInput,
  ctx?: AuditContext,
): Promise<{ out: InventoryMovement; in: InventoryMovement }> {
  return db.$transaction((tx) => transferInventoryTx(tx, input, ctx));
}

export async function reverseReceive(
  db: PrismaClient,
  input: ReverseReceiveInput,
  ctx?: AuditContext,
): Promise<InventoryMovement> {
  return db.$transaction((tx) => reverseReceiveTx(tx, input, ctx));
}
