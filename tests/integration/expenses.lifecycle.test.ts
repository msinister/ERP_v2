import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  BillPaymentStatus,
  BillSource,
  BillStatus,
  PaymentMethod,
  Prisma,
  VendorType,
} from '@/generated/tenant';
import type { GlAccount, PrismaClient } from '@/generated/tenant';
import { logExpense, logExpenseBatch } from '@/server/services/expenses';
import { hasTenantDb, makeClient } from '../helpers/db';
import { wipeBillArtifactsForVendors } from '../helpers/wipeBillArtifacts';

const suite = hasTenantDb ? describe : describe.skip;
const TAG = 'TEST-EXP';

function assertBalanced(je: {
  lines: Array<{ debit: Prisma.Decimal; credit: Prisma.Decimal }>;
}): void {
  const dr = je.lines.reduce((a, l) => a.plus(l.debit), new Prisma.Decimal(0));
  const cr = je.lines.reduce((a, l) => a.plus(l.credit), new Prisma.Decimal(0));
  if (!dr.equals(cr)) {
    throw new Error(`JE not balanced: debits=${dr} credits=${cr}`);
  }
}

// Auto-created expense vendors get auto-issued codes, so scope cleanup by
// the test-tagged NAME prefix rather than code.
async function wipe(db: PrismaClient): Promise<void> {
  const vendors = await db.vendor.findMany({
    where: { name: { startsWith: TAG } },
    select: { id: true },
  });
  const ids = vendors.map((v) => v.id);
  await wipeBillArtifactsForVendors(db, ids);
  await db.vendor.deleteMany({ where: { id: { in: ids } } });
}

suite('Quick Expense logger', () => {
  let db: PrismaClient;
  let expenseAccount: GlAccount; // 5500 EXPENSE
  let cashAccount: GlAccount; // 1110 ASSET
  let ccAccount: GlAccount; // 2030 LIABILITY (stand-in credit-card payable)

  beforeAll(async () => {
    db = makeClient();
    expenseAccount = await db.glAccount.findFirstOrThrow({
      where: { code: '5500' },
    });
    cashAccount = await db.glAccount.findFirstOrThrow({
      where: { code: '1110' },
    });
    ccAccount = await db.glAccount.findFirstOrThrow({ where: { code: '2030' } });
  });

  beforeEach(async () => {
    await wipe(db);
  });

  afterAll(async () => {
    await wipe(db);
    await db.$disconnect();
  });

  it('find-or-creates a SERVICE vendor, books DR expense / CR cash, bill PAID', async () => {
    const name = `${TAG} Coffee Shop`;
    const result = await logExpense(db, {
      vendorName: name,
      amount: '42.18',
      expenseAccountId: expenseAccount.id,
      paymentAccountId: cashAccount.id,
      notes: 'Team coffee',
    });
    expect(result.billNumber).toMatch(/^BILL-\d{4}-\d{5}$/);

    const vendor = await db.vendor.findUniqueOrThrow({
      where: { id: result.vendorId },
    });
    expect(vendor.type).toBe(VendorType.SERVICE);
    expect(vendor.name).toBe(name);

    const bill = await db.bill.findUniqueOrThrow({
      where: { id: result.billId },
      include: { lines: true, payments: true },
    });
    expect(bill.source).toBe(BillSource.EXPENSE);
    expect(bill.status).toBe(BillStatus.CONFIRMED);
    expect(bill.paymentStatus).toBe(BillPaymentStatus.PAID);
    expect(bill.total.toString()).toBe(new Prisma.Decimal('42.18').toString());
    expect(bill.lines).toHaveLength(1);
    expect(bill.lines[0].expenseAccountId).toBe(expenseAccount.id);
    expect(bill.payments).toHaveLength(1);
    expect(bill.payments[0].cashAccountId).toBe(cashAccount.id);
    expect(bill.payments[0].method).toBe(PaymentMethod.CASH);

    // Confirm JE: DR 5500 expense / CR 2010 AP.
    const confirmJe = await db.journalEntry.findFirstOrThrow({
      where: { entityType: 'Bill', entityId: bill.id },
      include: { lines: { include: { account: true } } },
    });
    assertBalanced(confirmJe);
    expect(
      confirmJe.lines.find((l) => l.account.code === '5500')?.debit.toString(),
    ).toBe(new Prisma.Decimal('42.18').toString());
    expect(
      confirmJe.lines.find((l) => l.account.code === '2010')?.credit.toString(),
    ).toBe(new Prisma.Decimal('42.18').toString());

    // Payment JE: DR 2010 AP / CR 1110 cash.
    const payJe = await db.journalEntry.findFirstOrThrow({
      where: { entityType: 'BillPayment', entityId: bill.payments[0].id },
      include: { lines: { include: { account: true } } },
    });
    assertBalanced(payJe);
    expect(
      payJe.lines.find((l) => l.account.code === '2010')?.debit.toString(),
    ).toBe(new Prisma.Decimal('42.18').toString());
    expect(
      payJe.lines.find((l) => l.account.code === '1110')?.credit.toString(),
    ).toBe(new Prisma.Decimal('42.18').toString());
  });

  it('reuses an existing vendor by name (case-insensitive)', async () => {
    const name = `${TAG} Staples`;
    const first = await logExpense(db, {
      vendorName: name,
      amount: '10',
      expenseAccountId: expenseAccount.id,
      paymentAccountId: cashAccount.id,
    });
    const second = await logExpense(db, {
      vendorName: name.toUpperCase(),
      amount: '20',
      expenseAccountId: expenseAccount.id,
      paymentAccountId: cashAccount.id,
    });
    expect(second.vendorId).toBe(first.vendorId);
    const count = await db.vendor.count({
      where: { name: { equals: name, mode: 'insensitive' }, deletedAt: null },
    });
    expect(count).toBe(1);
  });

  it('derives method CREDIT_CARD for a LIABILITY payment account', async () => {
    const result = await logExpense(db, {
      vendorName: `${TAG} Uber`,
      amount: '23.40',
      expenseAccountId: expenseAccount.id,
      paymentAccountId: ccAccount.id,
    });
    const pay = await db.billPayment.findFirstOrThrow({
      where: { billId: result.billId },
    });
    expect(pay.method).toBe(PaymentMethod.CREDIT_CARD);
    expect(pay.cashAccountId).toBe(ccAccount.id);
  });

  it('logExpenseBatch logs every row', async () => {
    const results = await logExpenseBatch(db, [
      {
        vendorName: `${TAG} Batch A`,
        amount: '5',
        expenseAccountId: expenseAccount.id,
        paymentAccountId: cashAccount.id,
      },
      {
        vendorName: `${TAG} Batch B`,
        amount: '7.50',
        expenseAccountId: expenseAccount.id,
        paymentAccountId: cashAccount.id,
      },
    ]);
    expect(results).toHaveLength(2);
    for (const r of results) {
      const bill = await db.bill.findUniqueOrThrow({ where: { id: r.billId } });
      expect(bill.source).toBe(BillSource.EXPENSE);
      expect(bill.paymentStatus).toBe(BillPaymentStatus.PAID);
    }
  });

  it('logExpenseBatch rolls back ALL rows when one is invalid', async () => {
    await expect(
      logExpenseBatch(db, [
        {
          vendorName: `${TAG} Good Row`,
          amount: '5',
          expenseAccountId: expenseAccount.id,
          paymentAccountId: cashAccount.id,
        },
        {
          vendorName: `${TAG} Bad Row`,
          amount: '5',
          expenseAccountId: 'does-not-exist',
          paymentAccountId: cashAccount.id,
        },
      ]),
    ).rejects.toThrow(/Row 2/);

    // Atomicity: the good row must not have committed.
    const leaked = await db.vendor.findFirst({
      where: { name: `${TAG} Good Row` },
    });
    expect(leaked).toBeNull();
  });
});
