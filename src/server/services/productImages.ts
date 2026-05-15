import { AuditAction } from '@/generated/tenant';
import type {
  PrismaClient,
  ProductImage,
  ProductVariant,
} from '@/generated/tenant';
import { audit, type AuditContext } from '@/lib/audit/audit';

// =============================================================================
// Product image management. Multi-image gallery on Product with one
// `isPrimary` marker; single optional `imageUrl` on ProductVariant for
// per-variant override.
//
// Primary semantics — invariants enforced here:
//   - At most one non-deleted ProductImage per product has
//     isPrimary = true.
//   - The first image added to a product is automatically primary.
//   - Deleting the primary auto-promotes the next non-deleted image
//     (lowest sortOrder, then createdAt) to primary. If none remain,
//     the product simply has no primary.
//
// All mutations write audit rows.
// =============================================================================

export async function listProductImages(
  db: PrismaClient,
  productId: string,
): Promise<ProductImage[]> {
  return db.productImage.findMany({
    where: { productId, deletedAt: null },
    orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
  });
}

export async function addProductImage(
  db: PrismaClient,
  productId: string,
  input: { url: string; altText?: string | null },
  ctx?: AuditContext,
): Promise<ProductImage> {
  return db.$transaction(async (tx) => {
    const product = await tx.product.findUnique({
      where: { id: productId },
      select: { id: true, deletedAt: true },
    });
    if (!product || product.deletedAt) {
      throw new Error(`Product not found: ${productId}`);
    }
    // First image on the product is auto-primary so thumbnails resolve
    // immediately without an extra "set primary" step.
    const existingCount = await tx.productImage.count({
      where: { productId, deletedAt: null },
    });
    const created = await tx.productImage.create({
      data: {
        productId,
        url: input.url,
        altText: input.altText ?? null,
        isPrimary: existingCount === 0,
        sortOrder: existingCount,
      },
    });
    await audit(tx, {
      action: AuditAction.CREATE,
      entityType: 'ProductImage',
      entityId: created.id,
      after: created,
      ctx,
    });
    return created;
  });
}

export async function setPrimaryProductImage(
  db: PrismaClient,
  productId: string,
  imageId: string,
  ctx?: AuditContext,
): Promise<ProductImage> {
  return db.$transaction(async (tx) => {
    const target = await tx.productImage.findUnique({
      where: { id: imageId },
      select: { id: true, productId: true, deletedAt: true, isPrimary: true },
    });
    if (!target || target.deletedAt) {
      throw new Error(`ProductImage not found: ${imageId}`);
    }
    if (target.productId !== productId) {
      throw new Error(
        `Image ${imageId} does not belong to product ${productId}`,
      );
    }
    // Demote whichever image is currently primary on this product, then
    // promote the target. Both ops in one transaction so we never see a
    // two-primary window.
    if (!target.isPrimary) {
      await tx.productImage.updateMany({
        where: { productId, isPrimary: true, deletedAt: null },
        data: { isPrimary: false },
      });
      const after = await tx.productImage.update({
        where: { id: imageId },
        data: { isPrimary: true },
      });
      await audit(tx, {
        action: AuditAction.UPDATE,
        entityType: 'ProductImage',
        entityId: imageId,
        before: { isPrimary: false },
        after: { isPrimary: true },
        ctx,
      });
      return after;
    }
    return target as ProductImage;
  });
}

export async function deleteProductImage(
  db: PrismaClient,
  imageId: string,
  ctx?: AuditContext,
): Promise<ProductImage> {
  return db.$transaction(async (tx) => {
    const before = await tx.productImage.findUnique({ where: { id: imageId } });
    if (!before || before.deletedAt) {
      throw new Error(`ProductImage not found: ${imageId}`);
    }
    const after = await tx.productImage.update({
      where: { id: imageId },
      data: { deletedAt: new Date(), isPrimary: false },
    });

    // Auto-promote the next image if we just removed the primary. Pick
    // the lowest sortOrder, ties broken by oldest createdAt — operators
    // expect the gallery's "first remaining" to become primary.
    if (before.isPrimary) {
      const next = await tx.productImage.findFirst({
        where: { productId: before.productId, deletedAt: null },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      });
      if (next) {
        await tx.productImage.update({
          where: { id: next.id },
          data: { isPrimary: true },
        });
      }
    }

    await audit(tx, {
      action: AuditAction.DELETE,
      entityType: 'ProductImage',
      entityId: imageId,
      before,
      after,
      ctx,
    });
    return after;
  });
}

export async function setVariantImage(
  db: PrismaClient,
  variantId: string,
  imageUrl: string,
  ctx?: AuditContext,
): Promise<ProductVariant> {
  return db.$transaction(async (tx) => {
    const before = await tx.productVariant.findUnique({
      where: { id: variantId },
    });
    if (!before || before.deletedAt) {
      throw new Error(`ProductVariant not found: ${variantId}`);
    }
    const after = await tx.productVariant.update({
      where: { id: variantId },
      data: { imageUrl },
    });
    await audit(tx, {
      action: AuditAction.UPDATE,
      entityType: 'ProductVariant',
      entityId: variantId,
      before: { imageUrl: before.imageUrl },
      after: { imageUrl: after.imageUrl },
      ctx,
    });
    return after;
  });
}

export async function clearVariantImage(
  db: PrismaClient,
  variantId: string,
  ctx?: AuditContext,
): Promise<ProductVariant> {
  return db.$transaction(async (tx) => {
    const before = await tx.productVariant.findUnique({
      where: { id: variantId },
    });
    if (!before || before.deletedAt) {
      throw new Error(`ProductVariant not found: ${variantId}`);
    }
    const after = await tx.productVariant.update({
      where: { id: variantId },
      data: { imageUrl: null },
    });
    await audit(tx, {
      action: AuditAction.UPDATE,
      entityType: 'ProductVariant',
      entityId: variantId,
      before: { imageUrl: before.imageUrl },
      after: { imageUrl: null },
      ctx,
    });
    return after;
  });
}
