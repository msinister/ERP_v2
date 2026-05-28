import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { db } from '@/lib/db';
import { requirePagePermission } from '@/lib/permissions/requirePagePermission';
import { glDetail } from '@/server/services/reports/financial';
import { listAccounts } from '@/server/services/glAccounts';
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { AccountDateFilter } from '../_components/account-date-filter';
import {
  addDaysUtc,
  formatDateInput,
  formatInclusiveEnd,
  parseDateInput,
  todayUtc,
  yearStartUtc,
} from '../_lib/dates';
import { formatAccountingAmount, formatDrCrCell } from '../_lib/format';
import { formatCurrency } from '@/lib/format';

export const revalidate = 0;

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function pick(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

export default async function GlDetailPage({
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
  const accountCode = pick(sp.accountCode) ?? '';

  const fromParsed = parseDateInput(fromStr);
  const toParsed = parseDateInput(toStr);
  const toExclusive = toParsed ? addDaysUtc(toParsed, 1) : null;

  const accounts = await listAccounts(db, { active: true, take: 500 });
  const accountOptions = accounts.map((a) => ({ code: a.code, name: a.name }));
  const validAccount = accounts.some((a) => a.code === accountCode);

  // Service throws on unknown account codes — gate the call on a known
  // active code instead of try/catching the throw.
  const report =
    validAccount && fromParsed && toExclusive
      ? await glDetail(db, {
          accountCode,
          from: fromParsed,
          to: toExclusive,
        })
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
          <h1 className="text-2xl font-semibold tracking-tight">GL Detail</h1>
          <p className="text-sm text-muted-foreground">
            Posted journal-entry lines for a single account with a running
            balance. Reversal JEs are included — they&apos;re real history,
            and a reversed pair cancels out in the running total.
          </p>
        </div>
      </div>

      <AccountDateFilter
        accountCode={accountCode}
        accounts={accountOptions}
        from={fromStr}
        to={toStr}
        action="/reports/gl-detail"
      />

      {accountCode === '' ? (
        <div className="rounded-lg border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
          Pick an account above to run the report.
        </div>
      ) : !validAccount ? (
        <p className="text-sm text-destructive">
          Unknown or soft-deleted account: {accountCode}.
        </p>
      ) : !report ? (
        <p className="text-sm text-destructive">
          Invalid date range. Pick a from / through date and run again.
        </p>
      ) : (
        <ReportBody report={report} />
      )}
    </div>
  );
}

function ReportBody({
  report,
}: {
  report: Awaited<ReturnType<typeof glDetail>>;
}) {
  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-border bg-muted/20 p-3 text-sm">
        <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
          <div>
            <span className="font-mono text-xs text-muted-foreground">
              {report.accountCode}
            </span>{' '}
            <span className="font-medium">{report.accountName}</span>{' '}
            <span className="text-xs text-muted-foreground">
              ({report.accountType})
            </span>
          </div>
          <div className="text-xs text-muted-foreground">
            Through{' '}
            <span className="text-foreground">
              {formatInclusiveEnd(report.asOfTo)}
            </span>
          </div>
        </div>
        <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-muted-foreground md:grid-cols-4">
          <Stat
            label="Beginning balance"
            value={formatAccountingAmount(report.beginningBalance)}
          />
          <Stat
            label="Period debits"
            value={formatCurrency(report.totalDebits)}
          />
          <Stat
            label="Period credits"
            value={formatCurrency(report.totalCredits)}
          />
          <Stat
            label="Ending balance"
            value={formatAccountingAmount(report.endingBalance)}
            emphasize
          />
        </div>
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
                <TableHead>Posted</TableHead>
                <TableHead>JE</TableHead>
                <TableHead>Description</TableHead>
                <TableHead className="text-right">Debit</TableHead>
                <TableHead className="text-right">Credit</TableHead>
                <TableHead className="text-right">Running</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {report.rows.map((r, i) => (
                <TableRow key={`${r.jeId}-${i}`}>
                  <TableCell className="text-xs text-muted-foreground tabular-nums">
                    {formatDateTime(r.postedAt)}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {r.jeNumber}
                  </TableCell>
                  <TableCell>
                    {r.description}
                    {r.memo ? (
                      <div className="text-xs italic text-muted-foreground">
                        {r.memo}
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatDrCrCell(r.debit)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatDrCrCell(r.credit)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums font-medium">
                    {formatAccountingAmount(r.runningBalance)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell colSpan={3} className="font-medium">
                  Period totals
                </TableCell>
                <TableCell className="text-right tabular-nums font-medium">
                  {formatCurrency(report.totalDebits)}
                </TableCell>
                <TableCell className="text-right tabular-nums font-medium">
                  {formatCurrency(report.totalCredits)}
                </TableCell>
                <TableCell className="text-right tabular-nums font-medium">
                  {formatAccountingAmount(report.endingBalance)}
                </TableCell>
              </TableRow>
            </TableFooter>
          </Table>
        </div>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  emphasize = false,
}: {
  label: string;
  value: string;
  emphasize?: boolean;
}) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide">{label}</div>
      <div
        className={`tabular-nums ${
          emphasize ? 'text-foreground font-medium' : 'text-foreground'
        }`}
      >
        {value}
      </div>
    </div>
  );
}

function formatDateTime(d: Date): string {
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
  });
}
