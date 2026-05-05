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
import { recordPayment } from '@/server/services/payments';
import { hasTenantDb, makeClient } from '../helpers/db';
import { upsertTestWarehouse } from '../helpers/warehouseStub';

const suite = hasTenantDb ? describe : describe.skip;

const TAG = 'TEST-COMM-A';

suite('Commission accrual — recordPayment integration', () => {
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
      name: 'Comm Accrual WH',
    });
    warehouseId = wh.id;
    const vend = await db.vendor.upsert({
      where: { code: `${TAG}-VEND` },
      create: { code: `${TAG}-VEND`, name: 'Comm Vendor' },
      update: { active: true, deletedAt: null },
    });
    vendorId = vend.id;
    product = await db.product.upsert({
      where: { sku: `${TAG}-PROD` },
      create: {
        sku: `${TAG}-PROD`,
        name: 'Comm Product',
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
    // Stock the bin via a real Receipt → postReceipt → FifoLayer
    // creation path so MARGIN tests pull a known $4 unit cost
    // through consume → FifoConsumption → cogsAtClose.
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

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

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
  ): Promise<{ id: string; subtotal: Prisma.Decimal; cogsAtClose: Prisma.Decimal | null }> {
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
    const inv = await db.invoice.findFirstOrThrow({
      where: { salesOrderId: so.id },
      select: { id: true, subtotal: true, cogsAtClose: true },
    });
    return inv;
  }

  // ---------------------------------------------------------------------------
  // REVENUE basis
  // ---------------------------------------------------------------------------

  it('REVENUE basis: full payment accrues amount = applied × percent / 100', async () => {
    const rep = await newRep('R1', {
      basis: CommissionBasis.REVENUE,
      percent: '10',
    });
    const cust = await newCustomer('C1', rep.id);
    const inv = await makeInvoice(cust.id, '5'); // 5 × $10 = $50

    await recordPayment(db, {
      customerId: cust.id,
      method: PaymentMethod.CHECK,
      amount: '50',
      applications: [{ invoiceId: inv.id, amount: '50' }],
    });

    const accruals = await db.commissionAccrual.findMany({
      where: { salesRepId: rep.id },
    });
    expect(accruals).toHaveLength(1);
    const a = accruals[0]!;
    expect(a.basis).toBe(CommissionBasis.REVENUE);
    expect(a.basisAmount.toString()).toBe(new Prisma.Decimal('50').toString());
    expect(a.percent.toString()).toBe(new Prisma.Decimal('10').toString());
    expect(a.amount.toString()).toBe(new Prisma.Decimal('5').toString());
    expect(a.invoiceId).toBe(inv.id);
    expect(a.reversedAt).toBeNull();
    expect(a.reversedByPaymentId).toBeNull();
  });

  it('REVENUE basis: partial payment accrues proportional', async () => {
    const rep = await newRep('R2', {
      basis: CommissionBasis.REVENUE,
      percent: '10',
    });
    const cust = await newCustomer('C2', rep.id);
    const inv = await makeInvoice(cust.id, '5'); // $50 invoice

    await recordPayment(db, {
      customerId: cust.id,
      method: PaymentMethod.CHECK,
      amount: '20',
      applications: [{ invoiceId: inv.id, amount: '20' }],
    });

    const a = await db.commissionAccrual.findFirstOrThrow({
      where: { salesRepId: rep.id },
    });
    // 20 × 10% = 2.
    expect(a.basisAmount.toString()).toBe(new Prisma.Decimal('20').toString());
    expect(a.amount.toString()).toBe(new Prisma.Decimal('2').toString());
  });

  it('Multi-invoice payment writes one accrual per application', async () => {
    const rep = await newRep('R3', {
      basis: CommissionBasis.REVENUE,
      percent: '10',
    });
    const cust = await newCustomer('C3', rep.id);
    const inv1 = await makeInvoice(cust.id, '3'); // $30
    const inv2 = await makeInvoice(cust.id, '7'); // $70

    await recordPayment(db, {
      customerId: cust.id,
      method: PaymentMethod.CHECK,
      amount: '100',
      applications: [
        { invoiceId: inv1.id, amount: '30' },
        { invoiceId: inv2.id, amount: '70' },
      ],
    });

    const accruals = await db.commissionAccrual.findMany({
      where: { salesRepId: rep.id },
      orderBy: { amount: 'asc' },
    });
    expect(accruals).toHaveLength(2);
    expect(accruals[0]!.invoiceId).toBe(inv1.id);
    expect(accruals[0]!.amount.toString()).toBe(new Prisma.Decimal('3').toString());
    expect(accruals[1]!.invoiceId).toBe(inv2.id);
    expect(accruals[1]!.amount.toString()).toBe(new Prisma.Decimal('7').toString());
  });

  // ---------------------------------------------------------------------------
  // MARGIN basis
  // ---------------------------------------------------------------------------

  it('MARGIN basis: full payment accrues (applied − propCogs) × percent / 100', async () => {
    const rep = await newRep('M1', {
      basis: CommissionBasis.MARGIN,
      percent: '20',
    });
    const cust = await newCustomer('M1c', rep.id);
    // 5 units × $10 = $50 subtotal. 5 units × $4 cost = $20 cogsAtClose.
    const inv = await makeInvoice(cust.id, '5');
    expect(inv.cogsAtClose?.toString()).toBe(new Prisma.Decimal('20').toString());

    await recordPayment(db, {
      customerId: cust.id,
      method: PaymentMethod.CHECK,
      amount: '50',
      applications: [{ invoiceId: inv.id, amount: '50' }],
    });

    const a = await db.commissionAccrual.findFirstOrThrow({
      where: { salesRepId: rep.id },
    });
    // propCogs = (50 / 50) × 20 = 20. basisAmount = 50 − 20 = 30. amount = 30 × 20% = 6.
    expect(a.basisAmount.toString()).toBe(new Prisma.Decimal('30').toString());
    expect(a.amount.toString()).toBe(new Prisma.Decimal('6').toString());
  });

  it('MARGIN basis: partial payment scales propCogs proportionally', async () => {
    const rep = await newRep('M2', {
      basis: CommissionBasis.MARGIN,
      percent: '20',
    });
    const cust = await newCustomer('M2c', rep.id);
    const inv = await makeInvoice(cust.id, '5'); // $50 / $20 cogs
    await recordPayment(db, {
      customerId: cust.id,
      method: PaymentMethod.CHECK,
      amount: '20',
      applications: [{ invoiceId: inv.id, amount: '20' }],
    });
    const a = await db.commissionAccrual.findFirstOrThrow({
      where: { salesRepId: rep.id },
    });
    // propCogs = (20 / 50) × 20 = 8. basis = 20 − 8 = 12. amount = 12 × 20% = 2.4.
    expect(a.basisAmount.toString()).toBe(new Prisma.Decimal('12').toString());
    expect(a.amount.toString()).toBe(new Prisma.Decimal('2.4').toString());
  });

  it('MARGIN basis: zero-COGS invoice → basisAmount = applied (full margin)', async () => {
    const rep = await newRep('M3', {
      basis: CommissionBasis.MARGIN,
      percent: '20',
    });
    const cust = await newCustomer('M3c', rep.id);
    // Direct insert of an invoice with cogsAtClose=0 (drop-ship/service-only path).
    const so = await createSalesOrder(db, {
      customerId: cust.id,
      warehouseId,
      lines: [
        {
          variantId: variant.id,
          warehouseId,
          qtyOrdered: '5',
          manualUnitPrice: '10',
        },
      ],
    });
    await confirmSalesOrder(db, so.id);
    await closeSalesOrder(db, so.id, undefined);
    const inv = await db.invoice.findFirstOrThrow({ where: { salesOrderId: so.id } });
    // Force cogsAtClose=0 to simulate the zero-COGS branch.
    await db.invoice.update({
      where: { id: inv.id },
      data: { cogsAtClose: new Prisma.Decimal(0) },
    });

    await recordPayment(db, {
      customerId: cust.id,
      method: PaymentMethod.CHECK,
      amount: '50',
      applications: [{ invoiceId: inv.id, amount: '50' }],
    });
    const a = await db.commissionAccrual.findFirstOrThrow({
      where: { salesRepId: rep.id },
    });
    expect(a.basisAmount.toString()).toBe(new Prisma.Decimal('50').toString());
    expect(a.amount.toString()).toBe(new Prisma.Decimal('10').toString());
  });

  it('MARGIN basis: NULL cogsAtClose treated as 0 (Q3 fallback)', async () => {
    const rep = await newRep('M4', {
      basis: CommissionBasis.MARGIN,
      percent: '20',
    });
    const cust = await newCustomer('M4c', rep.id);
    const inv = await makeInvoice(cust.id, '5');
    // Simulate pre-migration state: clear the snapshot.
    await db.invoice.update({
      where: { id: inv.id },
      data: { cogsAtClose: null },
    });
    await recordPayment(db, {
      customerId: cust.id,
      method: PaymentMethod.CHECK,
      amount: '50',
      applications: [{ invoiceId: inv.id, amount: '50' }],
    });
    const a = await db.commissionAccrual.findFirstOrThrow({
      where: { salesRepId: rep.id },
    });
    // propCogs = 0 → basis = 50, amount = 10.
    expect(a.basisAmount.toString()).toBe(new Prisma.Decimal('50').toString());
    expect(a.amount.toString()).toBe(new Prisma.Decimal('10').toString());
  });

  // ---------------------------------------------------------------------------
  // Skip conditions
  // ---------------------------------------------------------------------------

  it('Salaried rep (commissionEnabled=false) → no accrual', async () => {
    const rep = await newRep('S1', {
      enabled: false,
      basis: CommissionBasis.REVENUE,
      percent: '10',
    });
    const cust = await newCustomer('S1c', rep.id);
    const inv = await makeInvoice(cust.id, '5');
    await recordPayment(db, {
      customerId: cust.id,
      method: PaymentMethod.CHECK,
      amount: '50',
      applications: [{ invoiceId: inv.id, amount: '50' }],
    });
    const accruals = await db.commissionAccrual.findMany({
      where: { salesRepId: rep.id },
    });
    expect(accruals).toHaveLength(0);
  });

  it('Rep enabled but no percent → no accrual', async () => {
    const rep = await newRep('NP', {
      enabled: true,
      basis: CommissionBasis.REVENUE,
      percent: null,
    });
    const cust = await newCustomer('NPc', rep.id);
    const inv = await makeInvoice(cust.id, '5');
    await recordPayment(db, {
      customerId: cust.id,
      method: PaymentMethod.CHECK,
      amount: '50',
      applications: [{ invoiceId: inv.id, amount: '50' }],
    });
    const accruals = await db.commissionAccrual.findMany({
      where: { salesRepId: rep.id },
    });
    expect(accruals).toHaveLength(0);
  });

  it('Rep enabled but no basis → no accrual', async () => {
    const rep = await newRep('NB', {
      enabled: true,
      basis: null,
      percent: '10',
    });
    const cust = await newCustomer('NBc', rep.id);
    const inv = await makeInvoice(cust.id, '5');
    await recordPayment(db, {
      customerId: cust.id,
      method: PaymentMethod.CHECK,
      amount: '50',
      applications: [{ invoiceId: inv.id, amount: '50' }],
    });
    const accruals = await db.commissionAccrual.findMany({
      where: { salesRepId: rep.id },
    });
    expect(accruals).toHaveLength(0);
  });

  it('Unapplied payment (no applications) → no accrual', async () => {
    const rep = await newRep('U1', {
      basis: CommissionBasis.REVENUE,
      percent: '10',
    });
    const cust = await newCustomer('U1c', rep.id);
    await recordPayment(db, {
      customerId: cust.id,
      method: PaymentMethod.CHECK,
      amount: '50',
    });
    const accruals = await db.commissionAccrual.findMany({
      where: { salesRepId: rep.id },
    });
    expect(accruals).toHaveLength(0);
  });

  it('APPLIED_CREDIT method → no accrual (Q1)', async () => {
    const rep = await newRep('AC', {
      basis: CommissionBasis.REVENUE,
      percent: '10',
    });
    const cust = await newCustomer('ACc', rep.id);
    const inv = await makeInvoice(cust.id, '5'); // $50 invoice

    // Seed an unapplied CM credit balance via direct insert so we
    // don't need the full RMA flow here.
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

    await recordPayment(db, {
      customerId: cust.id,
      method: PaymentMethod.APPLIED_CREDIT,
      amount: '50',
      applications: [{ invoiceId: inv.id, amount: '50' }],
    });

    const accruals = await db.commissionAccrual.findMany({
      where: { salesRepId: rep.id },
    });
    expect(accruals).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Mid-period toggle: existing accruals untouched
  // ---------------------------------------------------------------------------

  it('Toggling commissionEnabled mid-period leaves prior accruals intact; new payments respect new state', async () => {
    const rep = await newRep('T1', {
      enabled: true,
      basis: CommissionBasis.REVENUE,
      percent: '10',
    });
    const cust = await newCustomer('T1c', rep.id);
    const inv1 = await makeInvoice(cust.id, '5');
    await recordPayment(db, {
      customerId: cust.id,
      method: PaymentMethod.CHECK,
      amount: '50',
      applications: [{ invoiceId: inv1.id, amount: '50' }],
    });
    // Toggle off.
    await db.salesRep.update({
      where: { id: rep.id },
      data: { commissionEnabled: false },
    });
    const inv2 = await makeInvoice(cust.id, '3');
    await recordPayment(db, {
      customerId: cust.id,
      method: PaymentMethod.CHECK,
      amount: '30',
      applications: [{ invoiceId: inv2.id, amount: '30' }],
    });
    const accruals = await db.commissionAccrual.findMany({
      where: { salesRepId: rep.id },
    });
    expect(accruals).toHaveLength(1);
    expect(accruals[0]!.invoiceId).toBe(inv1.id);
  });

  // ---------------------------------------------------------------------------
  // Audit
  // ---------------------------------------------------------------------------

  it('Accrual writes a CREATE audit row', async () => {
    const rep = await newRep('AU', {
      basis: CommissionBasis.REVENUE,
      percent: '10',
    });
    const cust = await newCustomer('AUc', rep.id);
    const inv = await makeInvoice(cust.id, '5');
    await recordPayment(
      db,
      {
        customerId: cust.id,
        method: PaymentMethod.CHECK,
        amount: '50',
        applications: [{ invoiceId: inv.id, amount: '50' }],
      },
      { userId: 'tester' },
    );
    const a = await db.commissionAccrual.findFirstOrThrow({
      where: { salesRepId: rep.id },
    });
    const auditRows = await db.auditLog.findMany({
      where: {
        entityType: 'CommissionAccrual',
        entityId: a.id,
        action: AuditAction.CREATE,
      },
    });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]!.userId).toBe('tester');
  });

  // ---------------------------------------------------------------------------
  // Decimal precision
  // ---------------------------------------------------------------------------

  it('Decimal precision preserved (no Number coercion)', async () => {
    const rep = await newRep('DP', {
      basis: CommissionBasis.REVENUE,
      percent: '7.5',
    });
    const cust = await newCustomer('DPc', rep.id);
    const inv = await makeInvoice(cust.id, '3', '11.11'); // $33.33
    await recordPayment(db, {
      customerId: cust.id,
      method: PaymentMethod.CHECK,
      amount: '33.33',
      applications: [{ invoiceId: inv.id, amount: '33.33' }],
    });
    const a = await db.commissionAccrual.findFirstOrThrow({
      where: { salesRepId: rep.id },
    });
    // 33.33 × 7.5 / 100 = 2.49975 — fits exactly within Decimal(18,5),
    // so the stored value matches the in-memory math byte-for-byte.
    expect(a.basisAmount.toString()).toBe(new Prisma.Decimal('33.33').toString());
    expect(a.percent.toString()).toBe(new Prisma.Decimal('7.5').toString());
    expect(a.amount.toString()).toBe(new Prisma.Decimal('2.49975').toString());
  });
});

async function wipe(db: PrismaClient): Promise<void> {
  // Commission accruals first (FK to SalesRep, Payment, Invoice).
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
    // Receipt artifacts (FK paths into FifoLayer + InventoryMovement).
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
      await db.auditLog.deleteMany({
        where: {
          entityType: 'InventoryMovement',
          entityId: { in: ourMovements.map((m) => m.id) },
        },
      });
      const mvIds = ourMovements.map((m) => m.id);
      const recvJes = await db.journalEntry.findMany({
        where: { entityType: 'InventoryMovement', entityId: { in: mvIds } },
        select: { id: true },
      });
      if (recvJes.length > 0) {
        const jeIds = recvJes.map((j) => j.id);
        await db.journalEntryLine.deleteMany({ where: { journalEntryId: { in: jeIds } } });
        await db.journalEntry.deleteMany({ where: { id: { in: jeIds } } });
      }
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
