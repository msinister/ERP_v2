import { Prisma } from '@/generated/tenant';
import type { PrismaClient, InventoryItem } from '@/generated/tenant';
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
