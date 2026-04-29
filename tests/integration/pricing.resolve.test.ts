import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PriceResolutionRule, Prisma } from '@/generated/tenant';
import type { PrismaClient } from '@/generated/tenant';
import { resolvePrice } from '@/lib/pricing/resolve';
import { hasTenantDb, makeClient } from '../helpers/db';

const suite = hasTenantDb ? describe : describe.skip;

suite('resolvePrice', () => {
  let db: PrismaClient;
  let productWithPriceId: string;
  let productNoPriceId: string;
  let variantWithPriceId: string;
  let variantNoPriceId: string;

  beforeAll(async () => {
    db = makeClient();
    const p1 = await db.product.upsert({
      where: { sku: 'TEST-PROD-PRC-A' },
      create: {
        sku: 'TEST-PROD-PRC-A',
        name: 'Has price',
        basePrice: new Prisma.Decimal('12.34'),
      },
      update: { active: true, deletedAt: null, basePrice: new Prisma.Decimal('12.34') },
    });
    productWithPriceId = p1.id;
    const p2 = await db.product.upsert({
      where: { sku: 'TEST-PROD-PRC-B' },
      create: { sku: 'TEST-PROD-PRC-B', name: 'No price', basePrice: null },
      update: { active: true, deletedAt: null, basePrice: null },
    });
    productNoPriceId = p2.id;

    const v1 = await db.productVariant.upsert({
      where: { sku: 'TEST-PROD-PRC-A-V1' },
      create: { productId: p1.id, sku: 'TEST-PROD-PRC-A-V1', name: 'V1' },
      update: { productId: p1.id, active: true, deletedAt: null },
    });
    variantWithPriceId = v1.id;
    const v2 = await db.productVariant.upsert({
      where: { sku: 'TEST-PROD-PRC-B-V1' },
      create: { productId: p2.id, sku: 'TEST-PROD-PRC-B-V1', name: 'V1' },
      update: { productId: p2.id, active: true, deletedAt: null },
    });
    variantNoPriceId = v2.id;
  });

  beforeEach(() => {
    // resolvePrice is read-only — no per-test cleanup.
  });

  afterAll(async () => {
    await db.productVariant.deleteMany({ where: { id: { in: [variantWithPriceId, variantNoPriceId] } } });
    await db.product.deleteMany({ where: { id: { in: [productWithPriceId, productNoPriceId] } } });
    await db.$disconnect();
  });

  it('manual override returns MANUAL_OVERRIDE rule with the supplied price', async () => {
    const result = await db.$transaction((tx) =>
      resolvePrice(tx, {
        variantId: variantWithPriceId,
        customerId: 'unused-in-pilot',
        qty: new Prisma.Decimal('1'),
        manualUnitPrice: new Prisma.Decimal('5.00'),
      }),
    );
    expect(result.rule).toBe(PriceResolutionRule.MANUAL_OVERRIDE);
    expect(result.unitPrice.toString()).toBe(new Prisma.Decimal('5.00').toString());
  });

  it('no override returns BASE_PRICE from product.basePrice', async () => {
    const result = await db.$transaction((tx) =>
      resolvePrice(tx, {
        variantId: variantWithPriceId,
        customerId: 'unused-in-pilot',
        qty: new Prisma.Decimal('1'),
      }),
    );
    expect(result.rule).toBe(PriceResolutionRule.BASE_PRICE);
    expect(result.unitPrice.toString()).toBe(new Prisma.Decimal('12.34').toString());
  });

  it('product with null basePrice and no override throws', async () => {
    await expect(
      db.$transaction((tx) =>
        resolvePrice(tx, {
          variantId: variantNoPriceId,
          customerId: 'unused-in-pilot',
          qty: new Prisma.Decimal('1'),
        }),
      ),
    ).rejects.toThrow(/No price could be resolved/);
  });

  it('negative manual override is rejected', async () => {
    await expect(
      db.$transaction((tx) =>
        resolvePrice(tx, {
          variantId: variantWithPriceId,
          customerId: 'unused-in-pilot',
          qty: new Prisma.Decimal('1'),
          manualUnitPrice: new Prisma.Decimal('-1'),
        }),
      ),
    ).rejects.toThrow(/cannot be negative/);
  });

  it('unknown variant throws', async () => {
    await expect(
      db.$transaction((tx) =>
        resolvePrice(tx, {
          variantId: 'nonexistent-id',
          customerId: 'unused-in-pilot',
          qty: new Prisma.Decimal('1'),
        }),
      ),
    ).rejects.toThrow(/Variant not found/);
  });
});
