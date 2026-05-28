import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import type { Prisma } from '@/generated/tenant';
import { db } from '@/lib/db';
import { requirePagePermission } from '@/lib/permissions/requirePagePermission';
import { salesByItem } from '@/server/services/reports/operational';
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { DateRangeFilter } from '../../_components/date-range-filter';
import {
  addDaysUtc,
  formatDateDisplay,
  formatDateInput,
  formatInclusiveEnd,
  parseDateInput,
  todayUtc,
  yearStartUtc,
} from '../../_lib/dates';
import { formatCount, formatCurrency } from '@/lib/format';

export const revalidate = 0;

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function pick(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

function formatQty(q: Prisma.Decimal): string {
  const s = q.toString();
  if (!s.includes('.')) return s;
  return s.replace(/\.?0+$/, '');
}

export default async function SalesByItemPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  await requirePagePermission('reports.view_operational');
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
      ? await salesByItem(db, { from: fromParsed, to: toExclusive })
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
            Sales by Item
          </h1>
          <p className="text-sm text-muted-foreground">
            Quantity sold and revenue per variant, from invoice lines on
            non-voided invoices. No COGS column in pilot — added in a later
            slice when profit margin reporting lands.
          </p>
        </div>
      </div>

      <DateRangeFilter
        from={fromStr}
        to={toStr}
        action="/reports/sales/by-item"
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
  report: Awaited<ReturnType<typeof salesByItem>>;
}) {
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
        )}{' '}
        · {formatCount(report.rows.length)}{' '}
        {report.rows.length === 1 ? 'variant' : 'variants'}
      </div>

      {report.rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
          No sales in this window.
        </div>
      ) : (
        <div className="rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/30 hover:bg-muted/30">
                <TableHead>SKU</TableHead>
                <TableHead>Name</TableHead>
                <TableHead className="text-right">Qty sold</TableHead>
                <TableHead className="text-right">Gross sales</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {report.rows.map((r) => (
                <TableRow key={r.variantId}>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {r.sku}
                  </TableCell>
                  <TableCell>{r.name ?? '—'}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatQty(r.qtySold)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums font-medium">
                    {formatCurrency(r.grossSales)}
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
                  {formatQty(report.totalQty)}
                </TableCell>
                <TableCell className="text-right tabular-nums font-medium">
                  {formatCurrency(report.totalGrossSales)}
                </TableCell>
              </TableRow>
            </TableFooter>
          </Table>
        </div>
      )}
    </div>
  );
}
