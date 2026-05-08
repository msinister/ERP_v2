import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AuditAction,
  BillSource,
  BillStatus,
  Prisma,
  ReceiptStatus,
} from '@/generated/tenant';
import type {
  PaymentTerm,
  PrismaClient,
  Product,
  ProductVariant,
  Vendor,
} from '@/generated/tenant';
import {
  cancelBill,
  confirmBill,
  createBill,
  getBill,
  listBills,
  softDeleteBill,
  updateBill,
} from '@/server/services/bills';
import { hasTenantDb, makeClient } from '../helpers/db';
import { upsertTestWarehouse } from '../helpers/warehouseStub';
import { upsertTestVendor } from '../helpers/vendorStub';

const suite = hasTenantDb ? describe : describe.skip;

const TAG = 'TEST-BILLLC';

function assertBalanced(je: {
  lines: Array<{ debit: Prisma.Decimal; credit: Prisma.Decimal }>;
}): void {
  const dr = je.lines.reduce((acc, l) => acc.plus(l.debit), new Prisma.Decimal(0));
  const cr = je.lines.reduce((acc, l) => acc.plus(l.credit), new Prisma.Decimal(0));
  if (!dr.equals(cr)) {
    throw new Error(`JE not balanced: debits=${dr.toString()} credits=${cr.toString()}`);
  }
}

suite('Bill lifecycle', () => {
  let db: PrismaClient;
  let term: PaymentTerm;
  let vendor: Vendor;
  let otherVendor: Vendor;
  let warehouseId: string;
  let product: Product;
  let variant: ProductVariant;
  let officeExpenseId: string;
  let utilitiesExpenseId: string;

  beforeAll(async () => {
    db = makeClient();
    term = await db.paymentTerm.findFirstOrThrow({ where: { code: 'NET30' } });
    const wh = await upsertTestWarehouse(db, {
      code: `${TAG}-WH`,
      name: 'Bill WH',
    });
    warehouseId = wh.id;
    product = await db.product.upsert({
      where: { sku: `${TAG}-PROD` },
      create: {
        sku: `${TAG}-PROD`,
        name: 'Bill Product',
        basePrice: new Prisma.Decimal('15.00'),
      },
      update: { active: true, deletedAt: null },
    });
    variant = await db.productVariant.upsert({
      where: { sku: `${TAG}-V` },
      create: { productId: product.id, sku: `${TAG}-V`, name: 'V' },
      update: { productId: product.id, active: true, deletedAt: null },
    });
    officeExpenseId = (
      await db.glAccount.findFirstOrThrow({ where: { code: '5500' } })
    ).id;
    utilitiesExpenseId = (
      await db.glAccount.findFirstOrThrow({ where: { code: '5510' } })
    ).id;
  });

  beforeEach(async () => {
    await wipe(db);
    vendor = await upsertTestVendor(db, {
      code: `${TAG}-VEN`,
      name: `${TAG} Vendor`,
    });
    await db.vendor.update({
      where: { id: vendor.id },
      data: { paymentTermId: term.id },
    });
    otherVendor = await upsertTestVendor(db, {
      code: `${TAG}-VEN2`,
      name: `${TAG} Vendor 2`,
    });
  });

  afterAll(async () => {
    await wipe(db);
    await db.productVariant.deleteMany({ where: { productId: product.id } });
    await db.product.deleteMany({ where: { id: product.id } });
    await db.warehouse.deleteMany({ where: { code: `${TAG}-WH` } });
    await db.vendor.deleteMany({
      where: { code: { startsWith: `${TAG}-VEN` } },
    });
    await db.$disconnect();
  });

  // Direct receipt+line creation (bypasses postReceipt) — these tests
  // only need a FK target that bills can link to. Receipt-time GL
  // posting is exercised in postReceipt.glLeg.test.ts.
  async function makeReceiptWithLine(
    forVendor: Vendor,
  ): Promise<{ receiptId: string; receiptLineId: string }> {
    const receipt = await db.receipt.create({
      data: {
        number: `${TAG}-RCPT-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        vendorId: forVendor.id,
        warehouseId,
        status: ReceiptStatus.POSTED,
        receivedAt: new Date(),
        lines: {
          create: [
            {
              variantId: variant.id,
              warehouseId,
              qtyReceived: new Prisma.Decimal('10'),
              unitCost: new Prisma.Decimal('5'),
            },
          ],
        },
      },
      include: { lines: true },
    });
    return { receiptId: receipt.id, receiptLineId: receipt.lines[0].id };
  }

  // ---------- createBill ----------

  it('createBill PRODUCT happy path: BILL-YYYY-NNNNN, status DRAFT, no JE, line snapshot, receipt+PO joins null when no receiptLineId', async () => {
    const bill = await createBill(db, {
      vendorId: vendor.id,
      lines: [
        {
          variantId: variant.id,
          description: 'widget',
          qty: '10',
          unitCost: '5',
        },
      ],
    });
    expect(bill.number).toMatch(/^BILL-\d{4}-\d{5}$/);
    expect(bill.status).toBe(BillStatus.DRAFT);
    expect(bill.source).toBe(BillSource.PRODUCT);
    expect(bill.subtotal.toString()).toBe(new Prisma.Decimal('50').toString());
    expect(bill.total.toString()).toBe(new Prisma.Decimal('50').toString());
    expect(bill.lines).toHaveLength(1);
    expect(bill.lines[0].lineNumber).toBe(1);
    expect(bill.lines[0].lineTotal.toString()).toBe(
      new Prisma.Decimal('50').toString(),
    );
    expect(bill.dueDate).toBeNull();
    expect(bill.receipts).toHaveLength(0);
    expect(bill.purchaseOrders).toHaveLength(0);

    const jes = await db.journalEntry.findMany({
      where: { entityType: 'Bill', entityId: bill.id },
    });
    expect(jes).toHaveLength(0);

    const auditRows = await db.auditLog.findMany({
      where: { entityType: 'Bill', entityId: bill.id, action: AuditAction.CREATE },
    });
    expect(auditRows).toHaveLength(1);
  });

  it('createBill PRODUCT with receiptLineId populates BillReceipt join', async () => {
    const { receiptId, receiptLineId } = await makeReceiptWithLine(vendor);
    const bill = await createBill(db, {
      vendorId: vendor.id,
      lines: [
        {
          variantId: variant.id,
          receiptLineId,
          description: 'matched',
          qty: '10',
          unitCost: '5',
        },
      ],
    });
    expect(bill.receipts).toHaveLength(1);
    expect(bill.receipts[0].receiptId).toBe(receiptId);
  });

  it('createBill PRODUCT rejects receipt linkage from a different vendor', async () => {
    const { receiptLineId } = await makeReceiptWithLine(otherVendor);
    await expect(
      createBill(db, {
        vendorId: vendor.id,
        lines: [
          {
            variantId: variant.id,
            receiptLineId,
            description: 'wrong vendor',
            qty: '10',
            unitCost: '5',
          },
        ],
      }),
    ).rejects.toThrow(/Cross-vendor receipt link/);
  });

  it('createBill EXPENSE happy path: lines carry expenseAccountId, no variant', async () => {
    const bill = await createBill(db, {
      vendorId: vendor.id,
      source: BillSource.EXPENSE,
      lines: [
        {
          expenseAccountId: officeExpenseId,
          description: 'Paper supplies',
          qty: '1',
          unitCost: '100',
        },
        {
          expenseAccountId: utilitiesExpenseId,
          description: 'Internet',
          qty: '1',
          unitCost: '50',
        },
      ],
    });
    expect(bill.source).toBe(BillSource.EXPENSE);
    expect(bill.subtotal.toString()).toBe(new Prisma.Decimal('150').toString());
    expect(bill.lines).toHaveLength(2);
  });

  it('createBill EXPENSE rejects non-EXPENSE GL account on a line', async () => {
    const arAccount = await db.glAccount.findFirstOrThrow({ where: { code: '1210' } });
    await expect(
      createBill(db, {
        vendorId: vendor.id,
        source: BillSource.EXPENSE,
        lines: [
          {
            expenseAccountId: arAccount.id,
            description: 'wrong type',
            qty: '1',
            unitCost: '10',
          },
        ],
      }),
    ).rejects.toThrow(/Non-expense GlAccount/);
  });

  it('createBill validation: cross-source line rejected (PRODUCT bill with EXPENSE line)', async () => {
    await expect(
      createBill(db, {
        vendorId: vendor.id,
        source: BillSource.PRODUCT,
        lines: [
          {
            expenseAccountId: officeExpenseId,
            description: 'wrong shape',
            qty: '1',
            unitCost: '10',
          },
        ],
      }),
    ).rejects.toThrow(/EXPENSE lines not allowed on a PRODUCT bill/);
  });

  it('createBill validation: line with neither variantId nor expenseAccountId rejected', async () => {
    await expect(
      createBill(db, {
        vendorId: vendor.id,
        lines: [
          {
            description: 'orphan',
            qty: '1',
            unitCost: '10',
          },
        ],
      }),
    ).rejects.toThrow(/Exactly one of variantId or expenseAccountId is required/);
  });

  it('createBill rejects header freight > 0 (pilot scope)', async () => {
    await expect(
      createBill(db, {
        vendorId: vendor.id,
        freight: '5',
        lines: [
          {
            variantId: variant.id,
            description: 'x',
            qty: '1',
            unitCost: '10',
          },
        ],
      }),
    ).rejects.toThrow(/freight\/tax must be 0 in pilot scope/);
  });

  it('createBill rejects soft-deleted vendor', async () => {
    await db.vendor.update({
      where: { id: vendor.id },
      data: { deletedAt: new Date() },
    });
    await expect(
      createBill(db, {
        vendorId: vendor.id,
        lines: [
          {
            variantId: variant.id,
            description: 'x',
            qty: '1',
            unitCost: '10',
          },
        ],
      }),
    ).rejects.toThrow(/Vendor not found/);
  });

  // ---------- updateBill ----------

  it('updateBill replaces lines on DRAFT, recomputes subtotal+total', async () => {
    const bill = await createBill(db, {
      vendorId: vendor.id,
      lines: [
        { variantId: variant.id, description: 'a', qty: '1', unitCost: '10' },
      ],
    });
    const after = await updateBill(db, bill.id, {
      lines: [
        { variantId: variant.id, description: 'b', qty: '2', unitCost: '20' },
        { variantId: variant.id, description: 'c', qty: '3', unitCost: '30' },
      ],
    });
    expect(after.subtotal.toString()).toBe(new Prisma.Decimal('130').toString());
    expect(after.total.toString()).toBe(new Prisma.Decimal('130').toString());
    expect(after.lines).toHaveLength(2);
    expect(after.lines.map((l) => l.description).sort()).toEqual(['b', 'c']);
  });

  it('updateBill on CONFIRMED throws', async () => {
    const bill = await createBill(db, {
      vendorId: vendor.id,
      lines: [
        { variantId: variant.id, description: 'a', qty: '1', unitCost: '10' },
      ],
    });
    await confirmBill(db, bill.id);
    await expect(
      updateBill(db, bill.id, { vendorReference: 'INV-9' }),
    ).rejects.toThrow(/Cannot edit bill in status CONFIRMED/);
  });

  // ---------- confirmBill (PRODUCT) ----------

  it('confirmBill PRODUCT: DR 2020 / CR 2010 balanced JE, status flips, dueDate computed from NET30', async () => {
    const bill = await createBill(db, {
      vendorId: vendor.id,
      billDate: new Date(Date.UTC(2026, 4, 1)),
      lines: [
        { variantId: variant.id, description: 'x', qty: '4', unitCost: '25' },
      ],
    });
    const after = await confirmBill(db, bill.id);
    expect(after.status).toBe(BillStatus.CONFIRMED);
    expect(after.confirmedAt).not.toBeNull();
    expect(after.dueDate).not.toBeNull();
    // NET30 from 2026-05-01 = 2026-05-31.
    expect(after.dueDate?.toISOString().slice(0, 10)).toBe('2026-05-31');

    const je = await db.journalEntry.findFirstOrThrow({
      where: { entityType: 'Bill', entityId: bill.id },
      include: { lines: { include: { account: true } } },
    });
    assertBalanced(je);
    expect(je.lines).toHaveLength(2);
    const accruedDr = je.lines.find((l) => l.account.code === '2020');
    const apCr = je.lines.find((l) => l.account.code === '2010');
    expect(accruedDr?.debit.toString()).toBe(new Prisma.Decimal('100').toString());
    expect(apCr?.credit.toString()).toBe(new Prisma.Decimal('100').toString());

    const auditRows = await db.auditLog.findMany({
      where: { entityType: 'Bill', entityId: bill.id, action: AuditAction.BILL_CONFIRMED },
    });
    expect(auditRows).toHaveLength(1);
  });

  it('confirmBill EXPENSE: DR each expenseAccount / CR 2010 balanced JE, multi-line groups by account', async () => {
    const bill = await createBill(db, {
      vendorId: vendor.id,
      source: BillSource.EXPENSE,
      lines: [
        {
          expenseAccountId: officeExpenseId,
          description: 'paper',
          qty: '1',
          unitCost: '40',
        },
        {
          expenseAccountId: officeExpenseId,
          description: 'pens',
          qty: '1',
          unitCost: '20',
        },
        {
          expenseAccountId: utilitiesExpenseId,
          description: 'internet',
          qty: '1',
          unitCost: '90',
        },
      ],
    });
    const after = await confirmBill(db, bill.id);
    expect(after.status).toBe(BillStatus.CONFIRMED);

    const je = await db.journalEntry.findFirstOrThrow({
      where: { entityType: 'Bill', entityId: bill.id },
      include: { lines: { include: { account: true } } },
    });
    assertBalanced(je);
    // 5500 grouped (40+20=60) + 5510 (90) + 2010 CR (150) = 3 lines
    expect(je.lines).toHaveLength(3);
    const office = je.lines.find((l) => l.account.code === '5500');
    const util = je.lines.find((l) => l.account.code === '5510');
    const ap = je.lines.find((l) => l.account.code === '2010');
    expect(office?.debit.toString()).toBe(new Prisma.Decimal('60').toString());
    expect(util?.debit.toString()).toBe(new Prisma.Decimal('90').toString());
    expect(ap?.credit.toString()).toBe(new Prisma.Decimal('150').toString());
  });

  it('confirmBill on already-confirmed throws', async () => {
    const bill = await createBill(db, {
      vendorId: vendor.id,
      lines: [
        { variantId: variant.id, description: 'x', qty: '1', unitCost: '10' },
      ],
    });
    await confirmBill(db, bill.id);
    await expect(confirmBill(db, bill.id)).rejects.toThrow(/Cannot confirm/);
  });

  it('confirmBill leaves dueDate null when vendor has no payment term', async () => {
    await db.vendor.update({
      where: { id: vendor.id },
      data: { paymentTermId: null },
    });
    const bill = await createBill(db, {
      vendorId: vendor.id,
      lines: [
        { variantId: variant.id, description: 'x', qty: '1', unitCost: '10' },
      ],
    });
    const after = await confirmBill(db, bill.id);
    expect(after.dueDate).toBeNull();
  });

  // ---------- cancelBill ----------

  it('cancelBill on DRAFT: status flip only, no JE', async () => {
    const bill = await createBill(db, {
      vendorId: vendor.id,
      lines: [
        { variantId: variant.id, description: 'x', qty: '1', unitCost: '10' },
      ],
    });
    const after = await cancelBill(db, bill.id, 'mistake');
    expect(after.status).toBe(BillStatus.CANCELLED);
    expect(after.cancelReason).toBe('mistake');
    const jes = await db.journalEntry.findMany({
      where: { entityType: 'Bill', entityId: bill.id },
    });
    expect(jes).toHaveLength(0);
  });

  it('cancelBill on CONFIRMED PRODUCT: posts offsetting JE (CR 2020 / DR 2010), original retains reversedAt:null', async () => {
    const bill = await createBill(db, {
      vendorId: vendor.id,
      lines: [
        { variantId: variant.id, description: 'x', qty: '2', unitCost: '25' },
      ],
    });
    await confirmBill(db, bill.id);
    const originalJe = await db.journalEntry.findFirstOrThrow({
      where: { entityType: 'Bill', entityId: bill.id },
    });

    await cancelBill(db, bill.id, 'vendor pulled invoice');

    const allJes = await db.journalEntry.findMany({
      where: { entityType: 'Bill', entityId: bill.id },
      include: { lines: { include: { account: true } } },
    });
    expect(allJes).toHaveLength(2);
    for (const je of allJes) assertBalanced(je);
    const reverseJe = allJes.find((j) => j.id !== originalJe.id);
    const accruedCr = reverseJe?.lines.find((l) => l.account.code === '2020');
    const apDr = reverseJe?.lines.find((l) => l.account.code === '2010');
    expect(accruedCr?.credit.toString()).toBe(new Prisma.Decimal('50').toString());
    expect(apDr?.debit.toString()).toBe(new Prisma.Decimal('50').toString());

    // Original retained.
    const originalAfter = await db.journalEntry.findUniqueOrThrow({
      where: { id: originalJe.id },
    });
    expect(originalAfter.reversedAt).toBeNull();
  });

  it('cancelBill refuses without reason', async () => {
    const bill = await createBill(db, {
      vendorId: vendor.id,
      lines: [
        { variantId: variant.id, description: 'x', qty: '1', unitCost: '10' },
      ],
    });
    await expect(cancelBill(db, bill.id, '')).rejects.toThrow(/non-empty reason/);
  });

  it('cancelBill refuses CONFIRMED with amountPaid > 0', async () => {
    const bill = await createBill(db, {
      vendorId: vendor.id,
      lines: [
        { variantId: variant.id, description: 'x', qty: '1', unitCost: '10' },
      ],
    });
    await confirmBill(db, bill.id);
    // Manually bump amountPaid (the BillPayment service ships in slice D;
    // for now we simulate the denorm directly to exercise the guard).
    await db.bill.update({
      where: { id: bill.id },
      data: { amountPaid: new Prisma.Decimal('5') },
    });
    await expect(cancelBill(db, bill.id, 'oops')).rejects.toThrow(
      /applied payments or credits/,
    );
  });

  // ---------- softDelete ----------

  it('softDeleteBill on DRAFT marks deletedAt; on CONFIRMED throws', async () => {
    const draft = await createBill(db, {
      vendorId: vendor.id,
      lines: [
        { variantId: variant.id, description: 'x', qty: '1', unitCost: '10' },
      ],
    });
    const deleted = await softDeleteBill(db, draft.id);
    expect(deleted.deletedAt).not.toBeNull();

    const draft2 = await createBill(db, {
      vendorId: vendor.id,
      lines: [
        { variantId: variant.id, description: 'x', qty: '1', unitCost: '10' },
      ],
    });
    await confirmBill(db, draft2.id);
    await expect(softDeleteBill(db, draft2.id)).rejects.toThrow(
      /Cancel CONFIRMED bills instead/,
    );
  });

  // ---------- listBills + getBill ----------

  it('listBills filters by vendor + status + source; excludes soft-deleted', async () => {
    const billA = await createBill(db, {
      vendorId: vendor.id,
      lines: [
        { variantId: variant.id, description: 'a', qty: '1', unitCost: '10' },
      ],
    });
    const billB = await createBill(db, {
      vendorId: vendor.id,
      source: BillSource.EXPENSE,
      lines: [
        {
          expenseAccountId: officeExpenseId,
          description: 'b',
          qty: '1',
          unitCost: '20',
        },
      ],
    });
    await confirmBill(db, billB.id);
    const billC = await createBill(db, {
      vendorId: otherVendor.id,
      lines: [
        { variantId: variant.id, description: 'c', qty: '1', unitCost: '30' },
      ],
    });
    await softDeleteBill(db, billC.id);

    const ourVendorBills = await listBills(db, { vendorId: vendor.id });
    const ids = ourVendorBills.map((b) => b.id).sort();
    expect(ids).toEqual([billA.id, billB.id].sort());

    const expenseOnly = await listBills(db, { source: BillSource.EXPENSE });
    expect(expenseOnly.find((b) => b.id === billB.id)).toBeDefined();
    expect(expenseOnly.find((b) => b.id === billA.id)).toBeUndefined();

    const drafts = await listBills(db, {
      vendorId: vendor.id,
      status: BillStatus.DRAFT,
    });
    expect(drafts.find((b) => b.id === billA.id)).toBeDefined();
    expect(drafts.find((b) => b.id === billB.id)).toBeUndefined();

    // Soft-deleted billC absent from any listing.
    const allOther = await listBills(db, { vendorId: otherVendor.id });
    expect(allOther.find((b) => b.id === billC.id)).toBeUndefined();
  });

  it('getBill returns null for soft-deleted; returns full include otherwise', async () => {
    const bill = await createBill(db, {
      vendorId: vendor.id,
      lines: [
        { variantId: variant.id, description: 'x', qty: '1', unitCost: '10' },
      ],
    });
    const fetched = await getBill(db, bill.id);
    expect(fetched?.id).toBe(bill.id);
    expect(fetched?.lines).toHaveLength(1);
    await softDeleteBill(db, bill.id);
    const after = await getBill(db, bill.id);
    expect(after).toBeNull();
  });

  // ---------- DB-level CHECK constraint ----------

  it('BillLine_source_xor CHECK rejects raw insert with both variantId and expenseAccountId', async () => {
    const bill = await createBill(db, {
      vendorId: vendor.id,
      lines: [
        { variantId: variant.id, description: 'x', qty: '1', unitCost: '10' },
      ],
    });
    await expect(
      db.$executeRaw`
        INSERT INTO "BillLine"
          ("id", "billId", "lineNumber", "variantId", "expenseAccountId",
           "description", "qty", "unitCost", "lineTotal", "createdAt", "updatedAt")
        VALUES
          ('test-xor-violator', ${bill.id}, 99, ${variant.id}, ${officeExpenseId},
           'illegal', 1, 10, 10, NOW(), NOW())
      `,
    ).rejects.toThrow(/BillLine_source_xor/);
  });
});

async function wipe(db: PrismaClient): Promise<void> {
  // Bills + their JEs + audit + lines + receipt/PO joins.
  const ourBills = await db.bill.findMany({
    where: { vendor: { code: { startsWith: `${TAG}-VEN` } } },
    select: { id: true },
  });
  if (ourBills.length > 0) {
    const billIds = ourBills.map((b) => b.id);
    const billJes = await db.journalEntry.findMany({
      where: { entityType: 'Bill', entityId: { in: billIds } },
      select: { id: true },
    });
    if (billJes.length > 0) {
      const jeIds = billJes.map((j) => j.id);
      await db.journalEntryLine.deleteMany({
        where: { journalEntryId: { in: jeIds } },
      });
      await db.journalEntry.deleteMany({ where: { id: { in: jeIds } } });
    }
    await db.billReceipt.deleteMany({ where: { billId: { in: billIds } } });
    await db.billPurchaseOrder.deleteMany({ where: { billId: { in: billIds } } });
    await db.billLine.deleteMany({ where: { billId: { in: billIds } } });
    await db.auditLog.deleteMany({
      where: { entityType: 'Bill', entityId: { in: billIds } },
    });
    await db.bill.deleteMany({ where: { id: { in: billIds } } });
  }

  // Receipts created in this slice (their inventoryMovements / fifo
  // layers stay null because we bypass postReceipt).
  const ourReceipts = await db.receipt.findMany({
    where: { number: { startsWith: `${TAG}-RCPT-` } },
    select: { id: true },
  });
  if (ourReceipts.length > 0) {
    const rIds = ourReceipts.map((r) => r.id);
    await db.receiptLine.deleteMany({ where: { receiptId: { in: rIds } } });
    await db.receipt.deleteMany({ where: { id: { in: rIds } } });
  }

  // Sequence row for "bill" — keep as-is. Sequence helper handles
  // year-rollover; cleaning it here would just force a re-seed and
  // doesn't help test isolation since BILL-YYYY-NNNNN uniqueness is
  // global per year, not per test run.
}
