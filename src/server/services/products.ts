import { AuditAction } from '@/generated/tenant';
import type { PrismaClient, Product } from '@/generated/tenant';
import { audit, type AuditContext } from '@/lib/audit/audit';
import {
  productCreateSchema,
  productUpdateSchema,
  type ProductCreateInput,
  type ProductUpdateInput,
} from '@/lib/validation/product';

// TODO: wire requirePermission() once lib/permissions exists

export async function createProduct(
  db: PrismaClient,
  input: ProductCreateInput,
  ctx?: AuditContext,
): Promise<Product> {
  const data = productCreateSchema.parse(input);
  return db.$transaction(async (tx) => {
    const product = await tx.product.create({ data });
    await audit(tx, {
      action: AuditAction.CREATE,
      entityType: 'Product',
      entityId: product.id,
      after: product,
      ctx,
    });
    return product;
  });
}

export async function updateProduct(
  db: PrismaClient,
  id: string,
  input: ProductUpdateInput,
  ctx?: AuditContext,
): Promise<Product> {
  const data = productUpdateSchema.parse(input);
  return db.$transaction(async (tx) => {
    const before = await tx.product.findUnique({ where: { id } });
    if (!before) throw new Error(`Product not found: ${id}`);
    const after = await tx.product.update({ where: { id }, data });
    await audit(tx, {
      action: AuditAction.UPDATE,
      entityType: 'Product',
      entityId: id,
      before,
      after,
      ctx,
    });
    return after;
  });
}

export async function getProduct(
  db: PrismaClient,
  id: string,
): Promise<Product | null> {
  return db.product.findFirst({ where: { id, deletedAt: null } });
}

export async function getProductBySku(
  db: PrismaClient,
  sku: string,
): Promise<Product | null> {
  return db.product.findFirst({ where: { sku, deletedAt: null } });
}

export async function listProducts(
  db: PrismaClient,
  opts: { skip?: number; take?: number; includeArchived?: boolean } = {},
): Promise<Product[]> {
  const { skip = 0, take = 50, includeArchived = false } = opts;
  return db.product.findMany({
    where: includeArchived ? {} : { deletedAt: null },
    skip,
    take,
    orderBy: { createdAt: 'desc' },
  });
}

export async function archiveProduct(
  db: PrismaClient,
  id: string,
  ctx?: AuditContext,
): Promise<Product> {
  return db.$transaction(async (tx) => {
    const before = await tx.product.findUnique({ where: { id } });
    if (!before) throw new Error(`Product not found: ${id}`);
    const after = await tx.product.update({
      where: { id },
      data: { deletedAt: new Date(), active: false },
    });
    await audit(tx, {
      action: AuditAction.DELETE,
      entityType: 'Product',
      entityId: id,
      before,
      after,
      ctx,
    });
    return after;
  });
}
