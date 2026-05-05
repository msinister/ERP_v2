import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CustomerType,
  PriceResolutionRule,
  Prisma,
} from '@/generated/tenant';
import type {
  Customer,
  PaymentTerm,
  PrismaClient,
  Product,
  ProductVariant,
  SalesRep,
} from '@/generated/tenant';
import { createCustomer } from '@/server/services/customers';
import { createSalesOrder } from '@/server/services/salesOrders';
import { setSetting } from '@/server/services/settings';
import {
  SETTING_KEYS,
  tierDiscountPercentagesValueSchema,
} from '@/lib/validation/settings';
import { hasTenantDb, makeClient } from '../helpers/db';
import { wipeInvoiceArtifactsForSOs } from '../helpers/wipeInvoiceArtifacts';

const suite = hasTenantDb ? describe : describe.skip;

const TAG = 'TEST-SOTD';

// End-to-end proof that TIER_DISCOUNT pre-fills SOLine.discountPercent
// at createSalesOrder time, and that operator-supplied line discounts
// always win.

suite('SO TIER_DISCOUNT pre-fill — end-to-end through createSalesOrder', () => {
  let db: PrismaClient;
  let salesRep: SalesRep;
  let term: PaymentTerm;
  let customer: Customer;
  let warehouseId: string;
  let product: Product;
  let variant: ProductVariant;

  const BASE_PRICE = '100.00';

  beforeAll(async () => {
    db = makeClient();
    salesRep = await db.salesRep.findFirstOrThrow({ where: { code: 'UNASSIGNED' } });
    term = await db.paymentTerm.findFirstOrThrow({ where: { code: 'NET30' } });
    const wh = await db.warehouse.upsert({
      where: { code: `${TAG}-WH` },
      create: { code: `${TAG}-WH`, name: 'SO TD WH' },
      update: { active: true, deletedAt: null },
    });
    warehouseId = wh.id;
    product = await db.product.upsert({
      where: { sku: `${TAG}-PROD` },
      create: {
        sku: `${TAG}-PROD`,
        name: 'SO TD Product',
        basePrice: new Prisma.Decimal(BASE_PRICE),
      },
      update: {
        active: true,
        deletedAt: null,
        basePrice: new Prisma.Decimal(BASE_PRICE),
      },
    });
    variant = await db.productVariant.upsert({
      where: { sku: `${TAG}-V1` },
      create: { productId: product.id, sku: `${TAG}-V1`, name: 'V1' },
      update: { productId: product.id, active: true, deletedAt: null },
    });
  });

  beforeEach(async () => {
    await wipe(db);
    customer = await createCustomer(db, {
      name: `${TAG} Customer`,
      type: CustomerType.WHOLESALE_PREFERRED,
      salesRepId: salesRep.id,
      paymentTermId: term.id,
      billingAddress: {
        kind: 'BILLING',
        line1: '1 St',
        city: 'Dallas',
        region: 'TX',
        postalCode: '75201',
      },
    });
    await setSetting(
      db,
      SETTING_KEYS.TIER_DISCOUNT_PERCENTAGES,
      {
        WHOLESALE_REGULAR: '5',
        WHOLESALE_PREFERRED: '10',
        WHOLESALE_DISTRIBUTOR: '15',
        WHOLESALE_MASTER_DISTRIBUTOR: '20',
        RETAIL: '0',
      },
      tierDiscountPercentagesValueSchema,
    );
  });

  afterAll(async () => {
    await wipe(db);
    const row = await db.setting.findUnique({
      where: { key: SETTING_KEYS.TIER_DISCOUNT_PERCENTAGES },
    });
    if (row) {
      await db.auditLog.deleteMany({
        where: { entityType: 'Setting', entityId: row.id },
      });
      await db.setting.delete({ where: { id: row.id } });
    }
    await db.productVariant.deleteMany({ where: { id: variant.id } });
    await db.product.deleteMany({ where: { id: product.id } });
    await db.warehouse.deleteMany({ where: { code: `${TAG}-WH` } });
    await db.$disconnect();
  });

  it('Tier discount pre-fills SOLine.discountPercent when operator left it blank', async () => {
    const so = await createSalesOrder(db, {
      customerId: customer.id,
      warehouseId,
      lines: [{ variantId: variant.id, warehouseId, qtyOrdered: '3' }],
    });
    const line = so.lines[0]!;
    expect(line.priceRule).toBe(PriceResolutionRule.TIER_DISCOUNT);
    expect(line.unitPrice.toString()).toBe(new Prisma.Decimal(BASE_PRICE).toString());
    expect(line.discountPercent?.toString()).toBe(
      new Prisma.Decimal('10').toString(),
    );
    expect(line.discountAmount).toBeNull();
  });

  it('Operator-supplied discountPercent wins (no stacking)', async () => {
    const so = await createSalesOrder(db, {
      customerId: customer.id,
      warehouseId,
      lines: [
        {
          variantId: variant.id,
          warehouseId,
          qtyOrdered: '3',
          discountPercent: '25',
        },
      ],
    });
    const line = so.lines[0]!;
    expect(line.priceRule).toBe(PriceResolutionRule.TIER_DISCOUNT);
    // Operator's 25 wins over tier's 10.
    expect(line.discountPercent?.toString()).toBe(
      new Prisma.Decimal('25').toString(),
    );
  });

  it('Operator-supplied discountAmount blocks tier % pre-fill', async () => {
    const so = await createSalesOrder(db, {
      customerId: customer.id,
      warehouseId,
      lines: [
        {
          variantId: variant.id,
          warehouseId,
          qtyOrdered: '3',
          discountAmount: '7.50',
        },
      ],
    });
    const line = so.lines[0]!;
    expect(line.discountPercent).toBeNull();
    expect(line.discountAmount?.toString()).toBe(
      new Prisma.Decimal('7.50').toString(),
    );
  });
});

async function wipe(db: PrismaClient): Promise<void> {
  const customers = await db.customer.findMany({
    where: { name: { startsWith: TAG } },
    select: { id: true },
  });
  const ids = customers.map((c) => c.id);
  if (ids.length === 0) return;
  const ourSos = await db.salesOrder.findMany({
    where: { customerId: { in: ids } },
    select: { id: true },
  });
  const soIds = ourSos.map((s) => s.id);
  await wipeInvoiceArtifactsForSOs(db, soIds);
  if (soIds.length > 0) {
    await db.auditLog.deleteMany({
      where: { entityType: 'SalesOrder', entityId: { in: soIds } },
    });
  }
  await db.salesOrderLine.deleteMany({
    where: { salesOrder: { customerId: { in: ids } } },
  });
  await db.salesOrder.deleteMany({ where: { customerId: { in: ids } } });
  const ourAddresses = await db.customerAddress.findMany({
    where: { customerId: { in: ids } },
    select: { id: true },
  });
  const addressIds = ourAddresses.map((a) => a.id);
  await db.customerActivity.deleteMany({ where: { customerId: { in: ids } } });
  await db.customerAddress.deleteMany({ where: { customerId: { in: ids } } });
  await db.auditLog.deleteMany({
    where: { entityType: 'Customer', entityId: { in: ids } },
  });
  if (addressIds.length > 0) {
    await db.auditLog.deleteMany({
      where: { entityType: 'CustomerAddress', entityId: { in: addressIds } },
    });
  }
  await db.customer.deleteMany({ where: { id: { in: ids } } });
}
