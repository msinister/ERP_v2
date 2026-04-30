import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CreditMemoStatus,
  InvoiceStatus,
  PaymentMethod,
  Prisma,
} from '@/generated/tenant';
import type {
  CreditMemoCategory,
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
  applyCreditToInvoice,
  recordPayment,
} from '@/server/services/payments';
import {
  confirmCreditMemo,
  createCreditMemoDraft,
  listCreditMemos,
  voidCreditMemo,
} from '@/server/services/creditMemos';
import { hasTenantDb, makeClient } from '../helpers/db';

const suite = hasTenantDb ? describe : describe.skip;

const TAG = 'TEST-CMLC';

function assertJournalEntryBalanced(
  je: { lines: Array<{ debit: Prisma.Decimal; credit: Prisma.Decimal }> },
): void {
  const dr = je.lines.reduce((acc, l) => acc.plus(l.debit), new Prisma.Decimal(0));
  const cr = je.lines.reduce((acc, l) => acc.plus(l.credit), new Prisma.Decimal(0));
  if (!dr.equals(cr)) {
    throw new Error(`JE not balanced: debits=${dr.toString()} credits=${cr.toString()}`);
  }
}

suite('CreditMemo lifecycle', () => {
  let db: PrismaClient;
  let salesRep: SalesRep;
  let term: PaymentTerm;
  let returnCategory: CreditMemoCategory;
  let goodwillCategory: CreditMemoCategory;
  let customer: Customer;
  let warehouseId: string;
  let product: Product;
  let variant: ProductVariant;

  beforeAll(async () => {
    db = makeClient();
    salesRep = await db.salesRep.findFirstOrThrow({ where: { code: 'UNASSIGNED' } });
    term = await db.paymentTerm.findFirstOrThrow({ where: { code: 'NET30' } });
    returnCategory = await db.creditMemoCategory.findFirstOrThrow({
      where: { code: 'RETURN' },
    });
    goodwillCategory = await db.creditMemoCategory.findFirstOrThrow({
      where: { code: 'GOODWILL' },
    });
    const wh = await db.warehouse.upsert({
      where: { code: `${TAG}-WH` },
      create: { code: `${TAG}-WH`, name: 'CM WH' },
      update: { active: true, deletedAt: null },
    });
    warehouseId = wh.id;
    product = await db.product.upsert({
      where: { sku: `${TAG}-PROD` },
      create: {
        sku: `${TAG}-PROD`,
        name: 'CM Product',
        basePrice: new Prisma.Decimal('10.00'),
      },
      update: { active: true, deletedAt: null, basePrice: new Prisma.Decimal('10.00') },
    });
    variant = await db.productVariant.upsert({
      where: { sku: `${TAG}-V` },
      create: { productId: product.id, sku: `${TAG}-V`, name: 'V' },
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
    await receiveInventory(db, { variantId: variant.id, warehouseId, qty: '1000' });
  });

  afterAll(async () => {
    await wipe(db);
    await db.productVariant.deleteMany({ where: { productId: product.id } });
    await db.product.deleteMany({ where: { id: product.id } });
    await db.warehouse.deleteMany({ where: { code: `${TAG}-WH` } });
    await db.$disconnect();
  });

  async function makeInvoice(qty: string) {
    const so = await createSalesOrder(db, {
      customerId: customer.id,
      warehouseId,
      lines: [{ variantId: variant.id, warehouseId, qtyOrdered: qty }],
    });
    await confirmSalesOrder(db, so.id);
    await closeSalesOrder(db, so.id, undefined);
    return db.invoice.findFirstOrThrow({
      where: { salesOrderId: so.id },
      include: { lines: { where: { deletedAt: null } } },
    });
  }

  // ---------- Draft creation ----------

  it('createCreditMemoDraft happy path: CM-YYYY-NNNNN, status DRAFT, no JE, lines snapshot', async () => {
    const inv = await makeInvoice('5'); // total 50
    const cm = await createCreditMemoDraft(db, {
      customerId: customer.id,
      invoiceId: inv.id,
      categoryId: returnCategory.id,
      amount: '50',
      lines: [
        { variantId: variant.id, qty: '5', unitPrice: '10', description: 'returned' },
      ],
    });
    expect(cm.number).toMatch(/^CM-\d{4}-\d{5}$/);
    expect(cm.status).toBe(CreditMemoStatus.DRAFT);
    expect(cm.amount.toString()).toBe(new Prisma.Decimal('50').toString());
    expect(cm.netCredit.toString()).toBe(new Prisma.Decimal('50').toString());
    expect(cm.lines).toHaveLength(1);
    expect(cm.lines[0].lineTotal.toString()).toBe(new Prisma.Decimal('50').toString());

    // No JE was posted at draft.
    const jes = await db.journalEntry.findMany({
      where: { entityType: 'CreditMemo', entityId: cm.id },
    });
    expect(jes).toHaveLength(0);

    // Invoice is unaffected.
    const freshInv = await db.invoice.findUniqueOrThrow({ where: { id: inv.id } });
    expect(freshInv.amountCredited.toString()).toBe(new Prisma.Decimal('0').toString());
  });

  it('mismatched line math throws specific error', async () => {
    await expect(
      createCreditMemoDraft(db, {
        customerId: customer.id,
        categoryId: returnCategory.id,
        amount: '50',
        lines: [
          { variantId: variant.id, qty: '5', unitPrice: '11', description: 'mismatch' },
        ],
      }),
    ).rejects.toThrow(/Line totals .* don't match memo amount/);
  });

  it('soft-deleted customer throws', async () => {
    await db.customer.update({
      where: { id: customer.id },
      data: { deletedAt: new Date() },
    });
    await expect(
      createCreditMemoDraft(db, {
        customerId: customer.id,
        categoryId: returnCategory.id,
        amount: '50',
        lines: [
          { variantId: variant.id, qty: '5', unitPrice: '10', description: 'x' },
        ],
      }),
    ).rejects.toThrow(/Customer not found/);
  });

  it('soft-deleted category throws', async () => {
    const stamp = Date.now();
    const tempCat = await db.creditMemoCategory.create({
      data: { code: `${TAG}-CAT-${stamp}`, label: 'tmp', affectsInventory: false },
    });
    await db.creditMemoCategory.update({
      where: { id: tempCat.id },
      data: { deletedAt: new Date() },
    });
    await expect(
      createCreditMemoDraft(db, {
        customerId: customer.id,
        categoryId: tempCat.id,
        amount: '50',
        lines: [
          { variantId: variant.id, qty: '5', unitPrice: '10', description: 'x' },
        ],
      }),
    ).rejects.toThrow(/CreditMemoCategory not found/);
    await db.creditMemoCategory.delete({ where: { id: tempCat.id } });
  });

  // ---------- Confirm ----------

  it('confirmCreditMemo: status flips, balanced JE posted, invoice.amountCredited bumps by netCredit', async () => {
    const inv = await makeInvoice('10'); // total 100
    const cm = await createCreditMemoDraft(db, {
      customerId: customer.id,
      invoiceId: inv.id,
      categoryId: returnCategory.id,
      amount: '50',
      lines: [
        { variantId: variant.id, qty: '5', unitPrice: '10', description: 'partial return' },
      ],
    });
    const confirmed = await confirmCreditMemo(db, cm.id);
    expect(confirmed.status).toBe(CreditMemoStatus.CONFIRMED);
    expect(confirmed.issuedAt).not.toBeNull();

    const je = await db.journalEntry.findFirstOrThrow({
      where: { entityType: 'CreditMemo', entityId: cm.id },
      include: { lines: { include: { account: true } } },
    });
    assertJournalEntryBalanced(je);
    // Two legs (no restocking fee): DR 4500 50, CR 1210 50.
    expect(je.lines).toHaveLength(2);
    expect(je.lines.find((l) => l.account.code === '4500')!.debit.toString()).toBe(
      new Prisma.Decimal('50').toString(),
    );
    expect(je.lines.find((l) => l.account.code === '1210')!.credit.toString()).toBe(
      new Prisma.Decimal('50').toString(),
    );

    // Invoice's amountCredited bumped by netCredit (which equals
    // amount here since restockingFee=0); status flipped to PARTIAL
    // (50 of 100 credited).
    const freshInv = await db.invoice.findUniqueOrThrow({ where: { id: inv.id } });
    expect(freshInv.amountCredited.toString()).toBe(new Prisma.Decimal('50').toString());
    expect(freshInv.status).toBe(InvoiceStatus.PARTIAL);
  });

  it('confirmCreditMemo with full credit: invoice flips to PAID', async () => {
    const inv = await makeInvoice('10'); // total 100
    const cm = await createCreditMemoDraft(db, {
      customerId: customer.id,
      invoiceId: inv.id,
      categoryId: returnCategory.id,
      amount: '100',
      lines: [
        { variantId: variant.id, qty: '10', unitPrice: '10', description: 'full return' },
      ],
    });
    await confirmCreditMemo(db, cm.id);
    const freshInv = await db.invoice.findUniqueOrThrow({ where: { id: inv.id } });
    expect(freshInv.status).toBe(InvoiceStatus.PAID);
  });

  it('confirmCreditMemo on already-confirmed throws', async () => {
    const inv = await makeInvoice('5');
    const cm = await createCreditMemoDraft(db, {
      customerId: customer.id,
      invoiceId: inv.id,
      categoryId: returnCategory.id,
      amount: '50',
      lines: [{ variantId: variant.id, qty: '5', unitPrice: '10', description: 'x' }],
    });
    await confirmCreditMemo(db, cm.id);
    await expect(confirmCreditMemo(db, cm.id)).rejects.toThrow(/Cannot confirm/);
  });

  it('confirmCreditMemo on voided throws', async () => {
    const cm = await createCreditMemoDraft(db, {
      customerId: customer.id,
      categoryId: goodwillCategory.id,
      amount: '50',
      lines: [{ variantId: variant.id, qty: '5', unitPrice: '10', description: 'x' }],
    });
    await voidCreditMemo(db, cm.id, 'mistake');
    await expect(confirmCreditMemo(db, cm.id)).rejects.toThrow(/Cannot confirm/);
  });

  it('confirmCreditMemo with affectsInventory=true (RETURN) writes restock-pending CustomerActivity', async () => {
    const cm = await createCreditMemoDraft(db, {
      customerId: customer.id,
      categoryId: returnCategory.id,
      amount: '20',
      lines: [{ variantId: variant.id, qty: '2', unitPrice: '10', description: 'restock' }],
    });
    await confirmCreditMemo(db, cm.id);

    const activity = await db.customerActivity.findFirst({
      where: {
        customerId: customer.id,
        summary: 'credit_memo_inventory_restock_pending',
      },
    });
    expect(activity).not.toBeNull();
    const detail = activity!.detailJson as {
      creditMemoId: string;
      lines: Array<{ variantId: string; qty: string }>;
    };
    expect(detail.creditMemoId).toBe(cm.id);
    expect(detail.lines).toHaveLength(1);
    expect(detail.lines[0].variantId).toBe(variant.id);
    expect(detail.lines[0].qty).toBe(new Prisma.Decimal('2').toString());

    // No InventoryMovement was created — costing engine slice will
    // replay this activity row.
    const movements = await db.inventoryMovement.findMany({
      where: { variantId: variant.id, reference: { contains: cm.number } },
    });
    expect(movements).toHaveLength(0);
  });

  it('confirmCreditMemo with affectsInventory=false (GOODWILL) does NOT write restock-pending row', async () => {
    const cm = await createCreditMemoDraft(db, {
      customerId: customer.id,
      categoryId: goodwillCategory.id,
      amount: '25',
      lines: [{ variantId: variant.id, qty: '5', unitPrice: '5', description: 'goodwill' }],
    });
    await confirmCreditMemo(db, cm.id);
    const activity = await db.customerActivity.findFirst({
      where: {
        customerId: customer.id,
        summary: 'credit_memo_inventory_restock_pending',
      },
    });
    expect(activity).toBeNull();
  });

  it('restocking-fee math: amount=$100, fee=$10 → DR 4500 $100, CR 1210 $100, DR 1210 $10, CR 4600 $10', async () => {
    const cm = await createCreditMemoDraft(db, {
      customerId: customer.id,
      categoryId: returnCategory.id,
      amount: '100',
      restockingFee: '10',
      // Lines must satisfy SUM(qty*unitPrice) === amount = 100.
      // Restocking fee is a SEPARATE charge, NOT included in line sum.
      lines: [
        { variantId: variant.id, qty: '10', unitPrice: '10', description: 'with-fee' },
      ],
    });
    expect(cm.netCredit.toString()).toBe(new Prisma.Decimal('90').toString());
    await confirmCreditMemo(db, cm.id);

    const je = await db.journalEntry.findFirstOrThrow({
      where: { entityType: 'CreditMemo', entityId: cm.id },
      include: { lines: { include: { account: true } } },
    });
    assertJournalEntryBalanced(je);
    expect(je.lines).toHaveLength(4);
    const sr = je.lines.find((l) => l.account.code === '4500')!;
    const arDebit = je.lines.find((l) => l.account.code === '1210' && l.debit.greaterThan(0))!;
    const arCredit = je.lines.find((l) => l.account.code === '1210' && l.credit.greaterThan(0))!;
    const fee = je.lines.find((l) => l.account.code === '4600')!;
    expect(sr.debit.toString()).toBe(new Prisma.Decimal('100').toString());
    expect(arCredit.credit.toString()).toBe(new Prisma.Decimal('100').toString());
    expect(arDebit.debit.toString()).toBe(new Prisma.Decimal('10').toString());
    expect(fee.credit.toString()).toBe(new Prisma.Decimal('10').toString());

    // Net AR drop = 100 − 10 = 90 (= netCredit). Verify via the JE.
    const arNet = arDebit.debit.minus(arCredit.credit);
    expect(arNet.toString()).toBe(new Prisma.Decimal('-90').toString());
  });

  // ---------- Void ----------

  it('voidCreditMemo on DRAFT: status VOIDED, no JE', async () => {
    const cm = await createCreditMemoDraft(db, {
      customerId: customer.id,
      categoryId: goodwillCategory.id,
      amount: '50',
      lines: [{ variantId: variant.id, qty: '5', unitPrice: '10', description: 'x' }],
    });
    const voided = await voidCreditMemo(db, cm.id, 'mistake');
    expect(voided.status).toBe(CreditMemoStatus.VOIDED);
    expect(voided.voidedAt).not.toBeNull();
    expect(voided.voidReason).toBe('mistake');
    const jes = await db.journalEntry.findMany({
      where: { entityType: 'CreditMemo', entityId: cm.id },
    });
    expect(jes).toHaveLength(0);
  });

  it('voidCreditMemo on CONFIRMED with no manual apps: status VOIDED, reversal JE posted, invoice.amountCredited drops back', async () => {
    const inv = await makeInvoice('10'); // total 100
    const cm = await createCreditMemoDraft(db, {
      customerId: customer.id,
      invoiceId: inv.id,
      categoryId: returnCategory.id,
      amount: '50',
      lines: [{ variantId: variant.id, qty: '5', unitPrice: '10', description: 'x' }],
    });
    await confirmCreditMemo(db, cm.id);
    let freshInv = await db.invoice.findUniqueOrThrow({ where: { id: inv.id } });
    expect(freshInv.amountCredited.toString()).toBe(new Prisma.Decimal('50').toString());

    const originalJe = await db.journalEntry.findFirstOrThrow({
      where: { entityType: 'CreditMemo', entityId: cm.id },
    });

    await voidCreditMemo(db, cm.id, 'cm error');

    // Invoice.amountCredited drops back to 0 (auto-app reversed,
    // recompute picks up the change).
    freshInv = await db.invoice.findUniqueOrThrow({ where: { id: inv.id } });
    expect(freshInv.amountCredited.toString()).toBe(new Prisma.Decimal('0').toString());
    expect(freshInv.status).toBe(InvoiceStatus.OPEN);

    // Reversal JE posted; original retains reversedAt:null.
    const originalAfter = await db.journalEntry.findUniqueOrThrow({
      where: { id: originalJe.id },
    });
    expect(originalAfter.reversedAt).toBeNull();

    const allJes = await db.journalEntry.findMany({
      where: { entityType: 'CreditMemo', entityId: cm.id },
      include: { lines: true },
    });
    expect(allJes).toHaveLength(2);
    for (const je of allJes) assertJournalEntryBalanced(je);
  });

  it('voidCreditMemo on CONFIRMED with MANUAL applications throws "reverse first"', async () => {
    const inv = await makeInvoice('5'); // total 50
    // CM has no invoiceId → no auto-app. Apply manually.
    const cm = await createCreditMemoDraft(db, {
      customerId: customer.id,
      categoryId: goodwillCategory.id,
      amount: '20',
      lines: [{ variantId: variant.id, qty: '2', unitPrice: '10', description: 'gw' }],
    });
    await confirmCreditMemo(db, cm.id);
    await applyCreditToInvoice(db, {
      creditMemoId: cm.id,
      invoiceId: inv.id,
      amount: '20',
    });
    await expect(voidCreditMemo(db, cm.id, 'oops')).rejects.toThrow(
      /Reverse the applications first/,
    );
  });

  it('voidCreditMemo refuses when CM has been used as APPLIED_CREDIT source', async () => {
    const inv = await makeInvoice('5');
    const cm = await createCreditMemoDraft(db, {
      customerId: customer.id,
      categoryId: goodwillCategory.id,
      amount: '40',
      lines: [{ variantId: variant.id, qty: '4', unitPrice: '10', description: 'src' }],
    });
    await confirmCreditMemo(db, cm.id);
    // Use the CM via APPLIED_CREDIT method on a payment.
    await recordPayment(db, {
      customerId: customer.id,
      method: PaymentMethod.APPLIED_CREDIT,
      amount: '20',
      applications: [{ invoiceId: inv.id, amount: '20' }],
    });
    // The CM is now non-reversed-applied via APPLIED_CREDIT; void must refuse.
    await expect(voidCreditMemo(db, cm.id, 'recall')).rejects.toThrow(
      /Reverse the applications first/,
    );
  });

  // ---------- Listing ----------

  it('listCreditMemos filters by customerId, status, categoryId', async () => {
    const cmA = await createCreditMemoDraft(db, {
      customerId: customer.id,
      categoryId: returnCategory.id,
      amount: '10',
      lines: [{ variantId: variant.id, qty: '1', unitPrice: '10', description: 'a' }],
    });
    const cmB = await createCreditMemoDraft(db, {
      customerId: customer.id,
      categoryId: goodwillCategory.id,
      amount: '20',
      lines: [{ variantId: variant.id, qty: '2', unitPrice: '10', description: 'b' }],
    });
    await confirmCreditMemo(db, cmA.id);

    const drafts = await listCreditMemos(db, {
      customerId: customer.id,
      status: CreditMemoStatus.DRAFT,
    });
    const draftIds = drafts.map((c) => c.id);
    expect(draftIds).toContain(cmB.id);
    expect(draftIds).not.toContain(cmA.id);

    const goodwills = await listCreditMemos(db, {
      customerId: customer.id,
      categoryId: goodwillCategory.id,
    });
    expect(goodwills.map((c) => c.id)).toContain(cmB.id);
    expect(goodwills.map((c) => c.id)).not.toContain(cmA.id);
  });

  it('listCreditMemos excludes soft-deleted', async () => {
    const cm = await createCreditMemoDraft(db, {
      customerId: customer.id,
      categoryId: goodwillCategory.id,
      amount: '10',
      lines: [{ variantId: variant.id, qty: '1', unitPrice: '10', description: 'x' }],
    });
    await db.creditMemo.update({
      where: { id: cm.id },
      data: { deletedAt: new Date() },
    });
    const list = await listCreditMemos(db, { customerId: customer.id });
    expect(list.find((c) => c.id === cm.id)).toBeUndefined();
  });
});

async function wipe(db: PrismaClient): Promise<void> {
  const customers = await db.customer.findMany({
    where: { name: { startsWith: TAG } },
    select: { id: true },
  });
  const ids = customers.map((c) => c.id);
  if (ids.length === 0) return;

  // Drop CM JEs + audit + lines + applications.
  const ourCms = await db.creditMemo.findMany({
    where: { customerId: { in: ids } },
    select: { id: true },
  });
  if (ourCms.length > 0) {
    const cmIds = ourCms.map((c) => c.id);
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

  // Payments (some tests record payments).
  const ourPayments = await db.payment.findMany({
    where: { customerId: { in: ids } },
    select: { id: true },
  });
  if (ourPayments.length > 0) {
    const pIds = ourPayments.map((p) => p.id);
    const pmtJes = await db.journalEntry.findMany({
      where: { entityType: 'Payment', entityId: { in: pIds } },
      select: { id: true },
    });
    if (pmtJes.length > 0) {
      const jeIds = pmtJes.map((j) => j.id);
      await db.journalEntryLine.deleteMany({ where: { journalEntryId: { in: jeIds } } });
      await db.journalEntry.deleteMany({ where: { id: { in: jeIds } } });
    }
    await db.creditApplication.deleteMany({ where: { paymentId: { in: pIds } } });
    await db.auditLog.deleteMany({
      where: { entityType: 'Payment', entityId: { in: pIds } },
    });
    await db.payment.deleteMany({ where: { id: { in: pIds } } });
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

  // SO + customer scaffolding + variant inventory.
  // SO audit rows must be scoped by THIS slice's SO ids, not deleted
  // wholesale — other parallel test files have their own SOs and
  // depend on their audit rows remaining.
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
  const variantIds = (
    await db.productVariant.findMany({
      where: { sku: { startsWith: TAG } },
      select: { id: true },
    })
  ).map((v) => v.id);
  if (variantIds.length > 0) {
    // Movements / items + their audit rows scoped to OUR variants only.
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
  // CustomerAddress audits: keep wholesale-deletion since these only
  // exist on the test's own customers (which are about to be hard-
  // deleted) — but still scope by customerId to be safe.
  await db.auditLog.deleteMany({
    where: { entityType: 'CustomerAddress' },
  });
  await db.customer.deleteMany({ where: { id: { in: ids } } });
}
