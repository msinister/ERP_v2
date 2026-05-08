import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AuditAction,
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
import { hasTenantDb, makeClient } from '../helpers/db';
import { upsertTestWarehouse } from '../helpers/warehouseStub';
import { wipeBillArtifactsForVendorCodePrefix } from '../helpers/wipeBillArtifacts';

const suite = hasTenantDb ? describe : describe.skip;

const TAG = 'TEST-COMM-R';

suite('Commission reversal — reversePayment integration', () => {
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
      name: 'Comm Reversal WH',
    });
    warehouseId = wh.id;
    const vend = await db.vendor.upsert({
      where: { code: `${TAG}-VEND` },
      create: { code: `${TAG}-VEND`, name: 'Reversal Vendor' },
      update: { active: true, deletedAt: null },
    });
    vendorId = vend.id;
    product = await db.product.upsert({
      where: { sku: `${TAG}-PROD` },
      create: {
        sku: `${TAG}-PROD`,
        name: 'Reversal Product',
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
    await db.salesRep.deleteMany({ where: { code: { startsWith: TAG } } });
    await db.productVariant.deleteMany({ where: { id: variant.id } });
    await db.product.deleteMany({ where: { id: product.id } });
    await db.warehouse.deleteMany({ where: { code: `${TAG}-WH` } });
    await db.vendor.deleteMany({ where: { id: vendorId } });
    await db.$disconnect();
  });

  async function newRep(
    suffix: string,
    opts: {
      enabled?: boolean;
      basis?: CommissionBasis | null;
      percent?: string | null;
    } = {},
  ): Promise<SalesRep> {
    return db.salesRep.create({
      data: {
        code: `${TAG}-${suffix}`,
        name: `Rep ${suffix}`,
        commissionEnabled: opts.enabled ?? true,
        commissionBasis: opts.basis === undefined ? CommissionBasis.REVENUE : opts.basis,
        commissionPercent:
          opts.percent === undefined
            ? new Prisma.Decimal('10')
            : opts.percent === null
              ? null
              : new Prisma.Decimal(opts.percent),
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

  async function makeInvoice(
    customerId: string,
    qty: string,
    unitPrice = '10',
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
    return db.invoice.findFirstOrThrow({ where: { salesOrderId: so.id } });
  }

  // ---------------------------------------------------------------------------
  // REVENUE reversal exact
  // ---------------------------------------------------------------------------

  it('REVENUE: full payment reversal writes negative mirror; original gets reversedAt', async () => {
    const rep = await newRep('R1', { basis: CommissionBasis.REVENUE, percent: '10' });
    const cust = await newCustomer('R1c', rep.id);
    const inv = await makeInvoice(cust.id, '5');
    const pmt = await recordPayment(db, {
      customerId: cust.id,
      method: PaymentMethod.CHECK,
      amount: '50',
      applications: [{ invoiceId: inv.id, amount: '50' }],
    });
    const orig = await db.commissionAccrual.findFirstOrThrow({
      where: { salesRepId: rep.id, reversedByPaymentId: null },
    });
    expect(orig.amount.toString()).toBe(new Prisma.Decimal('5').toString());
    expect(orig.reversedAt).toBeNull();

    await reversePayment(db, { paymentId: pmt.id, reason: 'NSF' });

    // Original now has reversedAt; mirror has negative amount.
    const after = await db.commissionAccrual.findUniqueOrThrow({
      where: { id: orig.id },
    });
    expect(after.reversedAt).not.toBeNull();
    expect(after.amount.toString()).toBe(new Prisma.Decimal('5').toString()); // unmodified
    expect(after.basisAmount.toString()).toBe(new Prisma.Decimal('50').toString());

    const mirror = await db.commissionAccrual.findFirstOrThrow({
      where: { salesRepId: rep.id, reversedByPaymentId: pmt.id },
    });
    expect(mirror.amount.toString()).toBe(new Prisma.Decimal('-5').toString());
    expect(mirror.basisAmount.toString()).toBe(new Prisma.Decimal('-50').toString());
    expect(mirror.percent.toString()).toBe(new Prisma.Decimal('10').toString());
    expect(mirror.basis).toBe(CommissionBasis.REVENUE);
    expect(mirror.invoiceId).toBe(inv.id);
    expect(mirror.paymentId).toBe(pmt.id);
    expect(mirror.reversedAt).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // MARGIN reversal exact
  // ---------------------------------------------------------------------------

  it('MARGIN: reversal mirrors basisAmount + amount; percent unchanged', async () => {
    const rep = await newRep('M1', { basis: CommissionBasis.MARGIN, percent: '20' });
    const cust = await newCustomer('M1c', rep.id);
    const inv = await makeInvoice(cust.id, '5'); // $50 / $20 cogs / margin $30
    const pmt = await recordPayment(db, {
      customerId: cust.id,
      method: PaymentMethod.CHECK,
      amount: '50',
      applications: [{ invoiceId: inv.id, amount: '50' }],
    });
    await reversePayment(db, { paymentId: pmt.id, reason: 'NSF' });
    const mirror = await db.commissionAccrual.findFirstOrThrow({
      where: { salesRepId: rep.id, reversedByPaymentId: pmt.id },
    });
    // Original was basisAmount=30, amount=6.
    expect(mirror.basisAmount.toString()).toBe(new Prisma.Decimal('-30').toString());
    expect(mirror.amount.toString()).toBe(new Prisma.Decimal('-6').toString());
    expect(mirror.percent.toString()).toBe(new Prisma.Decimal('20').toString());
  });

  // ---------------------------------------------------------------------------
  // Multi-invoice payment: every accrual gets a mirror
  // ---------------------------------------------------------------------------

  it('Multi-invoice payment reversal: one mirror per original accrual', async () => {
    const rep = await newRep('MI', { basis: CommissionBasis.REVENUE, percent: '10' });
    const cust = await newCustomer('MIc', rep.id);
    const inv1 = await makeInvoice(cust.id, '3');
    const inv2 = await makeInvoice(cust.id, '7');
    const pmt = await recordPayment(db, {
      customerId: cust.id,
      method: PaymentMethod.CHECK,
      amount: '100',
      applications: [
        { invoiceId: inv1.id, amount: '30' },
        { invoiceId: inv2.id, amount: '70' },
      ],
    });
    await reversePayment(db, { paymentId: pmt.id, reason: 'NSF' });
    const mirrors = await db.commissionAccrual.findMany({
      where: { salesRepId: rep.id, reversedByPaymentId: pmt.id },
    });
    expect(mirrors).toHaveLength(2);
    const sum = mirrors.reduce(
      (acc, m) => acc.plus(m.amount),
      new Prisma.Decimal(0),
    );
    expect(sum.toString()).toBe(new Prisma.Decimal('-10').toString());
  });

  // ---------------------------------------------------------------------------
  // Salaried rep had no accruals → no mirrors
  // ---------------------------------------------------------------------------

  it('Salaried rep payment reversal: no accruals to mirror, no error', async () => {
    const rep = await newRep('S1', {
      enabled: false,
      basis: CommissionBasis.REVENUE,
      percent: '10',
    });
    const cust = await newCustomer('S1c', rep.id);
    const inv = await makeInvoice(cust.id, '5');
    const pmt = await recordPayment(db, {
      customerId: cust.id,
      method: PaymentMethod.CHECK,
      amount: '50',
      applications: [{ invoiceId: inv.id, amount: '50' }],
    });
    // No throw.
    await reversePayment(db, { paymentId: pmt.id, reason: 'no commission' });
    const mirrors = await db.commissionAccrual.findMany({
      where: { reversedByPaymentId: pmt.id },
    });
    expect(mirrors).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Idempotency / no double-reverse
  // ---------------------------------------------------------------------------

  it('Already-reversed accruals are NOT mirrored again on a second reverse call', async () => {
    const rep = await newRep('ID', { basis: CommissionBasis.REVENUE, percent: '10' });
    const cust = await newCustomer('IDc', rep.id);
    const inv = await makeInvoice(cust.id, '5');
    const pmt = await recordPayment(db, {
      customerId: cust.id,
      method: PaymentMethod.CHECK,
      amount: '50',
      applications: [{ invoiceId: inv.id, amount: '50' }],
    });
    await reversePayment(db, { paymentId: pmt.id, reason: 'first' });
    // reversePayment refuses re-call once REVERSED — confirms upstream
    // guard already blocks. So commission reversal is implicitly
    // protected at the call site.
    await expect(
      reversePayment(db, { paymentId: pmt.id, reason: 'second' }),
    ).rejects.toThrow(/already REVERSED/);
    const mirrors = await db.commissionAccrual.findMany({
      where: { reversedByPaymentId: pmt.id },
    });
    expect(mirrors).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // Mirror rows are not themselves reversible
  // ---------------------------------------------------------------------------

  it('Mirror row reversedByPaymentId disqualifies it from being reversed in turn', async () => {
    const rep = await newRep('MR', { basis: CommissionBasis.REVENUE, percent: '10' });
    const cust = await newCustomer('MRc', rep.id);
    const inv = await makeInvoice(cust.id, '5');
    const pmt = await recordPayment(db, {
      customerId: cust.id,
      method: PaymentMethod.CHECK,
      amount: '50',
      applications: [{ invoiceId: inv.id, amount: '50' }],
    });
    await reversePayment(db, { paymentId: pmt.id, reason: 'r' });
    const mirror = await db.commissionAccrual.findFirstOrThrow({
      where: { reversedByPaymentId: pmt.id },
    });
    // Mirror rows have reversedByPaymentId set; the reversal helper
    // filters those out of the "live" set. Mirror's own reversedAt
    // stays NULL by construction.
    expect(mirror.reversedAt).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // APPLIED_CREDIT payment reversal: no commission mirrors
  // ---------------------------------------------------------------------------

  it('APPLIED_CREDIT payment reversal: no commission mirrors (Q1 — never accrued)', async () => {
    const rep = await newRep('AC', { basis: CommissionBasis.REVENUE, percent: '10' });
    const cust = await newCustomer('ACc', rep.id);
    const inv = await makeInvoice(cust.id, '5');
    // Seed CM credit balance.
    const returnCat = await db.creditMemoCategory.findFirstOrThrow({
      where: { code: 'RETURN' },
    });
    await db.creditMemo.create({
      data: {
        number: `${TAG}-CM-AC`,
        customerId: cust.id,
        invoiceId: inv.id,
        categoryId: returnCat.id,
        status: 'CONFIRMED',
        amount: new Prisma.Decimal('60'),
        restockingFee: new Prisma.Decimal('0'),
        netCredit: new Prisma.Decimal('60'),
        appliedAmount: new Prisma.Decimal('0'),
        issuedAt: new Date(),
      },
    });
    const pmt = await recordPayment(db, {
      customerId: cust.id,
      method: PaymentMethod.APPLIED_CREDIT,
      amount: '50',
      applications: [{ invoiceId: inv.id, amount: '50' }],
    });
    await reversePayment(db, { paymentId: pmt.id, reason: 'undo apply' });
    const mirrors = await db.commissionAccrual.findMany({
      where: { reversedByPaymentId: pmt.id },
    });
    expect(mirrors).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Audit
  // ---------------------------------------------------------------------------

  it('Reversal writes a REVERSE audit row per original accrual with mirror id pointer', async () => {
    const rep = await newRep('AU', { basis: CommissionBasis.REVENUE, percent: '10' });
    const cust = await newCustomer('AUc', rep.id);
    const inv = await makeInvoice(cust.id, '5');
    const pmt = await recordPayment(db, {
      customerId: cust.id,
      method: PaymentMethod.CHECK,
      amount: '50',
      applications: [{ invoiceId: inv.id, amount: '50' }],
    });
    const orig = await db.commissionAccrual.findFirstOrThrow({
      where: { salesRepId: rep.id, reversedByPaymentId: null },
    });
    await reversePayment(
      db,
      { paymentId: pmt.id, reason: 'r' },
      { userId: 'tester' },
    );
    const auditRows = await db.auditLog.findMany({
      where: {
        entityType: 'CommissionAccrual',
        entityId: orig.id,
        action: AuditAction.REVERSE,
      },
    });
    expect(auditRows).toHaveLength(1);
    const after = auditRows[0]!.afterJson as Record<string, unknown>;
    expect(after.triggeringPaymentId).toBe(pmt.id);
    expect(typeof after.mirrorAccrualId).toBe('string');
  });

  // ---------------------------------------------------------------------------
  // Multi-rep reversal — independent reps' accruals reverse independently
  // ---------------------------------------------------------------------------

  it('Two-rep scenario: reversing one rep\'s payment does not touch the other rep\'s accruals', async () => {
    const repA = await newRep('A1', { basis: CommissionBasis.REVENUE, percent: '10' });
    const repB = await newRep('B1', { basis: CommissionBasis.REVENUE, percent: '15' });
    const custA = await newCustomer('A1c', repA.id);
    const custB = await newCustomer('B1c', repB.id);
    const invA = await makeInvoice(custA.id, '5');
    const invB = await makeInvoice(custB.id, '5');
    const pmtA = await recordPayment(db, {
      customerId: custA.id,
      method: PaymentMethod.CHECK,
      amount: '50',
      applications: [{ invoiceId: invA.id, amount: '50' }],
    });
    await recordPayment(db, {
      customerId: custB.id,
      method: PaymentMethod.CHECK,
      amount: '50',
      applications: [{ invoiceId: invB.id, amount: '50' }],
    });
    await reversePayment(db, { paymentId: pmtA.id, reason: 'A reversal' });

    const aMirrors = await db.commissionAccrual.findMany({
      where: { salesRepId: repA.id, reversedByPaymentId: pmtA.id },
    });
    expect(aMirrors).toHaveLength(1);

    const bAccruals = await db.commissionAccrual.findMany({
      where: { salesRepId: repB.id },
    });
    // Rep B has only the original accrual, no mirrors.
    expect(bAccruals).toHaveLength(1);
    expect(bAccruals[0]!.reversedAt).toBeNull();
    expect(bAccruals[0]!.amount.toString()).toBe(
      new Prisma.Decimal('7.5').toString(),
    );
  });
});

async function wipe(db: PrismaClient): Promise<void> {
  // Phase 8: clear bills auto-drafted by postReceipt before any
  // variant/vendor cleanup hits BillLine RESTRICT FKs.
  await wipeBillArtifactsForVendorCodePrefix(db, TAG);

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
