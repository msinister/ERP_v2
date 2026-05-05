import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PaymentMethod, Prisma } from '@/generated/tenant';
import type {
  Customer,
  PaymentTerm,
  PrismaClient,
  Product,
  ProductVariant,
  SalesRep,
} from '@/generated/tenant';
import { createCustomer } from '@/server/services/customers';
import {
  closeSalesOrder,
  confirmSalesOrder,
  createSalesOrder,
} from '@/server/services/salesOrders';
import { receiveInventory } from '@/server/services/movements';
import { recordPayment } from '@/server/services/payments';
import {
  ArHoldExceededError,
  CreditLimitExceededError,
} from '@/lib/errors/credit';
import { hasTenantDb, makeClient } from '../helpers/db';
import { upsertTestWarehouse } from '../helpers/warehouseStub';

const suite = hasTenantDb ? describe : describe.skip;

const TAG = 'TEST-CREDIT';

suite('SalesOrder confirm — credit-limit + AR-hold enforcement', () => {
  let db: PrismaClient;
  let salesRep: SalesRep;
  let net30: PaymentTerm;
  let warehouseId: string;
  let product: Product;
  let variant: ProductVariant;

  beforeAll(async () => {
    db = makeClient();
    salesRep = await db.salesRep.findFirstOrThrow({ where: { code: 'UNASSIGNED' } });
    net30 = await db.paymentTerm.findFirstOrThrow({ where: { code: 'NET30' } });
    const wh = await upsertTestWarehouse(db, {
      code: `${TAG}-WH`,
      name: 'Credit WH',
    });
    warehouseId = wh.id;
    product = await db.product.upsert({
      where: { sku: `${TAG}-PROD` },
      create: { sku: `${TAG}-PROD`, name: 'Credit Product', basePrice: new Prisma.Decimal('1.00') },
      update: { active: true, deletedAt: null, basePrice: new Prisma.Decimal('1.00') },
    });
    variant = await db.productVariant.upsert({
      where: { sku: `${TAG}-V` },
      create: { productId: product.id, sku: `${TAG}-V`, name: 'V' },
      update: { productId: product.id, active: true, deletedAt: null },
    });
  });

  beforeEach(async () => {
    await wipe(db);
    await receiveInventory(db, { variantId: variant.id, warehouseId, qty: '100000' });
  });

  afterAll(async () => {
    await wipe(db);
    await db.productVariant.deleteMany({ where: { productId: product.id } });
    await db.product.deleteMany({ where: { id: product.id } });
    await db.warehouse.deleteMany({ where: { code: `${TAG}-WH` } });
    await db.$disconnect();
  });

  async function newCustomer(
    suffix: string,
    opts: { creditLimit?: string | null; arHoldDays?: number | null } = {},
  ): Promise<Customer> {
    return createCustomer(db, {
      name: `${TAG} ${suffix}`,
      salesRepId: salesRep.id,
      paymentTermId: net30.id,
      creditLimit: opts.creditLimit ?? undefined,
      arHoldDays: opts.arHoldDays ?? undefined,
      billingAddress: {
        kind: 'BILLING',
        line1: '1 St',
        city: 'Dallas',
        region: 'TX',
        postalCode: '75201',
      },
    });
  }

  async function makeSO(customerId: string, qty: string, unitPrice = '10') {
    return createSalesOrder(db, {
      customerId,
      warehouseId,
      lines: [
        {
          variantId: variant.id,
          warehouseId,
          qtyOrdered: qty,
          manualUnitPrice: unitPrice,
        },
      ],
    });
  }

  async function makeInvoiceForCustomer(
    customerId: string,
    unitPrice: string,
    qty: string,
    backdateDays?: number,
  ) {
    const so = await makeSO(customerId, qty, unitPrice);
    await confirmSalesOrder(db, so.id);
    await closeSalesOrder(db, so.id, undefined);
    const inv = await db.invoice.findFirstOrThrow({ where: { salesOrderId: so.id } });
    if (backdateDays != null) {
      const date = new Date(Date.now() - backdateDays * 24 * 60 * 60 * 1000);
      return db.invoice.update({ where: { id: inv.id }, data: { invoiceDate: date } });
    }
    return inv;
  }

  // -------------------------------------------------------------------------
  // Credit limit
  // -------------------------------------------------------------------------

  it('Customer with creditLimit=NULL: gate is off (any size order confirms)', async () => {
    const c = await newCustomer('NL', { creditLimit: null });
    const so = await makeSO(c.id, '99999', '10'); // ~$999,990
    await expect(confirmSalesOrder(db, so.id)).resolves.toBeDefined();
  });

  it('Order at exactly the limit (AR=0, no open SOs) is allowed', async () => {
    const c = await newCustomer('AT', { creditLimit: '500' });
    const so = await makeSO(c.id, '50', '10'); // $500
    await expect(confirmSalesOrder(db, so.id)).resolves.toBeDefined();
  });

  it('Order one cent over limit throws CreditLimitExceededError', async () => {
    const c = await newCustomer('OV', { creditLimit: '500' });
    const so = await makeSO(c.id, '50.001', '10'); // $500.01
    const err = await confirmSalesOrder(db, so.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CreditLimitExceededError);
    const e = err as CreditLimitExceededError;
    expect(e.code).toBe('CREDIT_LIMIT_EXCEEDED');
    expect(e.creditLimit).toBe(new Prisma.Decimal('500').toString());
    expect(e.arBalance).toBe(new Prisma.Decimal('0').toString());
    expect(e.openSosTotal).toBe(new Prisma.Decimal('0').toString());
  });

  it('AR balance counts toward exposure', async () => {
    const c = await newCustomer('AR', { creditLimit: '500' });
    await makeInvoiceForCustomer(c.id, '10', '40'); // $400 AR
    // $200 new order → projected $600 > limit $500.
    const so = await makeSO(c.id, '20', '10');
    const err = await confirmSalesOrder(db, so.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CreditLimitExceededError);
    expect((err as CreditLimitExceededError).arBalance).toBe(
      new Prisma.Decimal('400').toString(),
    );
  });

  it('Open CONFIRMED SOs count toward exposure (excluding the one being confirmed)', async () => {
    const c = await newCustomer('OS', { creditLimit: '500' });
    const so1 = await makeSO(c.id, '30', '10'); // $300
    await confirmSalesOrder(db, so1.id);
    // $250 new order → projected $0 AR + $300 open + $250 = $550 > $500.
    const so2 = await makeSO(c.id, '25', '10');
    const err = await confirmSalesOrder(db, so2.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CreditLimitExceededError);
    expect((err as CreditLimitExceededError).openSosTotal).toBe(
      new Prisma.Decimal('300').toString(),
    );
    expect((err as CreditLimitExceededError).thisOrderTotal).toBe(
      new Prisma.Decimal('250').toString(),
    );
  });

  it('Order respects line discount when computing exposure', async () => {
    const c = await newCustomer('DS', { creditLimit: '500' });
    // 100 * $10 = $1000, then 60% discount = $400 → at limit ok.
    const so = await createSalesOrder(db, {
      customerId: c.id,
      warehouseId,
      lines: [
        {
          variantId: variant.id,
          warehouseId,
          qtyOrdered: '100',
          manualUnitPrice: '10',
          discountPercent: '60',
        },
      ],
    });
    await expect(confirmSalesOrder(db, so.id)).resolves.toBeDefined();
  });

  it('Pre-flight failure does not flip status / write inventory state', async () => {
    const c = await newCustomer('NF', { creditLimit: '50' });
    const so = await makeSO(c.id, '10', '10'); // $100 over $50 limit
    await expect(confirmSalesOrder(db, so.id)).rejects.toBeInstanceOf(
      CreditLimitExceededError,
    );
    const fresh = await db.salesOrder.findUniqueOrThrow({ where: { id: so.id } });
    expect(fresh.status).toBe('DRAFT');
    expect(fresh.confirmedAt).toBeNull();
    const line = await db.salesOrderLine.findFirstOrThrow({
      where: { salesOrderId: so.id },
    });
    expect(line.qtyReserved.toString()).toBe('0');
  });

  // -------------------------------------------------------------------------
  // AR hold
  // -------------------------------------------------------------------------

  it('Customer with arHoldDays=NULL: hold is off (overdue invoice does not block)', async () => {
    const c = await newCustomer('HN', { creditLimit: null, arHoldDays: null });
    await makeInvoiceForCustomer(c.id, '10', '10', /*backdate*/ 365); // wildly overdue
    const so = await makeSO(c.id, '1', '10');
    await expect(confirmSalesOrder(db, so.id)).resolves.toBeDefined();
  });

  it('No invoice past arHoldDays threshold → confirm passes', async () => {
    const c = await newCustomer('HP', { creditLimit: null, arHoldDays: 60 });
    // Net30 + invoice 50 days ago → daysPastDue = 20 < 60.
    await makeInvoiceForCustomer(c.id, '10', '10', 50);
    const so = await makeSO(c.id, '1', '10');
    await expect(confirmSalesOrder(db, so.id)).resolves.toBeDefined();
  });

  it('Invoice past arHoldDays threshold → ArHoldExceededError', async () => {
    const c = await newCustomer('HF', { creditLimit: null, arHoldDays: 30 });
    // Net30 + invoice 80 days ago → due 50 days ago → daysPastDue=50 >= 30.
    const inv = await makeInvoiceForCustomer(c.id, '10', '10', 80);
    const so = await makeSO(c.id, '1', '10');
    const err = await confirmSalesOrder(db, so.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ArHoldExceededError);
    const e = err as ArHoldExceededError;
    expect(e.code).toBe('AR_HOLD_EXCEEDED');
    expect(e.arHoldDays).toBe(30);
    expect(e.worstInvoiceNumber).toBe(inv.number);
    expect(e.worstInvoiceDaysPastDue).toBeGreaterThanOrEqual(30);
  });

  it('Paid invoice does not trip AR hold (excluded from open set)', async () => {
    const c = await newCustomer('HX', { creditLimit: null, arHoldDays: 30 });
    const inv = await makeInvoiceForCustomer(c.id, '10', '10', 80);
    await recordPayment(db, {
      customerId: c.id,
      method: PaymentMethod.CHECK,
      amount: '100',
      applications: [{ invoiceId: inv.id, amount: '100' }],
    });
    const so = await makeSO(c.id, '1', '10');
    await expect(confirmSalesOrder(db, so.id)).resolves.toBeDefined();
  });

  it('Both gates configured: credit-limit fires before AR-hold (order matters in code)', async () => {
    // Create with a roomy limit so the setup invoice can be created,
    // then tighten the limit so the test SO trips both gates.
    const c = await newCustomer('BO', { creditLimit: '10000', arHoldDays: 30 });
    await makeInvoiceForCustomer(c.id, '10', '10', 80); // overdue + AR=$100
    await db.customer.update({
      where: { id: c.id },
      data: { creditLimit: new Prisma.Decimal('50') },
    });
    const so = await makeSO(c.id, '1', '10');
    const err = await confirmSalesOrder(db, so.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CreditLimitExceededError);
  });
});

async function wipe(db: PrismaClient): Promise<void> {
  const customers = await db.customer.findMany({
    where: { name: { startsWith: TAG } },
    select: { id: true },
  });
  const ids = customers.map((c) => c.id);
  if (ids.length === 0) return;

  // Payments and their JEs / applications.
  const payments = await db.payment.findMany({
    where: { customerId: { in: ids } },
    select: { id: true },
  });
  if (payments.length > 0) {
    const pmtIds = payments.map((p) => p.id);
    const pmtJes = await db.journalEntry.findMany({
      where: { entityType: 'Payment', entityId: { in: pmtIds } },
      select: { id: true },
    });
    if (pmtJes.length > 0) {
      const jeIds = pmtJes.map((j) => j.id);
      await db.journalEntryLine.deleteMany({ where: { journalEntryId: { in: jeIds } } });
      await db.journalEntry.deleteMany({ where: { id: { in: jeIds } } });
    }
    await db.creditApplication.deleteMany({ where: { paymentId: { in: pmtIds } } });
    await db.auditLog.deleteMany({
      where: { entityType: 'Payment', entityId: { in: pmtIds } },
    });
    await db.payment.deleteMany({ where: { id: { in: pmtIds } } });
  }

  // Invoices.
  const invoices = await db.invoice.findMany({
    where: { customerId: { in: ids } },
    select: { id: true },
  });
  if (invoices.length > 0) {
    const invIds = invoices.map((i) => i.id);
    const jes = await db.journalEntry.findMany({
      where: { entityType: 'Invoice', entityId: { in: invIds } },
      select: { id: true },
    });
    if (jes.length > 0) {
      const jeIds = jes.map((j) => j.id);
      await db.journalEntryLine.deleteMany({ where: { journalEntryId: { in: jeIds } } });
      await db.journalEntry.deleteMany({ where: { id: { in: jeIds } } });
    }
    await db.creditApplication.deleteMany({ where: { invoiceId: { in: invIds } } });
    await db.auditLog.deleteMany({
      where: { entityType: 'Invoice', entityId: { in: invIds } },
    });
    await db.invoiceLine.deleteMany({ where: { invoiceId: { in: invIds } } });
    await db.invoice.deleteMany({ where: { id: { in: invIds } } });
  }

  // SOs.
  const sos = await db.salesOrder.findMany({
    where: { customerId: { in: ids } },
    select: { id: true },
  });
  if (sos.length > 0) {
    const soIds = sos.map((s) => s.id);
    await db.auditLog.deleteMany({
      where: { entityType: 'SalesOrder', entityId: { in: soIds } },
    });
  }
  await db.salesOrderLine.deleteMany({
    where: { salesOrder: { customerId: { in: ids } } },
  });
  await db.salesOrder.deleteMany({ where: { customerId: { in: ids } } });

  const variantIds = (
    await db.productVariant.findMany({
      where: { sku: { startsWith: TAG } },
      select: { id: true },
    })
  ).map((v) => v.id);
  if (variantIds.length > 0) {
    const ourMovements = await db.inventoryMovement.findMany({
      where: { variantId: { in: variantIds } },
      select: { id: true },
    });
    if (ourMovements.length > 0) {
      await db.auditLog.deleteMany({
        where: {
          entityType: 'InventoryMovement',
          entityId: { in: ourMovements.map((m) => m.id) },
        },
      });
    }
    await db.inventoryMovement.deleteMany({ where: { variantId: { in: variantIds } } });
    await db.inventoryItem.deleteMany({ where: { variantId: { in: variantIds } } });
  }
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
