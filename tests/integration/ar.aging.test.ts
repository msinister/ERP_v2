import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CreditMemoStatus,
  InvoiceStatus,
  PaymentMethod,
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
import {
  closeSalesOrder,
  confirmSalesOrder,
  createSalesOrder,
} from '@/server/services/salesOrders';
import { receiveInventory } from '@/server/services/movements';
import { recordPayment } from '@/server/services/payments';
import { voidInvoice } from '@/server/services/invoices';
import {
  agingForCustomer,
  agingSummary,
  arBalanceForCustomer,
} from '@/server/services/ar';
import { hasTenantDb, makeClient } from '../helpers/db';

const suite = hasTenantDb ? describe : describe.skip;

const TAG = 'TEST-ARAGE';

// Fixed asOf used across every test to keep bucket math deterministic.
// `Z` ensures UTC and avoids DST math drift.
const ASOF = new Date('2026-04-30T12:00:00.000Z');

function daysAgo(n: number): Date {
  return new Date(ASOF.getTime() - n * 24 * 60 * 60 * 1000);
}

suite('AR aging', () => {
  let db: PrismaClient;
  let salesRep: SalesRep;
  let net30: PaymentTerm;
  let codTerm: PaymentTerm;
  let warehouseId: string;
  let product: Product;
  let variant: ProductVariant;

  beforeAll(async () => {
    db = makeClient();
    salesRep = await db.salesRep.findFirstOrThrow({ where: { code: 'UNASSIGNED' } });
    net30 = await db.paymentTerm.findFirstOrThrow({ where: { code: 'NET30' } });
    // COD/Prepay: netDays === null. Provision-time seed includes one
    // already; if not, upsert one we own.
    codTerm = await db.paymentTerm.upsert({
      where: { code: `${TAG}-COD` },
      create: { code: `${TAG}-COD`, label: 'COD (test)', netDays: null },
      update: { netDays: null, active: true, deletedAt: null },
    });
    const wh = await db.warehouse.upsert({
      where: { code: `${TAG}-WH` },
      create: { code: `${TAG}-WH`, name: 'Aging WH' },
      update: { active: true, deletedAt: null },
    });
    warehouseId = wh.id;
    product = await db.product.upsert({
      where: { sku: `${TAG}-PROD` },
      create: { sku: `${TAG}-PROD`, name: 'Aging Product', basePrice: new Prisma.Decimal('1.00') },
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
    await db.paymentTerm.deleteMany({ where: { code: `${TAG}-COD` } });
    await db.$disconnect();
  });

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  async function newCustomer(suffix: string, paymentTermId: string): Promise<Customer> {
    return createCustomer(db, {
      name: `${TAG} ${suffix}`,
      salesRepId: salesRep.id,
      paymentTermId,
      billingAddress: {
        kind: 'BILLING',
        line1: '1 St',
        city: 'Dallas',
        region: 'TX',
        postalCode: '75201',
      },
    });
  }

  /**
   * Generate an invoice by going SO → confirm → close, then back-date
   * the invoiceDate to the requested age. Aging math reads invoiceDate.
   */
  async function makeInvoice(
    customerId: string,
    unitPrice: string,
    qty: string,
    daysAgoCount: number,
  ) {
    const so = await createSalesOrder(db, {
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
    await confirmSalesOrder(db, so.id);
    await closeSalesOrder(db, so.id, undefined);
    const inv = await db.invoice.findFirstOrThrow({ where: { salesOrderId: so.id } });
    return db.invoice.update({
      where: { id: inv.id },
      data: { invoiceDate: daysAgo(daysAgoCount) },
    });
  }

  // -------------------------------------------------------------------------
  // arBalanceForCustomer
  // -------------------------------------------------------------------------

  it('arBalanceForCustomer: 3 open invoices sum to AR balance, no unapplied', async () => {
    const c = await newCustomer('A1', net30.id);
    await makeInvoice(c.id, '1', '100', 5);
    await makeInvoice(c.id, '1', '200', 5);
    await makeInvoice(c.id, '1', '50', 5);
    const r = await arBalanceForCustomer(db, c.id, ASOF);
    expect(r.arBalance.toString()).toBe(new Prisma.Decimal('350').toString());
    expect(r.unappliedCreditBalance.toString()).toBe(new Prisma.Decimal('0').toString());
  });

  it('arBalanceForCustomer: paid invoice excluded', async () => {
    const c = await newCustomer('A2', net30.id);
    const inv = await makeInvoice(c.id, '1', '100', 5);
    await recordPayment(db, {
      customerId: c.id,
      method: PaymentMethod.CHECK,
      amount: '100',
      applications: [{ invoiceId: inv.id, amount: '100' }],
    });
    const fresh = await db.invoice.findUniqueOrThrow({ where: { id: inv.id } });
    expect(fresh.status).toBe(InvoiceStatus.PAID);
    const r = await arBalanceForCustomer(db, c.id, ASOF);
    expect(r.arBalance.toString()).toBe(new Prisma.Decimal('0').toString());
  });

  it('arBalanceForCustomer: voided invoice excluded', async () => {
    const c = await newCustomer('A3', net30.id);
    const inv = await makeInvoice(c.id, '1', '100', 5);
    await voidInvoice(db, inv.id, 'mistake');
    const r = await arBalanceForCustomer(db, c.id, ASOF);
    expect(r.arBalance.toString()).toBe(new Prisma.Decimal('0').toString());
  });

  it('arBalanceForCustomer: PARTIAL invoice contributes remaining balance', async () => {
    const c = await newCustomer('A4', net30.id);
    const inv = await makeInvoice(c.id, '1', '100', 5);
    await recordPayment(db, {
      customerId: c.id,
      method: PaymentMethod.CHECK,
      amount: '30',
      applications: [{ invoiceId: inv.id, amount: '30' }],
    });
    const fresh = await db.invoice.findUniqueOrThrow({ where: { id: inv.id } });
    expect(fresh.status).toBe(InvoiceStatus.PARTIAL);
    const r = await arBalanceForCustomer(db, c.id, ASOF);
    expect(r.arBalance.toString()).toBe(new Prisma.Decimal('70').toString());
  });

  it('arBalanceForCustomer: unapplied payment surfaces as unappliedCreditBalance, NOT negative AR', async () => {
    const c = await newCustomer('A5', net30.id);
    await recordPayment(db, {
      customerId: c.id,
      method: PaymentMethod.CHECK,
      amount: '50',
    });
    const r = await arBalanceForCustomer(db, c.id, ASOF);
    expect(r.arBalance.toString()).toBe(new Prisma.Decimal('0').toString());
    expect(r.unappliedCreditBalance.toString()).toBe(new Prisma.Decimal('50').toString());
  });

  it('arBalanceForCustomer: unapplied confirmed CM (no invoice link) surfaces as unappliedCreditBalance', async () => {
    const c = await newCustomer('A6', net30.id);
    const cat = await db.creditMemoCategory.findFirstOrThrow({ where: { code: 'GOODWILL' } });
    // Standalone CM (no invoiceId) — netCredit lands in unapplied bucket.
    const cm = await db.creditMemo.create({
      data: {
        number: `CM-TEST-${Date.now()}`,
        customerId: c.id,
        categoryId: cat.id,
        status: CreditMemoStatus.CONFIRMED,
        amount: new Prisma.Decimal('50'),
        restockingFee: new Prisma.Decimal('0'),
        netCredit: new Prisma.Decimal('50'),
        appliedAmount: new Prisma.Decimal('0'),
        issuedAt: ASOF,
        lines: {
          create: [
            {
              variantId: variant.id,
              qty: new Prisma.Decimal('5'),
              unitPrice: new Prisma.Decimal('10'),
              lineTotal: new Prisma.Decimal('50'),
              description: 'standalone',
            },
          ],
        },
      },
    });
    const r = await arBalanceForCustomer(db, c.id, ASOF);
    expect(r.arBalance.toString()).toBe(new Prisma.Decimal('0').toString());
    expect(r.unappliedCreditBalance.toString()).toBe(new Prisma.Decimal('50').toString());
    void cm;
  });

  it('arBalanceForCustomer: open invoice + unapplied payment are NOT netted (separate fields)', async () => {
    const c = await newCustomer('A7', net30.id);
    await makeInvoice(c.id, '1', '100', 5);
    await recordPayment(db, {
      customerId: c.id,
      method: PaymentMethod.CHECK,
      amount: '30',
    });
    const r = await arBalanceForCustomer(db, c.id, ASOF);
    expect(r.arBalance.toString()).toBe(new Prisma.Decimal('100').toString());
    expect(r.unappliedCreditBalance.toString()).toBe(new Prisma.Decimal('30').toString());
  });

  // -------------------------------------------------------------------------
  // agingForCustomer
  // -------------------------------------------------------------------------

  it('agingForCustomer (NET30): four invoices fall into four buckets correctly', async () => {
    const c = await newCustomer('B1', net30.id);
    // Invoice 100 days ago, $100 → daysPastDue = 100 - 30 = 70 → b61to90.
    await makeInvoice(c.id, '1', '100', 100);
    // Invoice 65 days ago, $200 → daysPastDue = 65 - 30 = 35 → b31to60.
    await makeInvoice(c.id, '1', '200', 65);
    // Invoice 35 days ago, $50 → daysPastDue = 35 - 30 = 5 → b1to30.
    await makeInvoice(c.id, '1', '50', 35);
    // Invoice 10 days ago, $25 → daysPastDue = 10 - 30 = -20 → current.
    await makeInvoice(c.id, '1', '25', 10);

    const r = await agingForCustomer(db, c.id, ASOF);
    expect(r.buckets.current.toString()).toBe(new Prisma.Decimal('25').toString());
    expect(r.buckets.b1to30.toString()).toBe(new Prisma.Decimal('50').toString());
    expect(r.buckets.b31to60.toString()).toBe(new Prisma.Decimal('200').toString());
    expect(r.buckets.b61to90.toString()).toBe(new Prisma.Decimal('100').toString());
    expect(r.buckets.b91plus.toString()).toBe(new Prisma.Decimal('0').toString());
    expect(r.total.toString()).toBe(new Prisma.Decimal('375').toString());
  });

  it('agingForCustomer: 91+ bucket', async () => {
    const c = await newCustomer('B2', net30.id);
    // 122 days ago, $100 → daysPastDue = 92 → b91plus.
    await makeInvoice(c.id, '1', '100', 122);
    const r = await agingForCustomer(db, c.id, ASOF);
    expect(r.buckets.b91plus.toString()).toBe(new Prisma.Decimal('100').toString());
  });

  it('agingForCustomer (COD, netDays=null): invoice 5 days ago lands in b1to30 (due immediately)', async () => {
    const c = await newCustomer('B3', codTerm.id);
    await makeInvoice(c.id, '1', '100', 5);
    const r = await agingForCustomer(db, c.id, ASOF);
    expect(r.buckets.b1to30.toString()).toBe(new Prisma.Decimal('100').toString());
    expect(r.invoices[0].daysPastDue).toBe(5);
  });

  it('agingForCustomer: paid invoice (no balance) excluded from invoices array', async () => {
    const c = await newCustomer('B4', net30.id);
    const inv = await makeInvoice(c.id, '1', '100', 5);
    await recordPayment(db, {
      customerId: c.id,
      method: PaymentMethod.CHECK,
      amount: '100',
      applications: [{ invoiceId: inv.id, amount: '100' }],
    });
    const r = await agingForCustomer(db, c.id, ASOF);
    expect(r.invoices).toHaveLength(0);
    expect(r.total.toString()).toBe(new Prisma.Decimal('0').toString());
  });

  it('agingForCustomer: voided invoice excluded', async () => {
    const c = await newCustomer('B5', net30.id);
    const inv = await makeInvoice(c.id, '1', '100', 5);
    await voidInvoice(db, inv.id, 'mistake');
    const r = await agingForCustomer(db, c.id, ASOF);
    expect(r.invoices).toHaveLength(0);
  });

  it('agingForCustomer: invoices sorted by daysPastDue DESC', async () => {
    const c = await newCustomer('B6', net30.id);
    await makeInvoice(c.id, '1', '10', 10);
    await makeInvoice(c.id, '1', '10', 100);
    await makeInvoice(c.id, '1', '10', 50);
    const r = await agingForCustomer(db, c.id, ASOF);
    expect(r.invoices.map((i) => i.daysPastDue)).toEqual([70, 20, -20]);
  });

  it('agingForCustomer asOf: shifting asOf 30 days earlier shifts buckets', async () => {
    const c = await newCustomer('B7', net30.id);
    // Invoice 65 days before ASOF, $100. NET30 → due 35 days before ASOF.
    await makeInvoice(c.id, '1', '100', 65);
    // At ASOF: daysPastDue = 35 → b31to60.
    const now = await agingForCustomer(db, c.id, ASOF);
    expect(now.buckets.b31to60.toString()).toBe(new Prisma.Decimal('100').toString());
    // 30 days earlier: daysPastDue = 5 → b1to30.
    const earlier = new Date(ASOF.getTime() - 30 * 24 * 60 * 60 * 1000);
    const before = await agingForCustomer(db, c.id, earlier);
    expect(before.buckets.b1to30.toString()).toBe(new Prisma.Decimal('100').toString());
    expect(before.buckets.b31to60.toString()).toBe(new Prisma.Decimal('0').toString());
  });

  // -------------------------------------------------------------------------
  // Bucket boundary cases (CRITICAL #1)
  // -------------------------------------------------------------------------

  it('bucket boundary: daysPastDue=0 → b1to30 (due today)', async () => {
    const c = await newCustomer('BD0', net30.id);
    // Invoice 30 days ago on NET30 → dueDate = ASOF, daysPastDue=0.
    await makeInvoice(c.id, '1', '100', 30);
    const r = await agingForCustomer(db, c.id, ASOF);
    expect(r.invoices[0].daysPastDue).toBe(0);
    expect(r.invoices[0].bucket).toBe('b1to30');
  });

  it('bucket boundary: daysPastDue=30 → b1to30', async () => {
    const c = await newCustomer('BD30', net30.id);
    // Invoice 60 days ago on NET30 → daysPastDue=30.
    await makeInvoice(c.id, '1', '100', 60);
    const r = await agingForCustomer(db, c.id, ASOF);
    expect(r.invoices[0].daysPastDue).toBe(30);
    expect(r.invoices[0].bucket).toBe('b1to30');
  });

  it('bucket boundary: daysPastDue=31 → b31to60', async () => {
    const c = await newCustomer('BD31', net30.id);
    // Invoice 61 days ago on NET30 → daysPastDue=31.
    await makeInvoice(c.id, '1', '100', 61);
    const r = await agingForCustomer(db, c.id, ASOF);
    expect(r.invoices[0].daysPastDue).toBe(31);
    expect(r.invoices[0].bucket).toBe('b31to60');
  });

  it('bucket boundary: daysPastDue=60 → b31to60, 61 → b61to90', async () => {
    const c60 = await newCustomer('BD60', net30.id);
    await makeInvoice(c60.id, '1', '100', 90); // 90 - 30 = 60
    expect((await agingForCustomer(db, c60.id, ASOF)).invoices[0].bucket).toBe('b31to60');

    const c61 = await newCustomer('BD61', net30.id);
    await makeInvoice(c61.id, '1', '100', 91); // 91 - 30 = 61
    expect((await agingForCustomer(db, c61.id, ASOF)).invoices[0].bucket).toBe('b61to90');
  });

  it('bucket boundary: daysPastDue=90 → b61to90, 91 → b91plus', async () => {
    const c90 = await newCustomer('BD90', net30.id);
    await makeInvoice(c90.id, '1', '100', 120); // 120 - 30 = 90
    expect((await agingForCustomer(db, c90.id, ASOF)).invoices[0].bucket).toBe('b61to90');

    const c91 = await newCustomer('BD91', net30.id);
    await makeInvoice(c91.id, '1', '100', 121); // 121 - 30 = 91
    expect((await agingForCustomer(db, c91.id, ASOF)).invoices[0].bucket).toBe('b91plus');
  });

  it('bucket boundary: daysPastDue=-1 → current (not yet due)', async () => {
    const c = await newCustomer('BDneg', net30.id);
    // Invoice 29 days ago on NET30 → daysPastDue=-1.
    await makeInvoice(c.id, '1', '100', 29);
    const r = await agingForCustomer(db, c.id, ASOF);
    expect(r.invoices[0].daysPastDue).toBe(-1);
    expect(r.invoices[0].bucket).toBe('current');
  });

  // -------------------------------------------------------------------------
  // agingSummary
  // -------------------------------------------------------------------------

  it('agingSummary: one row per customer with open invoices, sorted by total DESC', async () => {
    const c1 = await newCustomer('S1', net30.id);
    const c2 = await newCustomer('S2', net30.id);
    const c3 = await newCustomer('S3', net30.id);
    await makeInvoice(c1.id, '1', '100', 50);
    await makeInvoice(c2.id, '1', '500', 5); // not yet due, current
    await makeInvoice(c3.id, '1', '250', 65); // 65 - 30 = 35 → b31to60

    const rows = await agingSummary(db, ASOF);
    const ours = rows.filter((r) => r.customerName.startsWith(TAG));
    expect(ours).toHaveLength(3);
    // sorted by total DESC
    expect(ours[0].customerId).toBe(c2.id);
    expect(ours[1].customerId).toBe(c3.id);
    expect(ours[2].customerId).toBe(c1.id);
    expect(ours[0].current.toString()).toBe(new Prisma.Decimal('500').toString());
    expect(ours[1].b31to60.toString()).toBe(new Prisma.Decimal('250').toString());
    expect(ours[2].b1to30.toString()).toBe(new Prisma.Decimal('100').toString());
  });

  it('agingSummary: customer with no open invoices excluded', async () => {
    const c1 = await newCustomer('SX1', net30.id);
    const c2 = await newCustomer('SX2', net30.id);
    // c1 has an open invoice; c2 has nothing.
    await makeInvoice(c1.id, '1', '100', 5);
    void c2;
    const rows = await agingSummary(db, ASOF);
    const ours = rows.filter((r) => r.customerName.startsWith(`${TAG} SX`));
    expect(ours).toHaveLength(1);
    expect(ours[0].customerId).toBe(c1.id);
  });

  it('agingSummary: includes unappliedCreditBalance per customer', async () => {
    const c = await newCustomer('SU1', net30.id);
    await makeInvoice(c.id, '1', '100', 5);
    await recordPayment(db, {
      customerId: c.id,
      method: PaymentMethod.CHECK,
      amount: '40',
    });
    const rows = await agingSummary(db, ASOF);
    const row = rows.find((r) => r.customerId === c.id);
    expect(row).toBeDefined();
    expect(row!.unappliedCreditBalance.toString()).toBe(new Prisma.Decimal('40').toString());
    expect(row!.total.toString()).toBe(new Prisma.Decimal('100').toString());
  });

  it('agingSummary pagination: limit + offset', async () => {
    const customers = [];
    for (let i = 0; i < 5; i++) {
      const c = await newCustomer(`P${i}`, net30.id);
      await makeInvoice(c.id, '1', String((5 - i) * 100), 5);
      customers.push(c);
    }
    const rows = await agingSummary(db, ASOF, { limit: 2, offset: 0 });
    const oursPage1 = rows.filter((r) => r.customerName.startsWith(`${TAG} P`));
    expect(oursPage1).toHaveLength(2);
    // Highest balances first: P0 ($500), P1 ($400).
    expect(oursPage1[0].total.toString()).toBe(new Prisma.Decimal('500').toString());
    expect(oursPage1[1].total.toString()).toBe(new Prisma.Decimal('400').toString());

    const rows2 = await agingSummary(db, ASOF, { limit: 2, offset: 2 });
    const oursPage2 = rows2.filter((r) => r.customerName.startsWith(`${TAG} P`));
    expect(oursPage2).toHaveLength(2);
    expect(oursPage2[0].total.toString()).toBe(new Prisma.Decimal('300').toString());
    expect(oursPage2[1].total.toString()).toBe(new Prisma.Decimal('200').toString());
  });

  it('agingSummary: sanity perf check — 100 invoices across 10 customers under 1s', async () => {
    const customers = [];
    for (let i = 0; i < 10; i++) {
      customers.push(await newCustomer(`PERF${i}`, net30.id));
    }
    // 10 invoices per customer = 100 total.
    for (const c of customers) {
      for (let j = 0; j < 10; j++) {
        await makeInvoice(c.id, '1', '10', 5 + j * 7);
      }
    }
    const start = Date.now();
    const rows = await agingSummary(db, ASOF);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(1000);
    const ours = rows.filter((r) => r.customerName.startsWith(`${TAG} PERF`));
    expect(ours).toHaveLength(10);
  });
});

async function wipe(db: PrismaClient): Promise<void> {
  const customers = await db.customer.findMany({
    where: { name: { startsWith: TAG } },
    select: { id: true },
  });
  const ids = customers.map((c) => c.id);
  if (ids.length === 0) return;

  // CMs first (FK to Invoice + CreditApplication).
  const cms = await db.creditMemo.findMany({
    where: { customerId: { in: ids } },
    select: { id: true },
  });
  if (cms.length > 0) {
    const cmIds = cms.map((c) => c.id);
    const cmJes = await db.journalEntry.findMany({
      where: { entityType: 'CreditMemo', entityId: { in: cmIds } },
      select: { id: true },
    });
    if (cmJes.length > 0) {
      const jeIds = cmJes.map((j) => j.id);
      await db.journalEntryLine.deleteMany({ where: { journalEntryId: { in: jeIds } } });
      await db.journalEntry.deleteMany({ where: { id: { in: jeIds } } });
    }
    await db.creditApplication.deleteMany({ where: { creditMemoId: { in: cmIds } } });
    await db.creditMemoLine.deleteMany({ where: { creditMemoId: { in: cmIds } } });
    await db.auditLog.deleteMany({
      where: { entityType: 'CreditMemo', entityId: { in: cmIds } },
    });
    await db.creditMemo.deleteMany({ where: { id: { in: cmIds } } });
  }

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
  await db.customerActivity.deleteMany({ where: { customerId: { in: ids } } });
  await db.customerAddress.deleteMany({ where: { customerId: { in: ids } } });
  await db.auditLog.deleteMany({
    where: { entityType: 'Customer', entityId: { in: ids } },
  });
  await db.auditLog.deleteMany({ where: { entityType: 'CustomerAddress' } });
  await db.customer.deleteMany({ where: { id: { in: ids } } });
}
