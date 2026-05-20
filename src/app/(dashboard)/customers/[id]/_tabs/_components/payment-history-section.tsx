import Link from 'next/link';
import { Printer } from 'lucide-react';
import { Prisma } from '@/generated/tenant';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatCurrency } from '@/lib/format';
import { SectionPagination } from './section-pagination';

// One row per Payment. `applications` holds the live + reversed
// CreditApplications already eagerly-loaded with invoice/SO links,
// so the "Applied to" cell renders without an extra round-trip.
export type PaymentHistoryRow = {
  id: string;
  number: string;
  receivedAt: Date;
  amount: Prisma.Decimal;
  appliedAmount: Prisma.Decimal;
  method: string;
  status: string;
  reference: string | null;
  notes: string | null;
  reversedAt: Date | null;
  reversedReason: string | null;
  applications: Array<{
    invoiceNumber: string;
    salesOrderId: string | null;
    amount: Prisma.Decimal;
    reversedAt: Date | null;
  }>;
};

export function PaymentHistorySection({
  rows,
  total,
  skip,
  take,
  basePath,
}: {
  rows: PaymentHistoryRow[];
  total: number;
  skip: number;
  take: number;
  basePath: string;
}) {
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold text-muted-foreground">
        Payment history
      </h2>
      {rows.length === 0 && skip === 0 ? (
        <div className="rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
          No payments recorded for this customer yet.
        </div>
      ) : (
        <>
          <div className="rounded-lg border border-border">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/30 hover:bg-muted/30">
                  <TableHead>Date</TableHead>
                  <TableHead>Payment #</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Method</TableHead>
                  <TableHead>Reference</TableHead>
                  <TableHead>Applied to</TableHead>
                  <TableHead>Notes</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-0" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((p) => {
                  const reversed = p.status === 'REVERSED';
                  return (
                    <TableRow
                      key={p.id}
                      className={reversed ? 'opacity-60' : ''}
                    >
                      <TableCell className="text-muted-foreground">
                        {formatDate(p.receivedAt)}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {p.number}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatCurrency(p.amount)}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {formatMethod(p.method)}
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {p.reference ?? '—'}
                      </TableCell>
                      <TableCell className="text-xs">
                        <AppliedToCell
                          payment={p}
                        />
                      </TableCell>
                      <TableCell
                        className="max-w-[24ch] truncate text-xs text-muted-foreground"
                        title={p.notes ?? undefined}
                      >
                        {p.notes ?? '—'}
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={p.status} />
                        {reversed && p.reversedReason ? (
                          <div
                            className="mt-0.5 max-w-[16ch] truncate text-[10px] text-muted-foreground"
                            title={p.reversedReason}
                          >
                            {p.reversedReason}
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-right">
                        <Link
                          href={`/print/payments/${p.id}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center text-muted-foreground hover:text-foreground"
                          aria-label={`Print receipt for payment ${p.number}`}
                          title="Print receipt"
                        >
                          <Printer className="size-4" />
                        </Link>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
          <SectionPagination
            total={total}
            skip={skip}
            take={take}
            basePath={basePath}
            paramName="payHistorySkip"
            itemLabel="payments"
          />
        </>
      )}
    </section>
  );
}

// Renders the invoice(s) this payment was applied to. Most common
// case is a single live application; we also handle unapplied
// (=> "Unapplied"), reversed applications, and the rare multi-
// invoice case. Invoice numbers link to their SO when present (the
// SO detail page hosts the live invoice view today; orphaned post-
// reopen invoices render as plain text).
function AppliedToCell({ payment }: { payment: PaymentHistoryRow }) {
  if (payment.applications.length === 0) {
    return <span className="text-muted-foreground">Unapplied</span>;
  }
  return (
    <div className="space-y-0.5">
      {payment.applications.map((a, i) => (
        <div
          key={i}
          className={a.reversedAt ? 'opacity-60 line-through' : ''}
        >
          {a.salesOrderId ? (
            <Link
              href={`/sales-orders/${a.salesOrderId}`}
              className="font-mono text-primary hover:underline"
            >
              {a.invoiceNumber}
            </Link>
          ) : (
            <span className="font-mono">{a.invoiceNumber}</span>
          )}
          <span className="ml-1 tabular-nums text-muted-foreground">
            {formatCurrency(a.amount)}
          </span>
        </div>
      ))}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  if (status === 'RECORDED') return <Badge variant="secondary">Recorded</Badge>;
  if (status === 'REVERSED') {
    return (
      <Badge variant="outline" className="text-muted-foreground">
        Reversed
      </Badge>
    );
  }
  return <Badge variant="outline">{status}</Badge>;
}

function formatMethod(value: string): string {
  if (value === 'CREDIT_CARD') return 'Credit card';
  if (value === 'MONEY_ORDER') return 'Money order';
  if (value === 'APPLIED_CREDIT') return 'Applied credit';
  return value.charAt(0) + value.slice(1).toLowerCase();
}

function formatDate(d: Date): string {
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}
