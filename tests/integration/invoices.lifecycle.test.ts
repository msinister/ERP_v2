import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CreditApplicationKind,
  InvoiceStatus,
  Prisma,
  PaymentMethod,
  PaymentStatus,
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
import {
  getInvoice,
  listInvoices,
  voidInvoice,
} from '@/server/services/invoices';
import { arBalanceForCustomer } from '@/server/services/ar';
import { hasTenantDb, makeClient } from '../helpers/db';
import { upsertTestWarehouse } from '../helpers/warehouseStub';

const suite = hasTenantDb ? describe : describe.skip;

const TAG = 'TEST-INVLC';

// Helper used by every JE-emitting test — matches the gl/post invariant
// (SUM(debits) === SUM(credits)) and surfaces imbalance immediately.
function assertJournalEntryBalanced(
  je: { lines: Array<{ debit: Prisma.Decimal; credit: Prisma.Decimal }> },
): void {
  const dr = je.lines.reduce((acc, l) => acc.plus(l.debit), new Prisma.Decimal(0));
  const cr = je.lines.reduce((acc, l) => acc.plus(l.credit), new Prisma.Decimal(0));
  if (!dr.equals(cr)) {
    throw new Error(`JE not balanced: debits=${dr.toString()} credits=${cr.toString()}`);
  }
}

suite('Invoice lifecycle — auto-generation, void, AR balance', () => {
  let db: PrismaClient;
  let salesRep: SalesRep;
  let term: PaymentTerm;
  let customer: Customer;
  let warehouseId: string;
  let product: Product;
  let variantA: ProductVariant;
  let variantB: ProductVariant;

  beforeAll(async () => {
    db = makeClient();
    salesRep = await db.salesRep.findFirstOrThrow({ where: { code: 'UNASSIGNED' } });
    term = await db.paymentTerm.findFirstOrThrow({ where: { code: 'NET30' } });
    const wh = await upsertTestWarehouse(db, {
      code: `${TAG}-WH`,
      name: 'Inv WH',
    });
    warehouseId = wh.id;
    product = await db.product.upsert({
      where: { sku: `${TAG}-PROD` },
      create: {
        sku: `${TAG}-PROD`,
        name: 'Inv Product',
        basePrice: new Prisma.Decimal('10.00'),
      },
      update: {
        active: true,
        deletedAt: null,
        basePrice: new Prisma.Decimal('10.00'),
      },
    });
    variantA = await db.productVariant.upsert({
      where: { sku: `${TAG}-VA` },
      create: { productId: product.id, sku: `${TAG}-VA`, name: 'A' },
      update: { productId: product.id, active: true, deletedAt: null },
    });
    variantB = await db.productVariant.upsert({
      where: { sku: `${TAG}-VB` },
      create: { productId: product.id, sku: `${TAG}-VB`, name: 'B' },
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
    // Stock both variants for the SO closes.
    await receiveInventory(db, { variantId: variantA.id, warehouseId, qty: '100' });
    await receiveInventory(db, { variantId: variantB.id, warehouseId, qty: '100' });
  });

  afterAll(async () => {
    await wipe(db);
    await db.productVariant.deleteMany({ where: { productId: product.id } });
    await db.product.deleteMany({ where: { id: product.id } });
    await db.warehouse.deleteMany({ where: { code: `${TAG}-WH` } });
    await db.$disconnect();
  });

  // Build + close an SO with a custom shape, return the resulting invoice.
  async function closeSOAndGetInvoice(
    overrides: Partial<Parameters<typeof createSalesOrder>[1]>,
  ) {
    const so = await createSalesOrder(db, {
      customerId: customer.id,
      warehouseId,
      lines: [
        { variantId: variantA.id, warehouseId, qtyOrdered: '2' }, // 2 × $10 = $20
        { variantId: variantB.id, warehouseId, qtyOrdered: '3' }, // 3 × $10 = $30
      ],
      shippingAmount: '5',
      handlingAmount: '2',
      ...overrides,
    });
    await confirmSalesOrder(db, so.id);
    await closeSalesOrder(db, so.id, undefined);
    return db.invoice.findFirstOrThrow({
      where: { salesOrderId: so.id },
      include: { lines: { where: { deletedAt: null } } },
    });
  }

  // ---------- Snapshot correctness ----------

  it('closeSalesOrder generates an Invoice snapshotting SO totals + lines', async () => {
    const inv = await closeSOAndGetInvoice({});
    const so = await db.salesOrder.findUniqueOrThrow({
      where: { id: inv.salesOrderId },
    });
    expect(inv.number).toBe(so.number);
    expect(inv.salesOrderId).toBe(so.id);
    expect(inv.status).toBe(InvoiceStatus.OPEN);
    expect(inv.amountPaid.toString()).toBe(new Prisma.Decimal('0').toString());
    expect(inv.amountCredited.toString()).toBe(new Prisma.Decimal('0').toString());
    // Part 3 zero-COGS skip path flipped the flag: this suite seeds via
    // receiveInventory (no FifoLayer), so close → consume → 0 FifoConsumption
    // rows → cogsAmount=0 → flag flips with NO JE posted. Flag=true here
    // means "skip path ran", not "real COGS recorded".
    expect(inv.cogsPosted).toBe(true);
    // Subtotal = 20 + 30 = 50; total = 50 - 0 + 5 + 2 = 57
    expect(inv.subtotal.toString()).toBe(new Prisma.Decimal('50').toString());
    expect(inv.shippingAmount.toString()).toBe(new Prisma.Decimal('5').toString());
    expect(inv.handlingAmount.toString()).toBe(new Prisma.Decimal('2').toString());
    expect(inv.total.toString()).toBe(new Prisma.Decimal('57').toString());

    expect(inv.lines).toHaveLength(2);
    const lineA = inv.lines.find((l) => l.variantId === variantA.id)!;
    const lineB = inv.lines.find((l) => l.variantId === variantB.id)!;
    expect(lineA.qty.toString()).toBe(new Prisma.Decimal('2').toString());
    expect(lineA.unitPrice.toString()).toBe(new Prisma.Decimal('10').toString());
    expect(lineA.lineTotal.toString()).toBe(new Prisma.Decimal('20').toString());
    expect(lineB.qty.toString()).toBe(new Prisma.Decimal('3').toString());
    expect(lineB.lineTotal.toString()).toBe(new Prisma.Decimal('30').toString());
  });

  // ---------- JE posting ----------

  it('closeSalesOrder posts a balanced JE with correct legs', async () => {
    const inv = await closeSOAndGetInvoice({});
    const jes = await db.journalEntry.findMany({
      where: { entityType: 'Invoice', entityId: inv.id },
      include: { lines: { include: { account: true } } },
    });
    expect(jes).toHaveLength(1);
    const je = jes[0];
    assertJournalEntryBalanced(je);

    // Expected:
    //   DR 1210 AR        57
    //   CR 4100 Sales     50  (subtotal − 0 orderDiscount)
    //   CR 4200 Shipping   5
    //   CR 4300 Handling   2
    const ar = je.lines.find((l) => l.account.code === '1210')!;
    expect(ar.debit.toString()).toBe(new Prisma.Decimal('57').toString());
    const sales = je.lines.find((l) => l.account.code === '4100')!;
    expect(sales.credit.toString()).toBe(new Prisma.Decimal('50').toString());
    const ship = je.lines.find((l) => l.account.code === '4200')!;
    expect(ship.credit.toString()).toBe(new Prisma.Decimal('5').toString());
    const handle = je.lines.find((l) => l.account.code === '4300')!;
    expect(handle.credit.toString()).toBe(new Prisma.Decimal('2').toString());
  });

  it('zero shippingAmount: no CR 4200 line emitted', async () => {
    const inv = await closeSOAndGetInvoice({ shippingAmount: '0' });
    const je = await db.journalEntry.findFirstOrThrow({
      where: { entityType: 'Invoice', entityId: inv.id },
      include: { lines: { include: { account: true } } },
    });
    assertJournalEntryBalanced(je);
    const codes = je.lines.map((l) => l.account.code);
    expect(codes).not.toContain('4200');
    expect(codes).toContain('4300'); // handling still there
  });

  // ---------- Idempotency ----------

  it('re-closing the same SO does not duplicate the invoice or the JE', async () => {
    const inv = await closeSOAndGetInvoice({});
    // closeSalesOrder normally rejects re-close from CLOSED status, so we
    // call generateInvoiceForClosedSOTx directly via a transaction —
    // this exercises the @@unique-guard idempotency path on the helper.
    const { generateInvoiceForClosedSOTx } = await import(
      '@/server/services/invoices'
    );
    await db.$transaction((tx) =>
      generateInvoiceForClosedSOTx(tx, inv.salesOrderId),
    );
    const allInvoices = await db.invoice.findMany({
      where: { salesOrderId: inv.salesOrderId },
    });
    expect(allInvoices).toHaveLength(1);
    const allJes = await db.journalEntry.findMany({
      where: { entityType: 'Invoice', entityId: inv.id },
    });
    expect(allJes).toHaveLength(1);
  });

  // ---------- Void ----------

  it('voidInvoice flips status, posts an offsetting JE, leaves original JE intact', async () => {
    const inv = await closeSOAndGetInvoice({});
    const originalJe = await db.journalEntry.findFirstOrThrow({
      where: { entityType: 'Invoice', entityId: inv.id },
    });

    const voided = await voidInvoice(db, inv.id, 'duplicate invoice');
    expect(voided.status).toBe(InvoiceStatus.VOIDED);
    expect(voided.voidedAt).not.toBeNull();
    expect(voided.voidReason).toBe('duplicate invoice');

    // The original JE retains reversedAt:null — we post an offsetting
    // JE rather than mark the original.
    const originalAfter = await db.journalEntry.findUniqueOrThrow({
      where: { id: originalJe.id },
    });
    expect(originalAfter.reversedAt).toBeNull();

    const allJes = await db.journalEntry.findMany({
      where: { entityType: 'Invoice', entityId: inv.id },
      include: { lines: { include: { account: true } } },
    });
    expect(allJes).toHaveLength(2);
    for (const je of allJes) assertJournalEntryBalanced(je);

    // Net AR effect = zero across the two JEs.
    const arDelta = allJes
      .flatMap((j) => j.lines)
      .filter((l) => l.account.code === '1210')
      .reduce(
        (acc, l) => acc.plus(l.debit).minus(l.credit),
        new Prisma.Decimal(0),
      );
    expect(arDelta.toString()).toBe(new Prisma.Decimal('0').toString());

    // Offsetting JE has reverse legs: AR credited, revenue/shipping/
    // handling debited.
    const reverseJe = allJes.find((j) => j.id !== originalJe.id)!;
    const reverseAr = reverseJe.lines.find((l) => l.account.code === '1210')!;
    expect(reverseAr.credit.toString()).toBe(new Prisma.Decimal('57').toString());
    const reverseSales = reverseJe.lines.find((l) => l.account.code === '4100')!;
    expect(reverseSales.debit.toString()).toBe(new Prisma.Decimal('50').toString());
  });

  it('voidInvoice refuses when applied payments exist; works once payment is reversed', async () => {
    const inv = await closeSOAndGetInvoice({});

    // Record a payment + apply it directly via raw create (we don't have
    // payments service yet — that's item #8). Suffices for the guard
    // assertion.
    const payment = await db.payment.create({
      data: {
        number: `PMT-TEST-${Date.now()}`,
        customerId: customer.id,
        method: PaymentMethod.CHECK,
        amount: new Prisma.Decimal('20'),
        appliedAmount: new Prisma.Decimal('20'),
      },
    });
    await db.creditApplication.create({
      data: {
        kind: CreditApplicationKind.PAYMENT_TO_INVOICE,
        paymentId: payment.id,
        invoiceId: inv.id,
        amount: new Prisma.Decimal('20'),
      },
    });

    await expect(voidInvoice(db, inv.id, 'oops')).rejects.toThrow(
      /Cannot void invoice with applied payments/,
    );

    // Mark the application reversed; void now succeeds.
    await db.creditApplication.updateMany({
      where: { paymentId: payment.id, invoiceId: inv.id },
      data: { reversedAt: new Date() },
    });
    await db.payment.update({
      where: { id: payment.id },
      data: {
        status: PaymentStatus.REVERSED,
        reversedAt: new Date(),
        reversedReason: 'manual reversal for test',
      },
    });
    const voided = await voidInvoice(db, inv.id, 'after reversal');
    expect(voided.status).toBe(InvoiceStatus.VOIDED);
  });

  // ---------- AR balance + listing ----------

  it('arBalanceForCustomer sums open invoice balances', async () => {
    // Three SOs of different totals via different shipping/handling.
    await closeSOAndGetInvoice({}); // total 57
    await closeSOAndGetInvoice({
      lines: [{ variantId: variantA.id, warehouseId, qtyOrdered: '10' }], // 100
      shippingAmount: '0',
      handlingAmount: '0',
    });
    await closeSOAndGetInvoice({
      lines: [{ variantId: variantA.id, warehouseId, qtyOrdered: '5' }], // 50
      shippingAmount: '0',
      handlingAmount: '0',
    });
    const { arBalance } = await arBalanceForCustomer(db, customer.id);
    // 57 + 100 + 50 = 207
    expect(arBalance.toString()).toBe(new Prisma.Decimal('207').toString());
  });

  it('listInvoices: customerId + status filter; voided excluded by status filter', async () => {
    const a = await closeSOAndGetInvoice({});
    await closeSOAndGetInvoice({
      lines: [{ variantId: variantA.id, warehouseId, qtyOrdered: '1' }],
      shippingAmount: '0',
      handlingAmount: '0',
    });
    await voidInvoice(db, a.id, 'test');
    const open = await listInvoices(db, {
      customerId: customer.id,
      status: InvoiceStatus.OPEN,
    });
    expect(open.every((i) => i.status === InvoiceStatus.OPEN)).toBe(true);
    expect(open.every((i) => i.id !== a.id)).toBe(true);
  });

  it('listInvoices: q substring filter on number', async () => {
    const inv = await closeSOAndGetInvoice({});
    const matches = await listInvoices(db, { q: inv.number });
    expect(matches.find((i) => i.id === inv.id)).toBeDefined();
  });

  it('getInvoice includes customer + warehouse names', async () => {
    const inv = await closeSOAndGetInvoice({});
    const fetched = await getInvoice(db, inv.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.customer.name).toBe(`${TAG} Customer`);
    expect(fetched!.warehouse.code).toBe(`${TAG}-WH`);
  });

  it('listInvoices excludes soft-deleted', async () => {
    const inv = await closeSOAndGetInvoice({});
    await db.invoice.update({
      where: { id: inv.id },
      data: { deletedAt: new Date() },
    });
    const all = await listInvoices(db, { customerId: customer.id });
    expect(all.find((i) => i.id === inv.id)).toBeUndefined();
  });
});

async function wipe(db: PrismaClient): Promise<void> {
  const customers = await db.customer.findMany({
    where: { name: { startsWith: TAG } },
    select: { id: true },
  });
  const ids = customers.map((c) => c.id);
  if (ids.length === 0) return;

  // Drop CreditApplications + Payments first (held by invoices).
  const ourPayments = await db.payment.findMany({
    where: { customerId: { in: ids } },
    select: { id: true },
  });
  if (ourPayments.length > 0) {
    const pIds = ourPayments.map((p) => p.id);
    await db.creditApplication.deleteMany({ where: { paymentId: { in: pIds } } });
    await db.payment.deleteMany({ where: { id: { in: pIds } } });
  }

  // Drop invoices + their JEs + audit rows.
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

  // Drop SO rows + their consume movements + customer scaffolding.
  // Scope SO audits by THIS test's SO ids so other parallel test
  // files' audit rows survive. Done BEFORE deleting the SO rows.
  const ourSos = await db.salesOrder.findMany({
    where: { customerId: { in: ids } },
    select: { id: true },
  });
  const soIds = ourSos.map((s) => s.id);
  if (soIds.length > 0) {
    await db.auditLog.deleteMany({
      where: { entityType: 'SalesOrder', entityId: { in: soIds } },
    });
  }
  await db.salesOrderLine.deleteMany({ where: { salesOrder: { customerId: { in: ids } } } });
  await db.salesOrder.deleteMany({ where: { customerId: { in: ids } } });
  // Inventory movements + items for our test variants (variantA, variantB
  // are module-level fixtures keyed by SKU prefix).
  const ourVariants = await db.productVariant.findMany({
    where: { sku: { startsWith: TAG } },
    select: { id: true },
  });
  const variantIds = ourVariants.map((v) => v.id);
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
