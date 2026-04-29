import type { PrismaClient, Warehouse } from '@/generated/tenant';
  import {
    warehouseCreateSchema,                                                                                                                                                                                                                            warehouseUpdateSchema,
    type WarehouseCreateInput,
    type WarehouseUpdateInput,
  } from '@/lib/validation/product';

  // TODO: wire requirePermission() once lib/permissions exists
  // TODO: wire audit() once lib/audit exists

  export async function createWarehouse(
    db: PrismaClient,
    input: WarehouseCreateInput,
  ): Promise<Warehouse> {
    const data = warehouseCreateSchema.parse(input);
    return db.warehouse.create({ data });
  }

  export async function updateWarehouse(
    db: PrismaClient,
    id: string,
    input: WarehouseUpdateInput,
  ): Promise<Warehouse> {
    const data = warehouseUpdateSchema.parse(input);
    return db.warehouse.update({ where: { id }, data });
  }

  export async function getWarehouse(
    db: PrismaClient,
    id: string,
  ): Promise<Warehouse | null> {
    return db.warehouse.findFirst({ where: { id, deletedAt: null } });
  }

  export async function listWarehouses(
    db: PrismaClient,
    opts: { includeArchived?: boolean } = {},
  ): Promise<Warehouse[]> {
    const { includeArchived = false } = opts;
    return db.warehouse.findMany({
      where: includeArchived ? {} : { deletedAt: null },
      orderBy: { code: 'asc' },
    });
  }

  export async function archiveWarehouse(
    db: PrismaClient,
    id: string,
  ): Promise<Warehouse> {
    return db.warehouse.update({
      where: { id },
      data: { deletedAt: new Date(), active: false },
    });
  }
