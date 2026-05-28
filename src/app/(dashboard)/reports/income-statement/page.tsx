import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import type { Prisma } from '@/generated/tenant';
import { db } from '@/lib/db';
import { requirePagePermission } from '@/lib/permissions/requirePagePermission';
import { incomeStatement } from '@/server/services/reports/financial';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { DateRangeFilter } from '../_components/date-range-filter';
import {
  addDaysUtc,
  formatDateDisplay,
  formatDateInput,
  formatInclusiveEnd,
  parseDateInput,
  todayUtc,
  yearStartUtc,
} from '../_lib/dates';
import { formatAccountingAmount } from '../_lib/format';
import { formatCurrency } from '@/lib/format';

export const revalidate = 0;

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function pick(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

export default async function IncomeStatementPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  await requirePagePermission('reports.view_financial');
  const sp = await searchParams;
  const todayStr = formatDateInput(todayUtc());
  const yearStartStr = formatDateInput(yearStartUtc());
  const fromStr = pick(sp.from) ?? yearStartStr;
  const toStr = pick(sp.to) ?? todayStr;

  const fromParsed = parseDateInput(fromStr);
  const toParsed = parseDateInput(toStr);
  const toExclusive = toParsed ? addDaysUtc(toParsed, 1) : null;

  const report =
    fromParsed && toExclusive
      ? await incomeStatement(db, { from: fromParsed, to: toExclusive })
      : null;

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
            Income Statement
          </h1>
          <p className="text-sm text-muted-foreground">
            Revenue and expense activity for a period, with net income at the
            bottom. Refunds and reversals appear as negative activity on their
            originating account.
          </p>
        </div>
      </div>

      <DateRangeFilter
        from={fromStr}
        to={toStr}
        action="/reports/income-statement"
      />

      {report ? (
        <ReportBody report={report} />
      ) : (
        <p className="text-sm text-destructive">
          Invalid date range. Pick a from / through date and run again.
        </p>
      )}
    </div>
  );
}

function ReportBody({
  report,
}: {
  report: Awaited<ReturnType<typeof incomeStatement>>;
}) {
  return (
    <div className="space-y-4">
      <div className="text-xs text-muted-foreground">
        Window:{' '}
        {report.asOfFrom ? (
          <>
            <span className="text-foreground">
              {formatDateDisplay(report.asOfFrom)}
            </span>{' '}
            through{' '}
            <span className="text-foreground">
              {formatInclusiveEnd(report.asOfTo)}
            </span>
          </>
        ) : (
          <>
            through{' '}
            <span className="text-foreground">
              {formatInclusiveEnd(report.asOfTo)}
            </span>
          </>
        )}
      </div>

      <IsTable
        title="Revenue"
        rows={report.revenue.rows}
        total={report.revenue.total}
        totalLabel="Total revenue"
      />
      <IsTable
        title="Expenses"
        rows={report.expenses.rows}
        total={report.expenses.total}
        totalLabel="Total expenses"
      />

      <div className="rounded-lg border border-border bg-muted/20 p-4 text-sm">
        <div className="flex items-center justify-between">
          <span className="font-medium">Net income</span>
          <span
            className={`tabular-nums font-medium ${
              report.netIncome.isNegative() ? 'text-destructive' : ''
            }`}
          >
            {formatAccountingAmount(report.netIncome)}
          </span>
        </div>
      </div>
    </div>
  );
}

function IsTable({
  title,
  rows,
  total,
  totalLabel,
}: {
  title: string;
  rows: Array<{
    accountId: string;
    accountCode: string;
    accountName: string;
    amount: Prisma.Decimal;
  }>;
  total: Prisma.Decimal;
  totalLabel: string;
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
              <TableHead className="text-right">Amount</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={2}
                  className="text-center text-muted-foreground"
                >
                  No activity.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((r) => (
                <TableRow key={r.accountId}>
                  <TableCell>
                    <span className="font-mono text-xs text-muted-foreground">
                      {r.accountCode}
                    </span>{' '}
                    {r.accountName}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatAccountingAmount(r.amount)}
                  </TableCell>
                </TableRow>
              ))
            )}
            <TableRow className="bg-muted/30 hover:bg-muted/30">
              <TableCell className="font-medium">{totalLabel}</TableCell>
              <TableCell className="text-right tabular-nums font-medium">
                {formatCurrency(total)}
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
