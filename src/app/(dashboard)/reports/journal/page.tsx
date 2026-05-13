import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { db } from '@/lib/db';
import { journalReport } from '@/server/services/reports/financial';
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
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
import { Prisma } from '@/generated/tenant';

export const revalidate = 0;

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function pick(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

export default async function JournalReportPage({
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
  const toExclusive = toParsed ? addDaysUtc(toParsed, 1) : null;

  const report =
    fromParsed && toExclusive
      ? await journalReport(db, {
          from: fromParsed,
          to: toExclusive,
          take: 500,
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
          <h1 className="text-2xl font-semibold tracking-tight">Journal</h1>
          <p className="text-sm text-muted-foreground">
            Every posted journal entry in the period with all of its lines.
            Capped at 500 entries — narrow the window if you hit the cap.
          </p>
        </div>
      </div>

      <DateRangeFilter from={fromStr} to={toStr} action="/reports/journal" />

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
  report: Awaited<ReturnType<typeof journalReport>>;
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
        )}{' '}
        · {report.entries.length}{' '}
        {report.entries.length === 1 ? 'entry' : 'entries'}
        {report.entries.length === 500 ? ' (capped)' : ''}
      </div>

      {report.entries.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
          No journal entries in this window.
        </div>
      ) : (
        <div className="space-y-3">
          {report.entries.map((e) => (
            <EntryBlock key={e.id} entry={e} />
          ))}
        </div>
      )}
    </div>
  );
}

function EntryBlock({
  entry,
}: {
  entry: Awaited<ReturnType<typeof journalReport>>['entries'][number];
}) {
  const totalDebit = entry.lines.reduce(
    (acc, l) => acc.plus(l.debit),
    new Prisma.Decimal(0),
  );
  const totalCredit = entry.lines.reduce(
    (acc, l) => acc.plus(l.credit),
    new Prisma.Decimal(0),
  );

  return (
    <div className="rounded-lg border border-border">
      <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-border bg-muted/20 px-4 py-2">
        <div className="flex items-baseline gap-3">
          <span className="font-mono text-xs">{entry.number}</span>
          <span className="text-sm font-medium">{entry.description}</span>
          {entry.reversedAt ? (
            <Badge variant="destructive">Reversed</Badge>
          ) : null}
        </div>
        <div className="text-xs text-muted-foreground">
          {formatDateTime(entry.postedAt)} · {entry.entityType}
        </div>
      </div>
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>Account</TableHead>
            <TableHead>Memo</TableHead>
            <TableHead className="text-right">Debit</TableHead>
            <TableHead className="text-right">Credit</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {entry.lines.map((l, i) => (
            <TableRow key={i}>
              <TableCell>
                <span className="font-mono text-xs text-muted-foreground">
                  {l.accountCode}
                </span>{' '}
                {l.accountName}
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">
                {l.memo ?? ''}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatDrCrCell(l.debit)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatDrCrCell(l.credit)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
        <TableFooter>
          <TableRow>
            <TableCell colSpan={2} className="font-medium">
              Totals
            </TableCell>
            <TableCell className="text-right tabular-nums font-medium">
              {formatDrCrCell(totalDebit)}
            </TableCell>
            <TableCell className="text-right tabular-nums font-medium">
              {formatDrCrCell(totalCredit)}
            </TableCell>
          </TableRow>
        </TableFooter>
      </Table>
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
