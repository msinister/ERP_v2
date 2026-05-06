import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  PaymentTerm,
  PrismaClient,
  Product,
  ProductVariant,
  Vendor,
} from '@/generated/tenant';
import { createVendor } from '@/server/services/vendors';
import {
  createVendorProduct,
  listVendorProducts,
  listVendorsForVariant,
  setPrimaryVendorForVariant,
  softDeleteVendorProduct,
  updateVendorProduct,
} from '@/server/services/vendorProducts';
import { hasTenantDb, makeClient } from '../helpers/db';

const suite = hasTenantDb ? describe : describe.skip;

const TAG = 'TEST-VENDPROD';

suite('Vendor product catalog', () => {
  let db: PrismaClient;
  let term: PaymentTerm;
  let product: Product;
  let variantA: ProductVariant;
  let variantB: ProductVariant;

  beforeAll(async () => {
    db = makeClient();
    term = await db.paymentTerm.findFirstOrThrow({ where: { code: 'NET30' } });
    product = await db.product.upsert({
      where: { sku: `${TAG}-PROD` },
      create: { sku: `${TAG}-PROD`, name: `${TAG} Product` },
      update: { active: true, deletedAt: null },
    });
    variantA = await db.productVariant.upsert({
      where: { sku: `${TAG}-VA` },
      create: { productId: product.id, sku: `${TAG}-VA`, name: 'A' },
      update: { productId: product.id, active: true, deletedAt: null },
    });
    variantB = await db.productVariant.upsert({
      where: { sku: `${TAG}-VB` },
      create: { productId: product.id, sku: `${TAG}-VB`, name: 'B' },
      update: { productId: product.id, active: true, deletedAt: null },
    });
  });

  beforeEach(async () => {
    await wipe(db);
  });

  afterAll(async () => {
    await wipe(db);
    await db.productVariant.deleteMany({ where: { productId: product.id } });
    await db.product.deleteMany({ where: { id: product.id } });
    await db.$disconnect();
  });

  async function makeVendor(name: string, type: 'STOCK' | 'SERVICE' = 'STOCK'): Promise<Vendor> {
    return createVendor(db, { name: `${TAG} ${name}`, paymentTermId: term.id, type });
  }

  it('CRUD round-trip', async () => {
    const v = await makeVendor('CRUD');
    const vp = await createVendorProduct(db, v.id, {
      variantId: variantA.id,
      vendorSku: 'V-SKU-A',
      latestCost: '12.50',
      packSize: '24',
    });
    expect(vp.vendorSku).toBe('V-SKU-A');
    expect(vp.latestCost?.toString()).toBe('12.5');
    expect(vp.packSize?.toString()).toBe('24');

    const updated = await updateVendorProduct(db, vp.id, { latestCost: '13.00' });
    expect(updated.latestCost?.toString()).toBe('13');

    const deleted = await softDeleteVendorProduct(db, vp.id);
    expect(deleted.deletedAt).not.toBeNull();
    expect(deleted.isPrimary).toBe(false);
    expect(deleted.active).toBe(false);
  });

  it('blocks creating a catalog row on a SERVICE vendor', async () => {
    const sv = await makeVendor('Service', 'SERVICE');
    await expect(
      createVendorProduct(db, sv.id, { variantId: variantA.id, vendorSku: 'X' }),
    ).rejects.toThrow(/SERVICE-type/);
  });

  it('rejects duplicate (vendor, variant) among non-deleted rows', async () => {
    const v = await makeVendor('DUP');
    await createVendorProduct(db, v.id, { variantId: variantA.id, vendorSku: 'A1' });
    await expect(
      createVendorProduct(db, v.id, { variantId: variantA.id, vendorSku: 'A2' }),
    ).rejects.toThrow(/already exists/);
  });

  it('allows re-creating a catalog row after soft-delete (partial unique semantics)', async () => {
    const v = await makeVendor('REUSE');
    const first = await createVendorProduct(db, v.id, {
      variantId: variantA.id,
      vendorSku: 'A1',
    });
    await softDeleteVendorProduct(db, first.id);
    // The same (vendor, variant) pair can be re-inserted because the
    // partial unique index ignores soft-deleted rows.
    const second = await createVendorProduct(db, v.id, {
      variantId: variantA.id,
      vendorSku: 'A2',
    });
    expect(second.id).not.toBe(first.id);
    expect(second.vendorSku).toBe('A2');
  });

  it('multi-vendor for one variant — at most one isPrimary=true among non-deleted', async () => {
    const v1 = await makeVendor('Multi-1');
    const v2 = await makeVendor('Multi-2');
    const a = await createVendorProduct(db, v1.id, {
      variantId: variantA.id,
      isPrimary: true,
    });
    const b = await createVendorProduct(db, v2.id, {
      variantId: variantA.id,
      isPrimary: true,
    });
    // Creating b with isPrimary=true clears a's flag.
    expect(b.isPrimary).toBe(true);
    const refreshedA = await db.vendorProduct.findUnique({ where: { id: a.id } });
    expect(refreshedA!.isPrimary).toBe(false);

    // setPrimaryVendorForVariant flips back.
    await setPrimaryVendorForVariant(db, a.id);
    const finalA = await db.vendorProduct.findUnique({ where: { id: a.id } });
    const finalB = await db.vendorProduct.findUnique({ where: { id: b.id } });
    expect(finalA!.isPrimary).toBe(true);
    expect(finalB!.isPrimary).toBe(false);
  });

  it('listVendorProducts and listVendorsForVariant filter to non-deleted', async () => {
    const v = await makeVendor('LIST');
    await createVendorProduct(db, v.id, {
      variantId: variantA.id,
      vendorSku: 'A',
      isPrimary: true,
    });
    await createVendorProduct(db, v.id, { variantId: variantB.id, vendorSku: 'B' });
    const byVendor = await listVendorProducts(db, v.id);
    expect(byVendor).toHaveLength(2);

    const byVariantA = await listVendorsForVariant(db, variantA.id);
    const ours = byVariantA.filter((vp) => vp.vendorId === v.id);
    expect(ours).toHaveLength(1);
    expect(ours[0].isPrimary).toBe(true);
  });

  it('writes CREATE / UPDATE / DELETE audit rows', async () => {
    const v = await makeVendor('AUDIT');
    const vp = await createVendorProduct(db, v.id, {
      variantId: variantA.id,
      vendorSku: 'A',
    });
    await updateVendorProduct(db, vp.id, { vendorSku: 'A2' });
    await softDeleteVendorProduct(db, vp.id);
    const rows = await db.auditLog.findMany({
      where: { entityType: 'VendorProduct', entityId: vp.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(rows.map((r) => r.action)).toEqual(['CREATE', 'UPDATE', 'DELETE']);
  });
});

async function wipe(db: PrismaClient): Promise<void> {
  const ours = await db.vendor.findMany({
    where: { name: { startsWith: TAG } },
    select: { id: true },
  });
  const ids = ours.map((o) => o.id);
  if (ids.length === 0) return;
  const vpIds = (
    await db.vendorProduct.findMany({
      where: { vendorId: { in: ids } },
      select: { id: true },
    })
  ).map((vp) => vp.id);
  await db.vendorProduct.deleteMany({ where: { vendorId: { in: ids } } });
  await db.vendorAddress.deleteMany({ where: { vendorId: { in: ids } } });
  await db.vendorContact.deleteMany({ where: { vendorId: { in: ids } } });
  await db.auditLog.deleteMany({
    where: { entityType: 'Vendor', entityId: { in: ids } },
  });
  if (vpIds.length > 0) {
    await db.auditLog.deleteMany({
      where: { entityType: 'VendorProduct', entityId: { in: vpIds } },
    });
  }
  await db.vendor.deleteMany({ where: { id: { in: ids } } });
}
