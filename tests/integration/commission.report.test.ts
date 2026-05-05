import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CommissionBasis,
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
import {
  createDraftReceipt,
  postReceipt,
} from '@/server/services/receipts';
import { recordPayment, reversePayment } from '@/server/services/payments';
import { getCommissionReport } from '@/server/services/commission';
import { setSetting } from '@/server/services/settings';
import {
  SETTING_KEYS,
  commissionPayoutCycleValueSchema,
} from '@/lib/validation/settings';
import { hasTenantDb, makeClient } from '../helpers/db';
import { upsertTestWarehouse } from '../helpers/warehouseStub';

const suite = hasTenantDb ? describe : describe.skip;

const TAG = 'TEST-COMM-RPT';

suite('Commission report — getCommissionReport', () => {
  let db: PrismaClient;
  let term: PaymentTerm;
  let warehouseId: string;
  let vendorId: string;
  let product: Product;
  let variant: ProductVariant;

  beforeAll(async () => {
    db = makeClient();
    term = await db.paymentTerm.findFirstOrThrow({ where: { code: 'NET30' } });
    const wh = await upsertTestWarehouse(db, {
      code: `${TAG}-WH`,
      name: 'Comm Report WH',
    });
    warehouseId = wh.id;
    const vend = await db.vendor.upsert({
      where: { code: `${TAG}-VEND` },
      create: { code: `${TAG}-VEND`, name: 'Report Vendor' },
      update: { active: true, deletedAt: null },
    });
    vendorId = vend.id;
    product = await db.product.upsert({
      where: { sku: `${TAG}-PROD` },
      create: {
        sku: `${TAG}-PROD`,
        name: 'Report Product',
        basePrice: new Prisma.Decimal('10.00'),
      },
      update: {
        active: true,
        deletedAt: null,
        basePrice: new Prisma.Decimal('10.00'),
      },
    });
    variant = await db.productVariant.upsert({
      where: { sku: `${TAG}-V` },
      create: { productId: product.id, sku: `${TAG}-V`, name: 'V' },
      update: { productId: product.id, active: true, deletedAt: null },
    });
  });

  beforeEach(async () => {
    await wipe(db);
    // Wipe payout-cycle setting between tests so each test sets its own.
    const cycleRow = await db.setting.findUnique({
      where: { key: SETTING_KEYS.COMMISSION_PAYOUT_CYCLE },
    });
    if (cycleRow) {
      await db.auditLog.deleteMany({
        where: { entityType: 'Setting', entityId: cycleRow.id },
      });
      await db.setting.delete({ where: { id: cycleRow.id } });
    }
    const draft = await createDraftReceipt(db, {
      vendorId,
      warehouseId,
      lines: [
        {
          variantId: variant.id,
          warehouseId,
          qtyReceived: '100000',
          unitCost: '4',
        },
      ],
    });
    await postReceipt(db, draft.id);
  });

  afterAll(async () => {
    await wipe(db);
    const cycleRow = await db.setting.findUnique({
      where: { key: SETTING_KEYS.COMMISSION_PAYOUT_CYCLE },
    });
    if (cycleRow) {
      await db.auditLog.deleteMany({
        where: { entityType: 'Setting', entityId: cycleRow.id },
      });
      await db.setting.delete({ where: { id: cycleRow.id } });
    }
    await db.salesRep.deleteMany({ where: { code: { startsWith: TAG } } });
    await db.productVariant.deleteMany({ where: { id: variant.id } });
    await db.product.deleteMany({ where: { id: product.id } });
    await db.warehouse.deleteMany({ where: { code: `${TAG}-WH` } });
    await db.vendor.deleteMany({ where: { id: vendorId } });
    await db.$disconnect();
  });

  async function newRep(suffix: string, percent = '10'): Promise<SalesRep> {
    return db.salesRep.create({
      data: {
        code: `${TAG}-${suffix}`,
        name: `Rep ${suffix}`,
        commissionEnabled: true,
        commissionBasis: CommissionBasis.REVENUE,
        commissionPercent: new Prisma.Decimal(percent),
      },
    });
  }

  async function newCustomer(suffix: string, repId: string): Promise<Customer> {
    return createCustomer(db, {
      name: `${TAG} Cust ${suffix}`,
      salesRepId: repId,
      paymentTermId: term.id,
      billingAddress: {
        kind: 'BILLING',
        line1: '1 St',
        city: 'Dallas',
        region: 'TX',
        postalCode: '75201',
      },
    });
  }

  async function payInvoiceFor(
    customerId: string,
    qty: string,
    backdateAccrualDays?: number,
  ) {
    const so = await createSalesOrder(db, {
      customerId,
      warehouseId,
      lines: [
        {
          variantId: variant.id,
          warehouseId,
          qtyOrdered: qty,
          manualUnitPrice: '10',
        },
      ],
    });
    await confirmSalesOrder(db, so.id);
    await closeSalesOrder(db, so.id, undefined);
    const inv = await db.invoice.findFirstOrThrow({ where: { salesOrderId: so.id } });
    const amount = new Prisma.Decimal(qty).times(10).toString();
    const pmt = await recordPayment(db, {
      customerId,
      method: PaymentMethod.CHECK,
      amount,
      applications: [{ invoiceId: inv.id, amount }],
    });
    if (backdateAccrualDays != null) {
      const newDate = new Date(
        Date.now() - backdateAccrualDays * 24 * 60 * 60 * 1000,
      );
      await db.commissionAccrual.updateMany({
        where: { paymentId: pmt.id },
        data: { accruedAt: newDate },
      });
    }
    return { invoiceId: inv.id, paymentId: pmt.id };
  }

  // ---------------------------------------------------------------------------
  // Setting missing → graceful no-op (everything earned)
  // ---------------------------------------------------------------------------

  it('No payout-cycle setting → all positive accruals counted as earned', async () => {
    const rep = await newRep('NS', '10');
    const cust = await newCustomer('NSc', rep.id);
    await payInvoiceFor(cust.id, '5');
    const rows = await getCommissionReport(db, { salesRepId: rep.id });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.earned.toString()).toBe(new Prisma.Decimal('5').toString());
    expect(rows[0]!.pending.toString()).toBe(new Prisma.Decimal('0').toString());
    expect(rows[0]!.reversed.toString()).toBe(new Prisma.Decimal('0').toString());
    expect(rows[0]!.net.toString()).toBe(new Prisma.Decimal('5').toString());
  });

  // ---------------------------------------------------------------------------
  // Reversed column
  // ---------------------------------------------------------------------------

  it('Reversed payment: original in earned (or pending), mirror in reversed; net=0', async () => {
    const rep = await newRep('RV', '10');
    const cust = await newCustomer('RVc', rep.id);
    const { paymentId } = await payInvoiceFor(cust.id, '5');
    await reversePayment(db, { paymentId, reason: 'NSF' });
    const rows = await getCommissionReport(db, { salesRepId: rep.id });
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.earned.toString()).toBe(new Prisma.Decimal('5').toString());
    expect(r.reversed.toString()).toBe(new Prisma.Decimal('-5').toString());
    expect(r.net.toString()).toBe(new Prisma.Decimal('0').toString());
  });

  // ---------------------------------------------------------------------------
  // Salesrep filter
  // ---------------------------------------------------------------------------

  it('salesRepId filter scopes the report to one rep', async () => {
    const repA = await newRep('A', '10');
    const repB = await newRep('B', '15');
    const custA = await newCustomer('Ac', repA.id);
    const custB = await newCustomer('Bc', repB.id);
    await payInvoiceFor(custA.id, '5'); // $5 commission
    await payInvoiceFor(custB.id, '5'); // $7.5 commission
    const rowsAll = await getCommissionReport(db, {});
    expect(rowsAll.length).toBeGreaterThanOrEqual(2);
    const justA = await getCommissionReport(db, { salesRepId: repA.id });
    expect(justA).toHaveLength(1);
    expect(justA[0]!.salesRepId).toBe(repA.id);
    expect(justA[0]!.earned.toString()).toBe(new Prisma.Decimal('5').toString());
  });

  // ---------------------------------------------------------------------------
  // Date range filter (accruedAt-based)
  // ---------------------------------------------------------------------------

  it('Date range from..to is applied before earned/pending split', async () => {
    const rep = await newRep('DR', '10');
    const cust = await newCustomer('DRc', rep.id);
    await payInvoiceFor(cust.id, '3', 60); // 60 days ago, $3
    await payInvoiceFor(cust.id, '7'); // today, $7
    // Window of last 30 days only catches the recent one.
    const from = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const to = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const rows = await getCommissionReport(db, {
      salesRepId: rep.id,
      from,
      to,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.net.toString()).toBe(new Prisma.Decimal('7').toString());
  });

  // ---------------------------------------------------------------------------
  // Reps with no accruals are omitted entirely
  // ---------------------------------------------------------------------------

  it('Reps with no accruals do not appear in the report', async () => {
    const rep1 = await newRep('NA1', '10');
    const rep2 = await newRep('NA2', '10');
    const cust1 = await newCustomer('NA1c', rep1.id);
    await payInvoiceFor(cust1.id, '5');
    const rows = await getCommissionReport(db, {});
    const ourRows = rows.filter((r) => r.salesRepCode.startsWith(TAG));
    expect(ourRows).toHaveLength(1);
    expect(ourRows[0]!.salesRepId).toBe(rep1.id);
    void rep2;
  });

  // ---------------------------------------------------------------------------
  // MONTHLY cycle: accrual today is pending; older accrual is earned
  // ---------------------------------------------------------------------------

  it('MONTHLY cycle: accrual after most recent anchor day → pending; before → earned', async () => {
    // Anchor day 1 of every month → open cycle starts on the 1st of
    // current month. Today's accrual is pending, ~60-days-ago is earned.
    await setSetting(
      db,
      SETTING_KEYS.COMMISSION_PAYOUT_CYCLE,
      { kind: 'MONTHLY', anchorDay: 1 },
      commissionPayoutCycleValueSchema,
    );
    const rep = await newRep('MC', '10');
    const cust = await newCustomer('MCc', rep.id);
    await payInvoiceFor(cust.id, '3', 60); // ~60 days ago → earned
    await payInvoiceFor(cust.id, '7'); // today → pending
    const rows = await getCommissionReport(db, { salesRepId: rep.id });
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.earned.toString()).toBe(new Prisma.Decimal('3').toString());
    expect(r.pending.toString()).toBe(new Prisma.Decimal('7').toString());
    expect(r.net.toString()).toBe(new Prisma.Decimal('10').toString());
  });

  // ---------------------------------------------------------------------------
  // Corrupt setting → graceful no-op
  // ---------------------------------------------------------------------------

  it('Corrupt payout-cycle setting → graceful no-op (everything earned)', async () => {
    await db.setting.create({
      data: {
        key: SETTING_KEYS.COMMISSION_PAYOUT_CYCLE,
        value: { kind: 'NOT_A_REAL_KIND' },
      },
    });
    const rep = await newRep('CR', '10');
    const cust = await newCustomer('CRc', rep.id);
    await payInvoiceFor(cust.id, '5');
    const rows = await getCommissionReport(db, { salesRepId: rep.id });
    expect(rows[0]!.earned.toString()).toBe(new Prisma.Decimal('5').toString());
    expect(rows[0]!.pending.toString()).toBe(new Prisma.Decimal('0').toString());
  });

  // ---------------------------------------------------------------------------
  // Sorted by salesRepCode
  // ---------------------------------------------------------------------------

  it('Rows sorted by salesRepCode ascending', async () => {
    const repZ = await newRep('Z', '10');
    const repA = await newRep('AAA', '10');
    const repM = await newRep('MMM', '10');
    const cZ = await newCustomer('Zc', repZ.id);
    const cA = await newCustomer('Ac', repA.id);
    const cM = await newCustomer('Mc', repM.id);
    await payInvoiceFor(cZ.id, '5');
    await payInvoiceFor(cA.id, '5');
    await payInvoiceFor(cM.id, '5');
    const rows = (await getCommissionReport(db, {})).filter((r) =>
      r.salesRepCode.startsWith(TAG),
    );
    expect(rows.map((r) => r.salesRepCode)).toEqual([
      `${TAG}-AAA`,
      `${TAG}-MMM`,
      `${TAG}-Z`,
    ]);
  });

  // ---------------------------------------------------------------------------
  // Decimal precision
  // ---------------------------------------------------------------------------

  it('Decimal precision preserved across aggregation', async () => {
    const rep = await newRep('DP', '7.5');
    const cust = await newCustomer('DPc', rep.id);
    // 3 × $11.11 = $33.33; commission 33.33 × 7.5% = 2.49975.
    const so = await createSalesOrder(db, {
      customerId: cust.id,
      warehouseId,
      lines: [
        {
          variantId: variant.id,
          warehouseId,
          qtyOrdered: '3',
          manualUnitPrice: '11.11',
        },
      ],
    });
    await confirmSalesOrder(db, so.id);
    await closeSalesOrder(db, so.id, undefined);
    const inv = await db.invoice.findFirstOrThrow({ where: { salesOrderId: so.id } });
    await recordPayment(db, {
      customerId: cust.id,
      method: PaymentMethod.CHECK,
      amount: '33.33',
      applications: [{ invoiceId: inv.id, amount: '33.33' }],
    });
    const rows = await getCommissionReport(db, { salesRepId: rep.id });
    expect(rows[0]!.net.toString()).toBe(new Prisma.Decimal('2.49975').toString());
  });
});

async function wipe(db: PrismaClient): Promise<void> {
  const accruals = await db.commissionAccrual.findMany({
    where: { salesRep: { code: { startsWith: TAG } } },
    select: { id: true },
  });
  if (accruals.length > 0) {
    const ids = accruals.map((a) => a.id);
    await db.auditLog.deleteMany({
      where: { entityType: 'CommissionAccrual', entityId: { in: ids } },
    });
    await db.commissionAccrual.deleteMany({ where: { id: { in: ids } } });
  }

  const customers = await db.customer.findMany({
    where: { name: { startsWith: TAG } },
    select: { id: true },
  });
  const ids = customers.map((c) => c.id);
  if (ids.length === 0) return;

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
    const receipts = await db.receipt.findMany({
      where: { lines: { some: { variantId: { in: variantIds } } } },
      select: { id: true },
    });
    if (receipts.length > 0) {
      const rIds = receipts.map((r) => r.id);
      const rJes = await db.journalEntry.findMany({
        where: { entityType: 'Receipt', entityId: { in: rIds } },
        select: { id: true },
      });
      if (rJes.length > 0) {
        const jeIds = rJes.map((j) => j.id);
        await db.journalEntryLine.deleteMany({ where: { journalEntryId: { in: jeIds } } });
        await db.journalEntry.deleteMany({ where: { id: { in: jeIds } } });
      }
      await db.auditLog.deleteMany({
        where: { entityType: 'Receipt', entityId: { in: rIds } },
      });
      await db.receiptLine.deleteMany({ where: { receiptId: { in: rIds } } });
      await db.receipt.deleteMany({ where: { id: { in: rIds } } });
    }
    const ourMovements = await db.inventoryMovement.findMany({
      where: { variantId: { in: variantIds } },
      select: { id: true },
    });
    if (ourMovements.length > 0) {
      const mvIds = ourMovements.map((m) => m.id);
      await db.auditLog.deleteMany({
        where: { entityType: 'InventoryMovement', entityId: { in: mvIds } },
      });
    }
    await db.fifoConsumption.deleteMany({
      where: { layer: { variantId: { in: variantIds } } },
    });
    await db.fifoLayer.deleteMany({ where: { variantId: { in: variantIds } } });
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
