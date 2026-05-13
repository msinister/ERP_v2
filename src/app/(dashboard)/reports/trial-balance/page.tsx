import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { db } from '@/lib/db';
import { trialBalance } from '@/server/services/reports/financial';
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
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
import { formatDrCrCell } from '../_lib/format';
import { formatCurrency } from '@/lib/format';

export const revalidate = 0;

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function pick(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

export default async function TrialBalancePage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const sp = await searchParams;
  const todayStr = formatDateInput(todayUtc());
  const yearStartStr = formatDateInput(yearStartUtc());
  const fromStr = pick(sp.from) ?? yearStartStr;
  const toStr = pick(sp.to) ?? todayStr;

  const fromParsed = parseDateInput(fromStr);
  const toParsed = parseDateInput(toStr);

  // Service treats `to` as exclusive (lt). The form's "Through" field
  // is inclusive — shift forward one day before calling.
  const toExclusive = toParsed ? addDaysUtc(toParsed, 1) : null;

  const report =
    fromParsed && toExclusive
      ? await trialBalance(db, { from: fromParsed, to: toExclusive })
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
            Trial Balance
          </h1>
          <p className="text-sm text-muted-foreground">
            Per-account beginning, period activity, and ending balances.
            Total debits must equal total credits — if they don&apos;t,{' '}
            <code className="rounded bg-muted px-1 text-xs">lib/gl/post()</code>{' '}
            has been bypassed somewhere.
          </p>
        </div>
      </div>

      <DateRangeFilter
        from={fromStr}
        to={toStr}
        action="/reports/trial-balance"
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
  report: Awaited<ReturnType<typeof trialBalance>>;
}) {
  const balanced = report.totals.totalEndingDebit.equals(
    report.totals.totalEndingCredit,
  );

  return (
    <div className="space-y-3">
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

      {report.rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
          No activity in this window.
        </div>
      ) : (
        <div className="rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/30 hover:bg-muted/30">
                <TableHead>Account</TableHead>
                <TableHead className="text-right">Beg. debit</TableHead>
                <TableHead className="text-right">Beg. credit</TableHead>
                <TableHead className="text-right">Period debit</TableHead>
                <TableHead className="text-right">Period credit</TableHead>
                <TableHead className="text-right">End. debit</TableHead>
                <TableHead className="text-right">End. credit</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {report.rows.map((r) => (
                <TableRow key={r.accountId}>
                  <TableCell>
                    <span className="font-mono text-xs text-muted-foreground">
                      {r.accountCode}
                    </span>{' '}
                    {r.accountName}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatDrCrCell(r.beginningDebit)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatDrCrCell(r.beginningCredit)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatDrCrCell(r.periodDebits)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatDrCrCell(r.periodCredits)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums font-medium">
                    {formatDrCrCell(r.endingDebit)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums font-medium">
                    {formatDrCrCell(r.endingCredit)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell className="font-medium">Totals</TableCell>
                <TableCell className="text-right tabular-nums font-medium">
                  {formatCurrency(report.totals.totalBeginningDebit)}
                </TableCell>
                <TableCell className="text-right tabular-nums font-medium">
                  {formatCurrency(report.totals.totalBeginningCredit)}
                </TableCell>
                <TableCell className="text-right tabular-nums font-medium">
                  {formatCurrency(report.totals.totalPeriodDebits)}
                </TableCell>
                <TableCell className="text-right tabular-nums font-medium">
                  {formatCurrency(report.totals.totalPeriodCredits)}
                </TableCell>
                <TableCell className="text-right tabular-nums font-medium">
                  {formatCurrency(report.totals.totalEndingDebit)}
                </TableCell>
                <TableCell className="text-right tabular-nums font-medium">
                  {formatCurrency(report.totals.totalEndingCredit)}
                </TableCell>
              </TableRow>
            </TableFooter>
          </Table>
        </div>
      )}

      {!balanced ? (
        <p className="text-sm text-destructive">
          ⚠ Ending debits and credits do not match. This is a data-integrity
          issue — investigate before trusting other reports.
        </p>
      ) : null}
    </div>
  );
}
