import { AuditAction } from '@/generated/tenant';
import type { PrismaClient, ProductVariant } from '@/generated/tenant';
import { audit, type AuditContext } from '@/lib/audit/audit';
import {
  variantCreateSchema,
  variantUpdateSchema,
  type VariantCreateInput,
  type VariantUpdateInput,
} from '@/lib/validation/product';

// TODO: wire requirePermission() once lib/permissions exists

export async function createVariant(
  db: PrismaClient,
  input: VariantCreateInput,
  ctx?: AuditContext,
): Promise<ProductVariant> {
  const data = variantCreateSchema.parse(input);
  return db.$transaction(async (tx) => {
    const variant = await tx.productVariant.create({ data });
    await audit(tx, {
      action: AuditAction.CREATE,
      entityType: 'ProductVariant',
      entityId: variant.id,
      after: variant,
      ctx,
    });
    return variant;
  });
}

export async function updateVariant(
  db: PrismaClient,
  id: string,
  input: VariantUpdateInput,
  ctx?: AuditContext,
): Promise<ProductVariant> {
  const data = variantUpdateSchema.parse(input);
  return db.$transaction(async (tx) => {
    const before = await tx.productVariant.findUnique({ where: { id } });
    if (!before) throw new Error(`ProductVariant not found: ${id}`);
    const after = await tx.productVariant.update({ where: { id }, data });
    await audit(tx, {
      action: AuditAction.UPDATE,
      entityType: 'ProductVariant',
      entityId: id,
      before,
      after,
      ctx,
    });
    return after;
  });
}

export async function getVariant(
  db: PrismaClient,
  id: string,
): Promise<ProductVariant | null> {
  return db.productVariant.findFirst({ where: { id, deletedAt: null } });
}

export async function listVariantsForProduct(
  db: PrismaClient,
  productId: string,
  opts: { includeArchived?: boolean } = {},
): Promise<ProductVariant[]> {
  const { includeArchived = false } = opts;
  return db.productVariant.findMany({
    where: includeArchived ? { productId } : { productId, deletedAt: null },
    orderBy: { createdAt: 'asc' },
  });
}

export async function archiveVariant(
  db: PrismaClient,
  id: string,
  ctx?: AuditContext,
): Promise<ProductVariant> {
  return db.$transaction(async (tx) => {
    const before = await tx.productVariant.findUnique({ where: { id } });
    if (!before) throw new Error(`ProductVariant not found: ${id}`);
    const after = await tx.productVariant.update({
      where: { id },
      data: { deletedAt: new Date(), active: false },
    });
    await audit(tx, {
      action: AuditAction.DELETE,
      entityType: 'ProductVariant',
      entityId: id,
      before,
      after,
      ctx,
    });
    return after;
  });
}
