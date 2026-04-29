import { Prisma, InventoryMovementType } from '@/generated/tenant';
import type { InventoryMovement, PrismaClient } from '@/generated/tenant';
import { randomUUID } from 'node:crypto';
import {
  adjustmentInputSchema,
  receiveInputSchema,
  consumeInputSchema,
  transferInputSchema,
  type AdjustmentInput,
  type ReceiveInput,
  type ConsumeInput,
  type TransferInput,
} from '@/lib/validation/inventory';

// TODO: Concurrency hardening — wrap onHand read-then-write paths with
// `isolationLevel: 'Serializable'` or a Postgres advisory lock keyed by
// (variantId, warehouseId). Without this, parallel CONSUMEs can both observe
// sufficient stock and leave onHand negative.

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

export async function createAdjustment(
  db: PrismaClient,
  input: AdjustmentInput,
): Promise<InventoryMovement> {
  const data = adjustmentInputSchema.parse(input);
  return db.$transaction(async (tx) => {
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
    return movement;
  });
}

export async function receiveInventory(
  db: PrismaClient,
  input: ReceiveInput,
): Promise<InventoryMovement> {
  const data = receiveInputSchema.parse(input);
  return db.$transaction(async (tx) => {
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
    return movement;
  });
}

export async function consumeInventory(
  db: PrismaClient,
  input: ConsumeInput,
): Promise<InventoryMovement> {
  const data = consumeInputSchema.parse(input);
  const qty = new Prisma.Decimal(data.qty);

  return db.$transaction(async (tx) => {
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
    return movement;
  });
}

export async function transferInventory(
  db: PrismaClient,
  input: TransferInput,
): Promise<{ out: InventoryMovement; in: InventoryMovement }> {
  const data = transferInputSchema.parse(input);
  const qty = new Prisma.Decimal(data.qty);
  const transferGroupId = randomUUID();

  return db.$transaction(async (tx) => {
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
    return { out, in: inMv };
  });
}
