import { Prisma, AuditAction, InventoryMovementType } from '@/generated/tenant';
import type { InventoryMovement, PrismaClient } from '@/generated/tenant';
import { createHash, randomUUID } from 'node:crypto';
import { audit, type AuditContext } from '@/lib/audit/audit';
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

// Hash a string to a signed 32-bit int suitable for the (int4, int4) form of
// pg_advisory_xact_lock. We use the two-int form so the lock key is the pair
// (variantId, warehouseId) rather than a single bigint, which makes lock
// contention map cleanly to the per-bin granularity we want.
function lockKey(s: string): number {
  return createHash('sha256').update(s).digest().readInt32BE(0);
}

async function lockBin(
  tx: Prisma.TransactionClient,
  variantId: string,
  warehouseId: string,
): Promise<void> {
  const v = lockKey(variantId);
  const w = lockKey(warehouseId);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${v}::int4, ${w}::int4)`;
}

// For transfers we lock two bins in deterministic order to avoid deadlocks
// between simultaneous A→B and B→A transfers of the same variant.
async function lockBinsOrdered(
  tx: Prisma.TransactionClient,
  variantId: string,
  warehouseA: string,
  warehouseB: string,
): Promise<void> {
  const [first, second] = [warehouseA, warehouseB].sort();
  await lockBin(tx, variantId, first);
  await lockBin(tx, variantId, second);
}

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
  if (onHand.lessThan(qty)) {
    throw new Error(
      `Insufficient stock: onHand=${onHand.toString()} requested=${qty.toString()}`,
    );
  }

  const movement = await tx.inventoryMovement.create({
    data: {
      variantId: data.variantId,
      warehouseId: data.warehouseId,
      type: InventoryMovementType.CONSUME,
      qty: qty.negated(),
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
