import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PriceResolutionRule, Prisma } from '@/generated/tenant';
import type { PrismaClient } from '@/generated/tenant';
import { resolvePrice } from '@/lib/pricing/resolve';
import { hasTenantDb, makeClient } from '../helpers/db';
import { upsertTestCustomer } from '../helpers/customerStub';

const suite = hasTenantDb ? describe : describe.skip;

const TEST_CUSTOMER_CODE = 'TEST-PRC-CS-CUST';
const TEST_PRODUCT_SKU = 'TEST-PRC-CS-PROD';
const TEST_VARIANT_SKU = 'TEST-PRC-CS-V1';
const BASE_PRICE = '10.00';
const OVERRIDE_PRICE = '6.50';

suite('resolvePrice — CUSTOMER_SPECIFIC branch', () => {
  let db: PrismaClient;
  let customerId: string;
  let productId: string;
  let variantId: string;

  beforeAll(async () => {
    db = makeClient();
    const customer = await upsertTestCustomer(db, {
      code: TEST_CUSTOMER_CODE,
      name: 'Pricing CS Customer',
    });
    customerId = customer.id;
    const product = await db.product.upsert({
      where: { sku: TEST_PRODUCT_SKU },
      create: {
        sku: TEST_PRODUCT_SKU,
        name: 'Pricing CS Product',
        basePrice: new Prisma.Decimal(BASE_PRICE),
      },
      update: {
        active: true,
        deletedAt: null,
        basePrice: new Prisma.Decimal(BASE_PRICE),
      },
    });
    productId = product.id;
    const variant = await db.productVariant.upsert({
      where: { sku: TEST_VARIANT_SKU },
      create: { productId: product.id, sku: TEST_VARIANT_SKU, name: 'V1' },
      update: { productId: product.id, active: true, deletedAt: null },
    });
    variantId = variant.id;
  });

  beforeEach(async () => {
    await wipeOverrides(db, customerId, variantId);
  });

  afterAll(async () => {
    await wipeOverrides(db, customerId, variantId);
    // Don't delete the customer or product — other suites may share names.
    await db.productVariant.deleteMany({ where: { id: variantId } });
    await db.product.deleteMany({ where: { id: productId } });
    await db.auditLog.deleteMany({
      where: { entityType: 'Customer', entityId: customerId },
    });
    await db.customer.deleteMany({ where: { id: customerId } });
    await db.$disconnect();
  });

  it('customer with an active override returns CUSTOMER_SPECIFIC', async () => {
    await db.customerPriceOverride.create({
      data: {
        customerId,
        variantId,
        unitPrice: new Prisma.Decimal(OVERRIDE_PRICE),
        currency: 'USD',
      },
    });

    const result = await db.$transaction((tx) =>
      resolvePrice(tx, {
        variantId,
        customerId,
        qty: new Prisma.Decimal('1'),
      }),
    );
    expect(result.rule).toBe(PriceResolutionRule.CUSTOMER_SPECIFIC);
    expect(result.unitPrice.toString()).toBe(new Prisma.Decimal(OVERRIDE_PRICE).toString());
  });

  it('manual override on the line beats the customer-specific override', async () => {
    await db.customerPriceOverride.create({
      data: {
        customerId,
        variantId,
        unitPrice: new Prisma.Decimal(OVERRIDE_PRICE),
        currency: 'USD',
      },
    });

    const result = await db.$transaction((tx) =>
      resolvePrice(tx, {
        variantId,
        customerId,
        qty: new Prisma.Decimal('1'),
        manualUnitPrice: new Prisma.Decimal('1.00'),
      }),
    );
    expect(result.rule).toBe(PriceResolutionRule.MANUAL_OVERRIDE);
    expect(result.unitPrice.toString()).toBe(new Prisma.Decimal('1.00').toString());
  });

  it('customer with no override falls through to BASE_PRICE', async () => {
    const result = await db.$transaction((tx) =>
      resolvePrice(tx, {
        variantId,
        customerId,
        qty: new Prisma.Decimal('1'),
      }),
    );
    expect(result.rule).toBe(PriceResolutionRule.BASE_PRICE);
    expect(result.unitPrice.toString()).toBe(new Prisma.Decimal(BASE_PRICE).toString());
  });

  it('soft-deleted override is treated as absent — falls through to BASE_PRICE', async () => {
    await db.customerPriceOverride.create({
      data: {
        customerId,
        variantId,
        unitPrice: new Prisma.Decimal(OVERRIDE_PRICE),
        currency: 'USD',
        deletedAt: new Date(),
      },
    });

    const result = await db.$transaction((tx) =>
      resolvePrice(tx, {
        variantId,
        customerId,
        qty: new Prisma.Decimal('1'),
      }),
    );
    expect(result.rule).toBe(PriceResolutionRule.BASE_PRICE);
    expect(result.unitPrice.toString()).toBe(new Prisma.Decimal(BASE_PRICE).toString());
  });

  it('override with currency=USD and currency=null both resolve identically', async () => {
    // currency=USD
    await db.customerPriceOverride.create({
      data: {
        customerId,
        variantId,
        unitPrice: new Prisma.Decimal(OVERRIDE_PRICE),
        currency: 'USD',
      },
    });
    const r1 = await db.$transaction((tx) =>
      resolvePrice(tx, { variantId, customerId, qty: new Prisma.Decimal('1') }),
    );

    // Replace with currency=null and re-resolve.
    const existing = await db.customerPriceOverride.findFirstOrThrow({
      where: { customerId, variantId, deletedAt: null },
    });
    await db.customerPriceOverride.update({
      where: { id: existing.id },
      data: { currency: null },
    });
    const r2 = await db.$transaction((tx) =>
      resolvePrice(tx, { variantId, customerId, qty: new Prisma.Decimal('1') }),
    );

    expect(r1.rule).toBe(PriceResolutionRule.CUSTOMER_SPECIFIC);
    expect(r2.rule).toBe(PriceResolutionRule.CUSTOMER_SPECIFIC);
    expect(r1.unitPrice.toString()).toBe(r2.unitPrice.toString());
    expect(r1.unitPrice.toString()).toBe(new Prisma.Decimal(OVERRIDE_PRICE).toString());
  });
});

async function wipeOverrides(
  db: PrismaClient,
  customerId: string,
  variantId: string,
): Promise<void> {
  await db.customerPriceOverride.deleteMany({
    where: { customerId, variantId },
  });
}
