import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PriceResolutionRule, Prisma } from '@/generated/tenant';
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
import { hasTenantDb, makeClient } from '../helpers/db';
import { wipeInvoiceArtifactsForSOs } from '../helpers/wipeInvoiceArtifacts';

const suite = hasTenantDb ? describe : describe.skip;

const TAG = 'TEST-SOCSP';

// End-to-end proof that CUSTOMER_SPECIFIC flows through the real SO
// service — not just the resolver in isolation. Tests in
// pricing.customer-specific.test.ts cover resolvePrice() directly;
// this file proves a freshly-created SOLine carries the override price
// and rule when the SO service does the resolution.

suite('SO customer-specific pricing — end-to-end through createSalesOrder', () => {
  let db: PrismaClient;
  let salesRep: SalesRep;
  let term: PaymentTerm;
  let customer: Customer;
  let warehouseId: string;
  let product: Product;
  let variant: ProductVariant;

  const BASE_PRICE = '12.00';
  const OVERRIDE_PRICE = '7.50';
  const MANUAL_PRICE = '1.00';

  beforeAll(async () => {
    db = makeClient();
    salesRep = await db.salesRep.findFirstOrThrow({ where: { code: 'UNASSIGNED' } });
    term = await db.paymentTerm.findFirstOrThrow({ where: { code: 'NET30' } });

    const wh = await db.warehouse.upsert({
      where: { code: `${TAG}-WH` },
      create: { code: `${TAG}-WH`, name: 'SO CSP WH' },
      update: { active: true, deletedAt: null },
    });
    warehouseId = wh.id;

    product = await db.product.upsert({
      where: { sku: `${TAG}-PROD` },
      create: {
        sku: `${TAG}-PROD`,
        name: 'SO CSP Product',
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
  });

  afterAll(async () => {
    await wipe(db);
    await db.productVariant.deleteMany({ where: { id: variant.id } });
    await db.product.deleteMany({ where: { id: product.id } });
    await db.warehouse.deleteMany({ where: { code: `${TAG}-WH` } });
    await db.$disconnect();
  });

  it('SO line picks up CUSTOMER_SPECIFIC when an active override exists and no manualUnitPrice is supplied', async () => {
    await db.customerPriceOverride.create({
      data: {
        customerId: customer.id,
        variantId: variant.id,
        unitPrice: new Prisma.Decimal(OVERRIDE_PRICE),
        currency: 'USD',
      },
    });

    const so = await createSalesOrder(db, {
      customerId: customer.id,
      warehouseId,
      lines: [{ variantId: variant.id, warehouseId, qtyOrdered: '3' }],
    });
    expect(so.lines).toHaveLength(1);
    expect(so.lines[0].priceRule).toBe(PriceResolutionRule.CUSTOMER_SPECIFIC);
    expect(so.lines[0].unitPrice.toString()).toBe(
      new Prisma.Decimal(OVERRIDE_PRICE).toString(),
    );
  });

  it('manualUnitPrice on the SO line beats the customer override (rule=MANUAL_OVERRIDE)', async () => {
    await db.customerPriceOverride.create({
      data: {
        customerId: customer.id,
        variantId: variant.id,
        unitPrice: new Prisma.Decimal(OVERRIDE_PRICE),
        currency: 'USD',
      },
    });

    const so = await createSalesOrder(db, {
      customerId: customer.id,
      warehouseId,
      lines: [
        {
          variantId: variant.id,
          warehouseId,
          qtyOrdered: '2',
          manualUnitPrice: MANUAL_PRICE,
        },
      ],
    });
    expect(so.lines[0].priceRule).toBe(PriceResolutionRule.MANUAL_OVERRIDE);
    expect(so.lines[0].unitPrice.toString()).toBe(
      new Prisma.Decimal(MANUAL_PRICE).toString(),
    );
  });

  it('soft-deleted override is treated as absent — line falls through to BASE_PRICE', async () => {
    await db.customerPriceOverride.create({
      data: {
        customerId: customer.id,
        variantId: variant.id,
        unitPrice: new Prisma.Decimal(OVERRIDE_PRICE),
        currency: 'USD',
        deletedAt: new Date(),
      },
    });

    const so = await createSalesOrder(db, {
      customerId: customer.id,
      warehouseId,
      lines: [{ variantId: variant.id, warehouseId, qtyOrdered: '1' }],
    });
    expect(so.lines[0].priceRule).toBe(PriceResolutionRule.BASE_PRICE);
    expect(so.lines[0].unitPrice.toString()).toBe(
      new Prisma.Decimal(BASE_PRICE).toString(),
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
  await wipeInvoiceArtifactsForSOs(db, ourSos.map((s) => s.id));
  // Scope SO audits by THIS test's SO ids — wholesale-by-entityType
  // would clobber other parallel test files.
  const soIds = ourSos.map((s) => s.id);
  if (soIds.length > 0) {
    await db.auditLog.deleteMany({
      where: { entityType: 'SalesOrder', entityId: { in: soIds } },
    });
  }
  await db.salesOrderLine.deleteMany({ where: { salesOrder: { customerId: { in: ids } } } });
  await db.salesOrder.deleteMany({ where: { customerId: { in: ids } } });
  const ourAddresses = await db.customerAddress.findMany({
    where: { customerId: { in: ids } },
    select: { id: true },
  });
  const addressIds = ourAddresses.map((a) => a.id);
  const ourOverrides = await db.customerPriceOverride.findMany({
    where: { customerId: { in: ids } },
    select: { id: true },
  });
  const overrideIds = ourOverrides.map((o) => o.id);
  await db.customerPriceOverride.deleteMany({ where: { customerId: { in: ids } } });
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
  if (overrideIds.length > 0) {
    await db.auditLog.deleteMany({
      where: { entityType: 'CustomerPriceOverride', entityId: { in: overrideIds } },
    });
  }
  await db.customer.deleteMany({ where: { id: { in: ids } } });
}
