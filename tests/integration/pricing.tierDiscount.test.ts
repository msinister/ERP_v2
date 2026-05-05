import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  CustomerType,
  PriceResolutionRule,
  Prisma,
} from '@/generated/tenant';
import type { PrismaClient } from '@/generated/tenant';
import { resolvePrice } from '@/lib/pricing/resolve';
import { setSetting } from '@/server/services/settings';
import {
  SETTING_KEYS,
  tierDiscountPercentagesValueSchema,
} from '@/lib/validation/settings';
import { hasTenantDb, makeClient } from '../helpers/db';

const suite = hasTenantDb ? describe : describe.skip;

const TAG = 'TEST-TIER';

suite('resolvePrice — TIER_DISCOUNT branch', () => {
  let db: PrismaClient;
  let productId: string;
  let variantId: string;
  let regularCustomerId: string;
  let preferredCustomerId: string;
  let retailCustomerId: string;
  let salesRepId: string;
  let paymentTermId: string;

  beforeAll(async () => {
    db = makeClient();
    const product = await db.product.upsert({
      where: { sku: `${TAG}-PROD` },
      create: {
        sku: `${TAG}-PROD`,
        name: 'Tier Test Product',
        basePrice: new Prisma.Decimal('100.00'),
      },
      update: {
        active: true,
        deletedAt: null,
        basePrice: new Prisma.Decimal('100.00'),
      },
    });
    productId = product.id;
    const variant = await db.productVariant.upsert({
      where: { sku: `${TAG}-V1` },
      create: { productId: product.id, sku: `${TAG}-V1`, name: 'V1' },
      update: { productId: product.id, active: true, deletedAt: null },
    });
    variantId = variant.id;

    const rep = await db.salesRep.findFirstOrThrow({ where: { code: 'UNASSIGNED' } });
    salesRepId = rep.id;
    const term = await db.paymentTerm.findFirstOrThrow({ where: { code: 'NET30' } });
    paymentTermId = term.id;

    regularCustomerId = (
      await db.customer.create({
        data: {
          code: `${TAG}-REG`,
          name: `${TAG} Regular`,
          type: CustomerType.WHOLESALE_REGULAR,
          salesRepId,
          paymentTermId,
        },
      })
    ).id;
    preferredCustomerId = (
      await db.customer.create({
        data: {
          code: `${TAG}-PREF`,
          name: `${TAG} Preferred`,
          type: CustomerType.WHOLESALE_PREFERRED,
          salesRepId,
          paymentTermId,
        },
      })
    ).id;
    retailCustomerId = (
      await db.customer.create({
        data: {
          code: `${TAG}-RET`,
          name: `${TAG} Retail`,
          type: CustomerType.RETAIL,
          salesRepId,
          paymentTermId,
        },
      })
    ).id;
  });

  afterEach(async () => {
    // Wipe the tier setting between tests so each test sets its own.
    const row = await db.setting.findUnique({
      where: { key: SETTING_KEYS.TIER_DISCOUNT_PERCENTAGES },
    });
    if (row) {
      await db.auditLog.deleteMany({
        where: { entityType: 'Setting', entityId: row.id },
      });
      await db.setting.delete({ where: { id: row.id } });
    }
    // Wipe customer-specific overrides — re-created per-test as needed.
    await db.customerPriceOverride.deleteMany({
      where: { variantId },
    });
  });

  afterAll(async () => {
    await db.customerPriceOverride.deleteMany({ where: { variantId } });
    await db.customer.deleteMany({
      where: {
        id: { in: [regularCustomerId, preferredCustomerId, retailCustomerId] },
      },
    });
    const row = await db.setting.findUnique({
      where: { key: SETTING_KEYS.TIER_DISCOUNT_PERCENTAGES },
    });
    if (row) {
      await db.auditLog.deleteMany({
        where: { entityType: 'Setting', entityId: row.id },
      });
      await db.setting.delete({ where: { id: row.id } });
    }
    await db.productVariant.deleteMany({ where: { id: variantId } });
    await db.product.deleteMany({ where: { id: productId } });
    await db.$disconnect();
  });

  function setTierMap(map: Record<string, string>) {
    return setSetting(
      db,
      SETTING_KEYS.TIER_DISCOUNT_PERCENTAGES,
      map,
      tierDiscountPercentagesValueSchema,
    );
  }

  function fullMap(overrides: Partial<Record<CustomerType, string>> = {}) {
    return {
      WHOLESALE_REGULAR: '0',
      WHOLESALE_PREFERRED: '0',
      WHOLESALE_DISTRIBUTOR: '0',
      WHOLESALE_MASTER_DISTRIBUTOR: '0',
      RETAIL: '0',
      ...overrides,
    };
  }

  // -------------------------------------------------------------------------
  // Setting missing → graceful no-op
  // -------------------------------------------------------------------------

  it('Missing setting → BASE_PRICE rule, discountPercent=null', async () => {
    const r = await db.$transaction((tx) =>
      resolvePrice(tx, {
        variantId,
        customerId: regularCustomerId,
        qty: new Prisma.Decimal('1'),
      }),
    );
    expect(r.rule).toBe(PriceResolutionRule.BASE_PRICE);
    expect(r.unitPrice.toString()).toBe(new Prisma.Decimal('100').toString());
    expect(r.discountPercent).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Tier % > 0 → TIER_DISCOUNT branch
  // -------------------------------------------------------------------------

  it('Tier % > 0 → TIER_DISCOUNT rule, BASE price, discount % pre-filled', async () => {
    await setTierMap(fullMap({ WHOLESALE_REGULAR: '15' }));
    const r = await db.$transaction((tx) =>
      resolvePrice(tx, {
        variantId,
        customerId: regularCustomerId,
        qty: new Prisma.Decimal('1'),
      }),
    );
    expect(r.rule).toBe(PriceResolutionRule.TIER_DISCOUNT);
    expect(r.unitPrice.toString()).toBe(new Prisma.Decimal('100').toString());
    expect(r.discountPercent?.toString()).toBe(new Prisma.Decimal('15').toString());
  });

  it('Different tier values for different CustomerTypes', async () => {
    await setTierMap(
      fullMap({
        WHOLESALE_REGULAR: '5',
        WHOLESALE_PREFERRED: '12',
        RETAIL: '0',
      }),
    );
    const reg = await db.$transaction((tx) =>
      resolvePrice(tx, {
        variantId,
        customerId: regularCustomerId,
        qty: new Prisma.Decimal('1'),
      }),
    );
    const pref = await db.$transaction((tx) =>
      resolvePrice(tx, {
        variantId,
        customerId: preferredCustomerId,
        qty: new Prisma.Decimal('1'),
      }),
    );
    const retail = await db.$transaction((tx) =>
      resolvePrice(tx, {
        variantId,
        customerId: retailCustomerId,
        qty: new Prisma.Decimal('1'),
      }),
    );
    expect(reg.rule).toBe(PriceResolutionRule.TIER_DISCOUNT);
    expect(reg.discountPercent?.toString()).toBe(new Prisma.Decimal('5').toString());
    expect(pref.rule).toBe(PriceResolutionRule.TIER_DISCOUNT);
    expect(pref.discountPercent?.toString()).toBe(new Prisma.Decimal('12').toString());
    expect(retail.rule).toBe(PriceResolutionRule.BASE_PRICE);
    expect(retail.discountPercent).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Tier % == 0 → falls through to BASE_PRICE
  // -------------------------------------------------------------------------

  it('Tier % == 0 → falls through to BASE_PRICE (rule reflects what fired)', async () => {
    await setTierMap(fullMap({ WHOLESALE_REGULAR: '0' }));
    const r = await db.$transaction((tx) =>
      resolvePrice(tx, {
        variantId,
        customerId: regularCustomerId,
        qty: new Prisma.Decimal('1'),
      }),
    );
    expect(r.rule).toBe(PriceResolutionRule.BASE_PRICE);
    expect(r.discountPercent).toBeNull();
  });

  // -------------------------------------------------------------------------
  // CUSTOMER_SPECIFIC overrides any tier discount
  // -------------------------------------------------------------------------

  it('CUSTOMER_SPECIFIC override beats TIER_DISCOUNT', async () => {
    await setTierMap(fullMap({ WHOLESALE_REGULAR: '20' }));
    await db.customerPriceOverride.create({
      data: {
        customerId: regularCustomerId,
        variantId,
        unitPrice: new Prisma.Decimal('80'),
      },
    });
    const r = await db.$transaction((tx) =>
      resolvePrice(tx, {
        variantId,
        customerId: regularCustomerId,
        qty: new Prisma.Decimal('1'),
      }),
    );
    expect(r.rule).toBe(PriceResolutionRule.CUSTOMER_SPECIFIC);
    expect(r.unitPrice.toString()).toBe(new Prisma.Decimal('80').toString());
    expect(r.discountPercent).toBeNull();
  });

  // -------------------------------------------------------------------------
  // MANUAL_OVERRIDE wins regardless
  // -------------------------------------------------------------------------

  it('MANUAL_OVERRIDE beats TIER_DISCOUNT', async () => {
    await setTierMap(fullMap({ WHOLESALE_REGULAR: '20' }));
    const r = await db.$transaction((tx) =>
      resolvePrice(tx, {
        variantId,
        customerId: regularCustomerId,
        qty: new Prisma.Decimal('1'),
        manualUnitPrice: new Prisma.Decimal('77.77'),
      }),
    );
    expect(r.rule).toBe(PriceResolutionRule.MANUAL_OVERRIDE);
    expect(r.unitPrice.toString()).toBe(new Prisma.Decimal('77.77').toString());
    expect(r.discountPercent).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Decimal precision preserved
  // -------------------------------------------------------------------------

  it('Decimal precision preserved on tier %', async () => {
    await setTierMap(fullMap({ WHOLESALE_REGULAR: '12.345' }));
    const r = await db.$transaction((tx) =>
      resolvePrice(tx, {
        variantId,
        customerId: regularCustomerId,
        qty: new Prisma.Decimal('1'),
      }),
    );
    expect(r.discountPercent?.toString()).toBe(
      new Prisma.Decimal('12.345').toString(),
    );
  });

  // -------------------------------------------------------------------------
  // Corrupt setting value → graceful no-op (no crash)
  // -------------------------------------------------------------------------

  it('Corrupt setting value → graceful no-op (resolver falls through to BASE_PRICE)', async () => {
    // Insert a malformed row directly, bypassing setSetting's validation.
    await db.setting.create({
      data: {
        key: SETTING_KEYS.TIER_DISCOUNT_PERCENTAGES,
        value: { not: 'a tier map' },
      },
    });
    const r = await db.$transaction((tx) =>
      resolvePrice(tx, {
        variantId,
        customerId: regularCustomerId,
        qty: new Prisma.Decimal('1'),
      }),
    );
    expect(r.rule).toBe(PriceResolutionRule.BASE_PRICE);
    expect(r.discountPercent).toBeNull();
  });
});
