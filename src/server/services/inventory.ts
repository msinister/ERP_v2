import { AuditAction, Prisma } from '@/generated/tenant';
import type { PrismaClient, InventoryItem } from '@/generated/tenant';
import { audit, type AuditContext } from '@/lib/audit/audit';
  // Read-only in this slice. Movement APIs (receive, consume, adjust)
  // land with the costing engine.

  export async function getInventory(
    db: PrismaClient,
    variantId: string,
    warehouseId: string,
  ): Promise<InventoryItem | null> {
    return db.inventoryItem.findUnique({
      where: { variantId_warehouseId: { variantId, warehouseId } },
    });
  }

  export async function listInventoryByVariant(
    db: PrismaClient,
    variantId: string,
  ): Promise<InventoryItem[]> {
    return db.inventoryItem.findMany({
      where: { variantId },
      orderBy: { warehouseId: 'asc' },
    });
  }

  export async function listInventoryByWarehouse(
    db: PrismaClient,
    warehouseId: string,
    opts: { skip?: number; take?: number } = {},
  ): Promise<InventoryItem[]> {
    const { skip = 0, take = 100 } = opts;
    return db.inventoryItem.findMany({
      where: { warehouseId },
      skip,
      take,
      orderBy: { variantId: 'asc' },
    });
  }

export type LineEntryStock = {
  onHand: Prisma.Decimal;
  reserved: Prisma.Decimal;
  available: Prisma.Decimal;
};

/**
 * Compact stock snapshot for the SO line-entry GUI. Returns onHand,
 * reserved, and the derived available = onHand − reserved. When no
 * InventoryItem row exists for the bin (never received), all three
 * are zero. available is clamped to >= 0 so a transient negative
 * (negative-inventory-allowed tenants) doesn't surface as a
 * negative-Available render.
 */
export async function getLineEntryStock(
  db: PrismaClient,
  variantId: string,
  warehouseId: string,
): Promise<LineEntryStock> {
  const row = await db.inventoryItem.findUnique({
    where: { variantId_warehouseId: { variantId, warehouseId } },
    select: { onHand: true, reserved: true },
  });
  const zero = new Prisma.Decimal(0);
  const onHand = row?.onHand ?? zero;
  const reserved = row?.reserved ?? zero;
  const rawAvail = onHand.minus(reserved);
  const available = rawAvail.lessThan(0) ? zero : rawAvail;
  return { onHand, reserved, available };
}

/**
 * Set (or clear) the free-text bin location on an InventoryItem. No
 * inventory impact — operator-maintained location label. Empty/blank
 * input clears it to null. Audited as an UPDATE.
 */
export async function updateInventoryBin(
  db: PrismaClient,
  inventoryItemId: string,
  binLocation: string | null,
  ctx?: AuditContext,
): Promise<InventoryItem> {
  const normalized =
    binLocation == null || binLocation.trim() === '' ? null : binLocation.trim();
  return db.$transaction(async (tx) => {
    const before = await tx.inventoryItem.findUnique({
      where: { id: inventoryItemId },
    });
    if (!before) throw new Error(`InventoryItem not found: ${inventoryItemId}`);
    const after = await tx.inventoryItem.update({
      where: { id: inventoryItemId },
      data: { binLocation: normalized },
    });
    await audit(tx, {
      action: AuditAction.UPDATE,
      entityType: 'InventoryItem',
      entityId: inventoryItemId,
      before: { binLocation: before.binLocation },
      after: { binLocation: after.binLocation },
      ctx,
    });
    return after;
  });
}
