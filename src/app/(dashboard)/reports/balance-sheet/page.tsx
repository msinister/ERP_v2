import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import type { Prisma } from '@/generated/tenant';
import { db } from '@/lib/db';
import { requirePagePermission } from '@/lib/permissions/requirePagePermission';
import { balanceSheet } from '@/server/services/reports/financial';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { AsOfFilter } from '../_components/date-range-filter';
import {
  addDaysUtc,
  formatDateInput,
  formatInclusiveEnd,
  parseDateInput,
  todayUtc,
} from '../_lib/dates';
import { formatAccountingAmount } from '../_lib/format';
import { formatCurrency } from '@/lib/format';

export const revalidate = 0;

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function pick(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

export default async function BalanceSheetPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  await requirePagePermission('reports.view_financial');
  const sp = await searchParams;
  const todayStr = formatDateInput(todayUtc());
  const asOfStr = pick(sp.asOf) ?? todayStr;
  const asOfParsed = parseDateInput(asOfStr);
  // Service uses exclusive `asOf` (lt). User picking "May 13" means
  // "include everything through end of May 13" — shift forward one day.
  const asOfExclusive = asOfParsed ? addDaysUtc(asOfParsed, 1) : null;

  const report = asOfExclusive ? await balanceSheet(db, asOfExclusive) : null;

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Link
          href="/reports"
          className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="size-3.5" />
          Reports
        </Link>
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            Balance Sheet
          </h1>
          <p className="text-sm text-muted-foreground">
            Assets, liabilities, and equity as of an end-of-day point in time.
            Current-period earnings reflect undistributed Revenue − Expenses
            since inception; closes into retained earnings at fiscal year-end.
          </p>
        </div>
      </div>

      <AsOfFilter asOf={asOfStr} action="/reports/balance-sheet" />

      {report ? (
        <ReportBody report={report} />
      ) : (
        <p className="text-sm text-destructive">
          Invalid as-of date. Pick a date and run again.
        </p>
      )}
    </div>
  );
}

function ReportBody({
  report,
}: {
  report: Awaited<ReturnType<typeof balanceSheet>>;
}) {
  const balanced = report.imbalance.equals(0);

  return (
    <div className="space-y-4">
      <div className="text-xs text-muted-foreground">
        As of{' '}
        <span className="text-foreground">
          {formatInclusiveEnd(report.asOf)}
        </span>
      </div>

      <BsTable
        title="Assets"
        rows={report.assets.rows}
        total={report.assets.total}
        totalLabel="Total assets"
      />
      <BsTable
        title="Liabilities"
        rows={report.liabilities.rows}
        total={report.liabilities.total}
        totalLabel="Total liabilities"
      />
      <BsTable
        title="Equity"
        rows={report.equity.rows}
        total={report.equity.total}
        totalLabel="Total equity"
        extraRow={{
          label: 'Current-period earnings',
          value: report.equity.currentPeriodEarnings,
        }}
      />

      <div className="rounded-lg border border-border bg-muted/20 p-4 text-sm">
        <div className="flex items-center justify-between">
          <span className="font-medium">Total liabilities + equity</span>
          <span className="tabular-nums font-medium">
            {formatCurrency(report.totalLiabilitiesAndEquity)}
          </span>
        </div>
        <div className="mt-1 flex items-center justify-between text-xs text-muted-foreground">
          <span>Imbalance (Assets − L+E)</span>
          <span className="tabular-nums">
            {formatAccountingAmount(report.imbalance)}
          </span>
        </div>
      </div>

      {!balanced ? (
        <p className="text-sm text-destructive">
          ⚠ Balance sheet does not balance. Investigate before trusting
          downstream reports.
        </p>
      ) : null}
    </div>
  );
}

function BsTable({
  title,
  rows,
  total,
  totalLabel,
  extraRow,
}: {
  title: string;
  rows: Array<{
    accountId: string;
    accountCode: string;
    accountName: string;
    balance: Prisma.Decimal;
  }>;
  total: Prisma.Decimal;
  totalLabel: string;
  extraRow?: { label: string; value: Prisma.Decimal };
}) {
  return (
    <div className="space-y-2">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h2>
      <div className="rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/30 hover:bg-muted/30">
              <TableHead>Account</TableHead>
              <TableHead className="text-right">Balance</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 && !extraRow ? (
              <TableRow>
                <TableCell colSpan={2} className="text-center text-muted-foreground">
                  No balances.
                </TableCell>
              </TableRow>
            ) : (
              <>
                {rows.map((r) => (
                  <TableRow key={r.accountId}>
                    <TableCell>
                      <span className="font-mono text-xs text-muted-foreground">
                        {r.accountCode}
                      </span>{' '}
                      {r.accountName}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatAccountingAmount(r.balance)}
                    </TableCell>
                  </TableRow>
                ))}
                {extraRow ? (
                  <TableRow>
                    <TableCell className="italic text-muted-foreground">
                      {extraRow.label}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatAccountingAmount(extraRow.value)}
                    </TableCell>
                  </TableRow>
                ) : null}
              </>
            )}
            <TableRow className="bg-muted/30 hover:bg-muted/30">
              <TableCell className="font-medium">{totalLabel}</TableCell>
              <TableCell className="text-right tabular-nums font-medium">
                {formatAccountingAmount(total)}
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
