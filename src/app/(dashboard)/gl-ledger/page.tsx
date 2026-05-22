import Link from 'next/link';
import { AccountType } from '@/generated/tenant';
import { db } from '@/lib/db';
import {
  listGlAccountsForLedger,
  listMoneyAccountsWithBalances,
  getAccountLedger,
  naturalBalance,
  isDebitNormal,
  type LedgerAccountWithBalance,
} from '@/server/services/glLedger';
import { formatCurrency } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Card, CardContent } from '@/components/ui/card';
import { BillsPagination } from '../bills/_components/pagination';
import { AccountSelector } from './_components/account-selector';
import { LedgerFilters } from './_components/ledger-filters';
import {
  TransactionRegister,
  type RegisterRowData,
} from './_components/transaction-register';
import type { SelectorAccount } from './_components/types';

export const revalidate = 0;

const DEFAULT_PAGE_SIZE = 50;

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function pickString(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v ?? undefined;
}

function parseDateInput(v: string | undefined, endOfDay: boolean): Date | undefined {
  if (!v) return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return undefined;
  const [, y, mo, d] = m;
  const date = new Date(Number(y), Number(mo) - 1, Number(d));
  if (endOfDay) date.setHours(23, 59, 59, 999);
  return date;
}

// Code-range buckets: cash = ASSET 1100-1199, credit card = LIABILITY
// 2100-2199 (per the chart-of-accounts convention). Everything else is
// "other" (still selectable, just not in the quick filters / overview).
function bucketOf(type: AccountType, code: string): 'cash' | 'card' | 'other' {
  const n = Number(code);
  if (Number.isNaN(n)) return 'other';
  if (type === AccountType.ASSET && n >= 1100 && n <= 1199) return 'cash';
  if (type === AccountType.LIABILITY && n >= 2100 && n <= 2199) return 'card';
  return 'other';
}

// Source deep-link prefixes by JE entityType. linkId is pre-resolved by the
// service (BillPayment → its bill, AccountTransfer → the JE). Unmapped types
// (e.g. Invoice, COGS movements) render as plain text.
const SOURCE_PREFIX: Record<string, string> = {
  Bill: 'bills',
  BillPayment: 'bills',
  Payment: 'payments',
  CreditMemo: 'credit-memos',
  VendorCredit: 'vendor-credits',
  Rma: 'rmas',
  SalesOrder: 'sales-orders',
  PurchaseOrder: 'purchase-orders',
  Receipt: 'receipts',
  InventoryAdjustment: 'inventory-adjustments',
  AccountTransfer: 'transfers',
};

function hrefFor(entityType: string, linkId: string | null): string | null {
  if (!linkId) return null;
  const prefix = SOURCE_PREFIX[entityType];
  return prefix ? `/${prefix}/${linkId}` : null;
}

export default async function GlLedgerPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const sp = await searchParams;
  const accountParam = pickString(sp.account);
  const dateFrom = parseDateInput(pickString(sp.dateFrom), false);
  const dateTo = parseDateInput(pickString(sp.dateTo), true);
  const skip = Math.max(0, Number(pickString(sp.skip) ?? '0') || 0);
  const take = DEFAULT_PAGE_SIZE;

  const [allAccounts, moneyAccounts] = await Promise.all([
    listGlAccountsForLedger(db),
    listMoneyAccountsWithBalances(db),
  ]);

  const selectorAccounts: SelectorAccount[] = allAccounts.map((a) => ({
    id: a.id,
    code: a.code,
    name: a.name,
    type: a.type,
    bucket: bucketOf(a.type, a.code),
  }));

  // Resolve the selected account: ?account when valid, else first cash
  // account, else first asset, else first account overall.
  const valid = (id: string | undefined) =>
    id && selectorAccounts.some((a) => a.id === id) ? id : undefined;
  const firstCash = selectorAccounts.find((a) => a.bucket === 'cash');
  const firstAsset = selectorAccounts.find((a) => a.type === AccountType.ASSET);
  const selectedId =
    valid(accountParam) ??
    firstCash?.id ??
    firstAsset?.id ??
    selectorAccounts[0]?.id ??
    null;

  if (!selectedId) {
    return (
      <div className="space-y-6">
        <Header />
        <div className="rounded-lg border border-dashed border-border p-12 text-center text-sm text-muted-foreground">
          No GL accounts configured yet.
        </div>
      </div>
    );
  }

  const ledger = await getAccountLedger(db, {
    accountId: selectedId,
    from: dateFrom,
    to: dateTo,
    skip,
    take,
  });
  if (!ledger) {
    return (
      <div className="space-y-6">
        <Header />
        <div className="rounded-lg border border-dashed border-border p-12 text-center text-sm text-muted-foreground">
          Account not found.
        </div>
      </div>
    );
  }

  const cashAccounts = moneyAccounts.filter(
    (a) => bucketOf(a.type, a.code) === 'cash',
  );
  const cardAccounts = moneyAccounts.filter(
    (a) => bucketOf(a.type, a.code) === 'card',
  );

  const rows: RegisterRowData[] = ledger.rows.map((r) => ({
    jeId: r.jeId,
    postedAt: r.postedAt,
    description: r.description,
    memo: r.memo,
    reference: r.reference,
    jeNumber: r.jeNumber,
    href: hrefFor(r.entityType, r.linkId),
    debit: r.debit.greaterThan(0) ? r.debit.toString() : null,
    credit: r.credit.greaterThan(0) ? r.credit.toString() : null,
    runningBalance: naturalBalance(
      r.signedRunningBalance,
      ledger.account.type,
    ).toString(),
  }));

  const currentNatural = naturalBalance(
    ledger.currentSignedBalance,
    ledger.account.type,
  );
  const isLiability = ledger.account.type === AccountType.LIABILITY;

  return (
    <div className="space-y-6">
      <Header />

      {cashAccounts.length > 0 || cardAccounts.length > 0 ? (
        <div className="space-y-3">
          {cashAccounts.length > 0 ? (
            <OverviewGroup
              label="Cash & bank"
              accounts={cashAccounts}
              selectedId={selectedId}
            />
          ) : null}
          {cardAccounts.length > 0 ? (
            <OverviewGroup
              label="Credit cards"
              accounts={cardAccounts}
              selectedId={selectedId}
            />
          ) : null}
        </div>
      ) : null}

      <AccountSelector accounts={selectorAccounts} selectedId={selectedId} />

      <Card>
        <CardContent className="flex flex-wrap items-end justify-between gap-4 py-5">
          <div>
            <div className="text-sm font-medium">{ledger.account.name}</div>
            <div className="font-mono text-xs text-muted-foreground">
              {ledger.account.code}
            </div>
          </div>
          <div className="text-right">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Current balance
            </div>
            <div
              className={cn(
                'text-3xl font-semibold tabular-nums',
                balanceColor(currentNatural.toString(), ledger.account.type),
              )}
            >
              {formatCurrency(currentNatural.toString())}
              {isLiability ? (
                <span className="ml-2 text-sm font-normal text-muted-foreground">
                  (owed)
                </span>
              ) : null}
            </div>
          </div>
        </CardContent>
      </Card>

      <LedgerFilters />

      <TransactionRegister rows={rows} />

      <BillsPagination
        total={ledger.total}
        skip={skip}
        take={take}
        basePath="/gl-ledger"
      />
    </div>
  );
}

function Header() {
  return (
    <div className="space-y-1">
      <h1 className="text-2xl font-semibold tracking-tight">GL Ledger</h1>
      <p className="text-sm text-muted-foreground">
        Detailed transaction register for any GL account, with a running
        balance. Built for reconciling cash and credit-card accounts.
      </p>
    </div>
  );
}

function OverviewGroup({
  label,
  accounts,
  selectedId,
}: {
  label: string;
  accounts: LedgerAccountWithBalance[];
  selectedId: string;
}) {
  return (
    <div className="space-y-2">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {accounts.map((a) => {
          const natural = naturalBalance(a.signedBalance, a.type);
          const isLiability = a.type === AccountType.LIABILITY;
          return (
            <Link
              key={a.id}
              href={`/gl-ledger?account=${a.id}`}
              className={cn(
                'rounded-lg border p-3 transition-colors hover:bg-muted/40',
                a.id === selectedId
                  ? 'border-primary ring-1 ring-primary/30'
                  : 'border-border',
              )}
            >
              <div className="truncate text-sm font-medium">{a.name}</div>
              <div className="font-mono text-[10px] text-muted-foreground">
                {a.code}
              </div>
              <div
                className={cn(
                  'mt-1 text-lg font-semibold tabular-nums',
                  balanceColor(natural.toString(), a.type),
                )}
              >
                {formatCurrency(natural.toString())}
                {isLiability ? (
                  <span className="ml-1 text-[11px] font-normal text-muted-foreground">
                    owed
                  </span>
                ) : null}
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

// Cash (debit-normal) shows green when positive, red when overdrawn.
// Liabilities (credit-cards) show red/amber when a balance is owed.
function balanceColor(naturalStr: string, type: AccountType): string {
  const n = Number(naturalStr);
  if (isDebitNormal(type)) {
    return n < 0 ? 'text-destructive' : 'text-emerald-600 dark:text-emerald-500';
  }
  // Credit-normal (liability): owed (positive natural) reads as amber/red.
  if (n > 0) return 'text-amber-600 dark:text-amber-500';
  if (n < 0) return 'text-emerald-600 dark:text-emerald-500';
  return '';
}
