import {
  AccountType,
  BillSource,
  PaymentMethod,
  PaymentStatus,
  Prisma,
} from '@/generated/tenant';
import type { PrismaClient } from '@/generated/tenant';
import type { AuditContext } from '@/lib/audit/audit';
import {
  logExpenseInputSchema,
  type LogExpenseInput,
} from '@/lib/validation/expenses';
import { createBillTx, confirmBillTx } from './bills';
import { recordBillPaymentTx } from './billPayments';
import { createVendorTx } from './vendors';

// =============================================================================
// Quick Expense Logger service. An expense = an EXPENSE-source bill that is
// created, confirmed, and paid in a single transaction:
//
//   createBillTx (EXPENSE, one line)  → DR <expenseAccount> / CR 2010 AP
//   confirmBillTx                     → posts the above + sets dueDate
//   recordBillPaymentTx               → DR 2010 AP / CR <paymentAccount>
//
// Net GL effect: DR <expenseAccount> / CR <paymentAccount> — exactly what a
// credit-card charge or petty-cash spend should book. Doing it in one
// transaction means a half-logged expense (confirmed bill with no payment)
// is impossible.
// =============================================================================

export type LogExpenseResult = {
  billId: string;
  billNumber: string;
  vendorId: string;
  vendorName: string;
};

// Preferred default term for an auto-created expense vendor — expenses are
// paid on the spot, so COD is the natural fit. Falls back to any active
// term when COD isn't configured (createVendor requires a paymentTermId).
const PREFERRED_VENDOR_TERM_CODE = 'COD';

async function resolveExpenseVendorTx(
  tx: Prisma.TransactionClient,
  args: { vendorId?: string; vendorName?: string },
  ctx?: AuditContext,
): Promise<{ id: string; name: string }> {
  if (args.vendorId) {
    const v = await tx.vendor.findFirst({
      where: { id: args.vendorId, deletedAt: null },
      select: { id: true, name: true },
    });
    if (!v) throw new Error(`Vendor not found: ${args.vendorId}`);
    return v;
  }

  const name = (args.vendorName ?? '').trim();
  if (name === '') throw new Error('A vendor id or name is required');

  // Find-or-create by case-insensitive name. Oldest match wins if the
  // (rare) duplicate-name case exists.
  const existing = await tx.vendor.findFirst({
    where: { name: { equals: name, mode: 'insensitive' }, deletedAt: null },
    select: { id: true, name: true },
    orderBy: { createdAt: 'asc' },
  });
  if (existing) return existing;

  const term =
    (await tx.paymentTerm.findFirst({
      where: { code: PREFERRED_VENDOR_TERM_CODE, deletedAt: null, active: true },
      select: { id: true },
    })) ??
    (await tx.paymentTerm.findFirst({
      where: { deletedAt: null, active: true },
      orderBy: { code: 'asc' },
      select: { id: true },
    }));
  if (!term) {
    throw new Error(
      'No active payment term configured — add one under Admin → Payment terms first',
    );
  }

  const created = await createVendorTx(
    tx,
    { name, type: 'SERVICE', paymentTermId: term.id },
    ctx,
  );
  return { id: created.id, name: created.name };
}

export async function logExpenseTx(
  tx: Prisma.TransactionClient,
  input: LogExpenseInput,
  ctx?: AuditContext,
): Promise<LogExpenseResult> {
  const data = logExpenseInputSchema.parse(input);
  const date = data.date ?? new Date();

  const vendor = await resolveExpenseVendorTx(
    tx,
    { vendorId: data.vendorId, vendorName: data.vendorName },
    ctx,
  );

  // Payment method is a record-only label; derive a sensible one from the
  // chosen account type — LIABILITY (a credit-card payable) → CREDIT_CARD,
  // ASSET (cash/bank) → CASH. recordBillPaymentTx re-validates the account.
  const paymentAccount = await tx.glAccount.findUnique({
    where: { id: data.paymentAccountId },
    select: { type: true },
  });
  const method =
    paymentAccount?.type === AccountType.LIABILITY
      ? PaymentMethod.CREDIT_CARD
      : PaymentMethod.CASH;

  // EXPENSE lines require a description; fall back to the vendor name when
  // the operator didn't type a note.
  const description = (data.notes ?? '').trim() || vendor.name;

  const bill = await createBillTx(
    tx,
    {
      vendorId: vendor.id,
      source: BillSource.EXPENSE,
      billDate: date,
      notes: data.notes,
      lines: [
        {
          expenseAccountId: data.expenseAccountId,
          description,
          qty: '1',
          unitCost: data.amount,
          notes: data.notes,
        },
      ],
    },
    ctx,
  );

  await confirmBillTx(tx, bill.id, ctx);

  await recordBillPaymentTx(
    tx,
    {
      billId: bill.id,
      amount: data.amount,
      method,
      cashAccountId: data.paymentAccountId,
      paymentDate: date,
      notes: data.notes,
    },
    ctx,
  );

  return {
    billId: bill.id,
    billNumber: bill.number,
    vendorId: vendor.id,
    vendorName: vendor.name,
  };
}

export async function logExpense(
  db: PrismaClient,
  input: LogExpenseInput,
  ctx?: AuditContext,
): Promise<LogExpenseResult> {
  return db.$transaction((tx) => logExpenseTx(tx, input, ctx), {
    timeout: 20000,
  });
}

// Atomic batch: all rows succeed or none do. A single bad row (e.g. an
// invalid GL account) rolls the whole paste back so a bank-statement import
// can't be half-applied. The error message names the offending row index.
export async function logExpenseBatch(
  db: PrismaClient,
  inputs: LogExpenseInput[],
  ctx?: AuditContext,
): Promise<LogExpenseResult[]> {
  return db.$transaction(
    async (tx) => {
      const results: LogExpenseResult[] = [];
      for (let i = 0; i < inputs.length; i++) {
        try {
          results.push(await logExpenseTx(tx, inputs[i], ctx));
        } catch (e) {
          const msg = e instanceof Error ? e.message : 'unknown error';
          throw new Error(`Row ${i + 1}: ${msg}`);
        }
      }
      return results;
    },
    // Generous ceiling — each row does ~4 round-trips; a large paste runs
    // sequentially inside one transaction.
    { timeout: 120000 },
  );
}

// ---------------------------------------------------------------------------
// Expense list — a filtered view of EXPENSE-source bills, joined to the
// line's expense account (category) and the payment's cash account.
// ---------------------------------------------------------------------------

export type ExpenseListFilters = {
  vendorId?: string;
  expenseAccountId?: string;
  billDateFrom?: Date;
  billDateTo?: Date;
  skip?: number;
  take?: number;
};

export type ExpenseRow = {
  billId: string;
  billNumber: string;
  billDate: Date;
  vendorId: string;
  vendorCode: string;
  vendorName: string;
  amount: Prisma.Decimal;
  categoryCode: string | null;
  categoryName: string | null;
  paymentAccountCode: string | null;
  paymentAccountName: string | null;
};

export async function listExpensesPaged(
  db: PrismaClient,
  filters: ExpenseListFilters = {},
): Promise<{ rows: ExpenseRow[]; total: number }> {
  const {
    skip = 0,
    take = 25,
    vendorId,
    expenseAccountId,
    billDateFrom,
    billDateTo,
  } = filters;

  const dateFilter: { gte?: Date; lte?: Date } = {};
  if (billDateFrom) dateFilter.gte = billDateFrom;
  if (billDateTo) dateFilter.lte = billDateTo;

  const where: Prisma.BillWhereInput = {
    deletedAt: null,
    source: BillSource.EXPENSE,
    ...(vendorId ? { vendorId } : {}),
    ...(expenseAccountId
      ? { lines: { some: { expenseAccountId, deletedAt: null } } }
      : {}),
    ...(billDateFrom || billDateTo ? { billDate: dateFilter } : {}),
  };

  const [bills, total] = await Promise.all([
    db.bill.findMany({
      where,
      include: {
        vendor: { select: { id: true, code: true, name: true } },
        lines: {
          where: { deletedAt: null },
          orderBy: { lineNumber: 'asc' },
          include: { expenseAccount: { select: { code: true, name: true } } },
        },
        payments: {
          where: { status: PaymentStatus.RECORDED },
          orderBy: { createdAt: 'asc' },
          include: { cashAccount: { select: { code: true, name: true } } },
        },
      },
      orderBy: [{ billDate: 'desc' }, { createdAt: 'desc' }],
      skip,
      take: Math.min(take, 200),
    }),
    db.bill.count({ where }),
  ]);

  const rows: ExpenseRow[] = bills.map((b) => {
    const line = b.lines[0] ?? null;
    const payment = b.payments[0] ?? null;
    return {
      billId: b.id,
      billNumber: b.number,
      billDate: b.billDate,
      vendorId: b.vendor.id,
      vendorCode: b.vendor.code,
      vendorName: b.vendor.name,
      amount: b.total,
      categoryCode: line?.expenseAccount?.code ?? null,
      categoryName: line?.expenseAccount?.name ?? null,
      paymentAccountCode: payment?.cashAccount?.code ?? null,
      paymentAccountName: payment?.cashAccount?.name ?? null,
    };
  });

  return { rows, total };
}

// Usage counts per expense GL account across existing EXPENSE bills, so the
// category dropdown can float the most-used categories to the top. Keyed by
// account id.
export async function getExpenseCategoryUsage(
  db: PrismaClient,
): Promise<Map<string, number>> {
  const grouped = await db.billLine.groupBy({
    by: ['expenseAccountId'],
    where: {
      deletedAt: null,
      expenseAccountId: { not: null },
      bill: { source: BillSource.EXPENSE, deletedAt: null },
    },
    _count: { _all: true },
  });
  const map = new Map<string, number>();
  for (const g of grouped) {
    if (g.expenseAccountId) map.set(g.expenseAccountId, g._count._all);
  }
  return map;
}
