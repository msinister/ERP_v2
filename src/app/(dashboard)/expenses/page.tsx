import { AccountType } from '@/generated/tenant';
import { db } from '@/lib/db';
import { listAccounts } from '@/server/services/glAccounts';
import { listVendors } from '@/server/services/vendors';
import { listPaymentTerms } from '@/server/services/paymentTerms';
import {
  listExpensesPaged,
  getExpenseCategoryUsage,
} from '@/server/services/expenses';
import { BillsPagination } from '../bills/_components/pagination';
import { ExpenseSingleEntry } from './_components/expense-single-entry';
import { ExpenseBulkPaste } from './_components/expense-bulk-paste';
import { ExpenseFilters } from './_components/expense-filters';
import {
  ExpenseTable,
  type ExpenseRowData,
} from './_components/expense-table';
import type {
  AccountOption,
  CategoryOption,
} from './_components/types';

export const revalidate = 0;

const DEFAULT_PAGE_SIZE = 25;

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function pickString(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v ?? undefined;
}

function parseDateInput(
  v: string | undefined,
  endOfDay: boolean,
): Date | undefined {
  if (!v) return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return undefined;
  const [, y, mo, d] = m;
  const date = new Date(Number(y), Number(mo) - 1, Number(d));
  if (endOfDay) date.setHours(23, 59, 59, 999);
  return date;
}

export default async function ExpensesPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const sp = await searchParams;
  const vendorId = pickString(sp.vendorId);
  const expenseAccountId = pickString(sp.category);
  const dateFrom = parseDateInput(pickString(sp.dateFrom), false);
  const dateTo = parseDateInput(pickString(sp.dateTo), true);
  const skip = Math.max(0, Number(pickString(sp.skip) ?? '0') || 0);
  const take = DEFAULT_PAGE_SIZE;

  const [allAccounts, vendors, paymentTermsRaw, usage, page] =
    await Promise.all([
      listAccounts(db, { active: true, take: 500 }),
      listVendors(db, { active: true, take: 1000 }),
      listPaymentTerms(db, { active: true }),
      getExpenseCategoryUsage(db),
      listExpensesPaged(db, {
        vendorId,
        expenseAccountId,
        billDateFrom: dateFrom,
        billDateTo: dateTo,
        skip,
        take,
      }),
    ]);

  // Category dropdown = EXPENSE accounts, most-used first (then by code).
  const categories: CategoryOption[] = allAccounts
    .filter((a) => a.type === AccountType.EXPENSE)
    .map((a) => ({
      id: a.id,
      code: a.code,
      name: a.name,
      uses: usage.get(a.id) ?? 0,
    }))
    .sort((a, b) => b.uses - a.uses || a.code.localeCompare(b.code));

  // Payment account dropdown = cash/bank (ASSET) + credit-card payable
  // (LIABILITY), same set the bill record-payment picker offers.
  const paymentAccounts: AccountOption[] = allAccounts
    .filter(
      (a) => a.type === AccountType.ASSET || a.type === AccountType.LIABILITY,
    )
    .map((a) => ({ id: a.id, code: a.code, name: a.name }));

  const vendorPickerOptions = vendors.map((v) => ({
    id: v.id,
    code: v.code,
    name: v.name,
  }));
  const vendorFilterOptions = vendors.map((v) => ({
    id: v.id,
    label: `${v.name} (${v.code})`,
  }));
  const paymentTerms = paymentTermsRaw.map((t) => ({
    id: t.id,
    label: t.netDays === null ? t.label : `${t.label} (net ${t.netDays})`,
  }));

  const rows: ExpenseRowData[] = page.rows.map((r) => ({
    billId: r.billId,
    billNumber: r.billNumber,
    billDate: r.billDate,
    vendorName: r.vendorName,
    vendorCode: r.vendorCode,
    amount: r.amount.toString(),
    categoryCode: r.categoryCode,
    categoryName: r.categoryName,
    paymentAccountCode: r.paymentAccountCode,
    paymentAccountName: r.paymentAccountName,
  }));

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Expenses</h1>
        <p className="text-sm text-muted-foreground">
          Log credit-card charges and small expenses fast. Each entry creates
          a confirmed expense bill and records its payment in one step.
        </p>
      </div>

      <ExpenseSingleEntry
        vendors={vendorPickerOptions}
        paymentTerms={paymentTerms}
        categories={categories}
        paymentAccounts={paymentAccounts}
      />

      <ExpenseBulkPaste
        categories={categories}
        paymentAccounts={paymentAccounts}
      />

      <div className="space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground">
          Recent expenses
        </h2>
        <ExpenseFilters
          vendors={vendorFilterOptions}
          categories={categories}
        />
        <ExpenseTable rows={rows} />
        <BillsPagination
          total={page.total}
          skip={skip}
          take={take}
          basePath="/expenses"
        />
      </div>
    </div>
  );
}
