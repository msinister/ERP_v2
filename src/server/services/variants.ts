import type { PrismaClient, ProductVariant } from '@/generated/tenant';                                                                                                                                                                           import {
    variantCreateSchema,
    variantUpdateSchema,
    type VariantCreateInput,
    type VariantUpdateInput,
  } from '@/lib/validation/product';

  // TODO: wire requirePermission() once lib/permissions exists
  // TODO: wire audit() once lib/audit exists

  export async function createVariant(
    db: PrismaClient,
    input: VariantCreateInput,
  ): Promise<ProductVariant> {
    const data = variantCreateSchema.parse(input);
    return db.productVariant.create({ data });
  }

  export async function updateVariant(
    db: PrismaClient,
    id: string,
    input: VariantUpdateInput,
  ): Promise<ProductVariant> {
    const data = variantUpdateSchema.parse(input);
    return db.productVariant.update({ where: { id }, data });
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
  ): Promise<ProductVariant> {
    return db.productVariant.update({
      where: { id },
      data: { deletedAt: new Date(), active: false },
    });
  }