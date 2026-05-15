import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditAction } from '@/generated/tenant';
import type { PrismaClient } from '@/generated/tenant';
import {
  addProductImage,
  clearVariantImage,
  deleteProductImage,
  listProductImages,
  setPrimaryProductImage,
  setVariantImage,
} from '@/server/services/productImages';
import { hasTenantDb, makeClient } from '../helpers/db';

const suite = hasTenantDb ? describe : describe.skip;

const TAG = 'TEST-PRODIMG';
const USER = `${TAG}-USER`;
const ctx = { userId: USER };

suite('Product images service', () => {
  let db: PrismaClient;
  let productId: string;
  let variantId: string;

  beforeAll(async () => {
    db = makeClient();
  });

  beforeEach(async () => {
    await wipe(db);
    const product = await db.product.create({
      data: {
        sku: `${TAG}-SKU`,
        name: `${TAG} product`,
      },
    });
    productId = product.id;
    const variant = await db.productVariant.create({
      data: {
        productId,
        sku: `${TAG}-V1`,
        name: 'V1',
      },
    });
    variantId = variant.id;
  });

  afterAll(async () => {
    await wipe(db);
    await db.$disconnect();
  });

  // -------------------------------------------------------------------------
  // addProductImage
  // -------------------------------------------------------------------------

  it('addProductImage: first image is auto-primary', async () => {
    const img = await addProductImage(
      db,
      productId,
      { url: '/uploads/products/a.jpg' },
      ctx,
    );
    expect(img.isPrimary).toBe(true);
    expect(img.sortOrder).toBe(0);
  });

  it('addProductImage: second image is not auto-primary; sortOrder increments', async () => {
    await addProductImage(db, productId, { url: '/a.jpg' }, ctx);
    const second = await addProductImage(db, productId, { url: '/b.jpg' }, ctx);
    expect(second.isPrimary).toBe(false);
    expect(second.sortOrder).toBe(1);
  });

  it('addProductImage: writes a CREATE audit row', async () => {
    const img = await addProductImage(db, productId, { url: '/a.jpg' }, ctx);
    const rows = await db.auditLog.findMany({
      where: { entityType: 'ProductImage', entityId: img.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe(AuditAction.CREATE);
    expect(rows[0].userId).toBe(USER);
  });

  it('addProductImage: rejects soft-deleted product', async () => {
    await db.product.update({
      where: { id: productId },
      data: { deletedAt: new Date() },
    });
    await expect(
      addProductImage(db, productId, { url: '/a.jpg' }, ctx),
    ).rejects.toThrow(/Product not found/);
  });

  // -------------------------------------------------------------------------
  // setPrimaryProductImage
  // -------------------------------------------------------------------------

  it('setPrimaryProductImage: demotes existing primary atomically', async () => {
    const a = await addProductImage(db, productId, { url: '/a.jpg' }, ctx);
    const b = await addProductImage(db, productId, { url: '/b.jpg' }, ctx);
    await setPrimaryProductImage(db, productId, b.id, ctx);
    const refreshed = await listProductImages(db, productId);
    const primaries = refreshed.filter((r) => r.isPrimary);
    expect(primaries).toHaveLength(1);
    expect(primaries[0].id).toBe(b.id);
    const aRow = refreshed.find((r) => r.id === a.id);
    expect(aRow!.isPrimary).toBe(false);
  });

  it('setPrimaryProductImage: rejects image from a different product', async () => {
    const a = await addProductImage(db, productId, { url: '/a.jpg' }, ctx);
    const otherProduct = await db.product.create({
      data: { sku: `${TAG}-OTHER`, name: `${TAG} other` },
    });
    await expect(
      setPrimaryProductImage(db, otherProduct.id, a.id, ctx),
    ).rejects.toThrow(/does not belong to product/);
  });

  // -------------------------------------------------------------------------
  // deleteProductImage
  // -------------------------------------------------------------------------

  it('deleteProductImage: soft-deletes and auto-promotes the next image when primary is removed', async () => {
    const a = await addProductImage(db, productId, { url: '/a.jpg' }, ctx);
    const b = await addProductImage(db, productId, { url: '/b.jpg' }, ctx);
    expect(a.isPrimary).toBe(true);
    await deleteProductImage(db, a.id, ctx);

    const live = await listProductImages(db, productId);
    expect(live).toHaveLength(1);
    expect(live[0].id).toBe(b.id);
    expect(live[0].isPrimary).toBe(true);
  });

  it('deleteProductImage: deleting a non-primary leaves the primary alone', async () => {
    await addProductImage(db, productId, { url: '/a.jpg' }, ctx);
    const b = await addProductImage(db, productId, { url: '/b.jpg' }, ctx);
    await deleteProductImage(db, b.id, ctx);

    const live = await listProductImages(db, productId);
    expect(live).toHaveLength(1);
    expect(live[0].isPrimary).toBe(true);
  });

  it('deleteProductImage: deleting the only image leaves no primary', async () => {
    const a = await addProductImage(db, productId, { url: '/a.jpg' }, ctx);
    await deleteProductImage(db, a.id, ctx);
    const live = await listProductImages(db, productId);
    expect(live).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Variant image
  // -------------------------------------------------------------------------

  it('setVariantImage / clearVariantImage round-trip with audit rows', async () => {
    const set = await setVariantImage(db, variantId, '/uploads/variants/v.jpg', ctx);
    expect(set.imageUrl).toBe('/uploads/variants/v.jpg');

    const cleared = await clearVariantImage(db, variantId, ctx);
    expect(cleared.imageUrl).toBeNull();

    const rows = await db.auditLog.findMany({
      where: {
        entityType: 'ProductVariant',
        entityId: variantId,
        action: AuditAction.UPDATE,
      },
    });
    expect(rows.length).toBe(2);
  });
});

async function wipe(db: PrismaClient): Promise<void> {
  // Audit by userId (dedicated test tag).
  await db.auditLog.deleteMany({ where: { userId: USER } });

  const ourProducts = await db.product.findMany({
    where: { sku: { startsWith: `${TAG}-` } },
    select: { id: true },
  });
  const productIds = ourProducts.map((p) => p.id);
  if (productIds.length > 0) {
    await db.productImage.deleteMany({
      where: { productId: { in: productIds } },
    });
    await db.productVariant.deleteMany({
      where: { productId: { in: productIds } },
    });
    await db.product.deleteMany({ where: { id: { in: productIds } } });
  }
}
