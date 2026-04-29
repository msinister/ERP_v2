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
