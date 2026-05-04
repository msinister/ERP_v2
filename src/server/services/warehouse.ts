import { AuditAction } from '@/generated/tenant';
import type { PrismaClient, Warehouse } from '@/generated/tenant';
import { audit, type AuditContext } from '@/lib/audit/audit';
import {
  warehouseCreateSchema,
  warehouseUpdateSchema,
  type WarehouseCreateInput,
  type WarehouseUpdateInput,
} from '@/lib/validation/product';

// TODO: wire requirePermission() once lib/permissions exists

export async function createWarehouse(
  db: PrismaClient,
  input: WarehouseCreateInput,
  ctx?: AuditContext,
): Promise<Warehouse> {
  const data = warehouseCreateSchema.parse(input);
  return db.$transaction(async (tx) => {
    const warehouse = await tx.warehouse.create({ data });
    await audit(tx, {
      action: AuditAction.CREATE,
      entityType: 'Warehouse',
      entityId: warehouse.id,
      after: warehouse,
      ctx,
    });
    return warehouse;
  });
}

export async function updateWarehouse(
  db: PrismaClient,
  id: string,
  input: WarehouseUpdateInput,
  ctx?: AuditContext,
): Promise<Warehouse> {
  const data = warehouseUpdateSchema.parse(input);
  return db.$transaction(async (tx) => {
    const before = await tx.warehouse.findUnique({ where: { id } });
    if (!before) throw new Error(`Warehouse not found: ${id}`);
    const after = await tx.warehouse.update({ where: { id }, data });
    await audit(tx, {
      action: AuditAction.UPDATE,
      entityType: 'Warehouse',
      entityId: id,
      before,
      after,
      ctx,
    });
    return after;
  });
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
  ctx?: AuditContext,
): Promise<Warehouse> {
  return db.$transaction(async (tx) => {
    const before = await tx.warehouse.findUnique({ where: { id } });
    if (!before) throw new Error(`Warehouse not found: ${id}`);
    const after = await tx.warehouse.update({
      where: { id },
      data: { deletedAt: new Date(), active: false },
    });
    await audit(tx, {
      action: AuditAction.DELETE,
      entityType: 'Warehouse',
      entityId: id,
      before,
      after,
      ctx,
    });
    return after;
  });
}
