'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { StatusBadge } from '@/components/shared/status-badge';
import { formatCurrency } from '@/lib/format';

// Money fields are plain numbers, not Prisma.Decimal: this is a client
// component and Decimal instances lose their methods crossing the RSC
// boundary. The page derives them (with Decimal precision) and converts
// to number for display + comparison here.
export type PaymentRowData = {
  id: string;
  number: string;
  receivedAt: Date;
  customerId: string;
  customerCode: string;
  customerName: string;
  method: string;
  reference: string | null;
  amount: number;
  // Sum of non-reversed application amounts (correct for both cash and
  // applied-credit payments; the Payment.appliedAmount denorm stays 0
  // for APPLIED_CREDIT so we derive from applications instead).
  applied: number;
  unapplied: number;
  status: string;
  // Source SO for row navigation: the first non-reversed application's
  // invoice → salesOrder. Null when the payment is unapplied or none of
  // its invoices still link to a live SO → row falls back to the detail.
  sourceSalesOrderId: string | null;
};

const METHOD_LABELS: Record<string, string> = {
  CREDIT_CARD: 'Credit card',
  ACH: 'ACH',
  WIRE: 'Wire',
  CHECK: 'Check',
  CASH: 'Cash',
  MONEY_ORDER: 'Money order',
  APPLIED_CREDIT: 'Applied credit',
};

export function PaymentsTable({ rows }: { rows: PaymentRowData[] }) {
  const router = useRouter();

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border p-12 text-center text-sm text-muted-foreground">
        No payments match these filters.
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/30 hover:bg-muted/30">
            <TableHead>Payment #</TableHead>
            <TableHead>Date</TableHead>
            <TableHead>Customer</TableHead>
            <TableHead>Method</TableHead>
            <TableHead>Reference</TableHead>
            <TableHead className="text-right">Amount</TableHead>
            <TableHead className="text-right">Applied</TableHead>
            <TableHead className="text-right">Unapplied</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            // Row navigates to the source SO (per spec); fall back to the
            // payment detail when there's no live SO link.
            const rowHref = row.sourceSalesOrderId
              ? `/sales-orders/${row.sourceSalesOrderId}`
              : `/payments/${row.id}`;
            const showAmber = row.status === 'RECORDED' && row.unapplied > 0;
            return (
              <TableRow
                key={row.id}
                className="cursor-pointer hover:bg-muted/50"
                onClick={() => router.push(rowHref)}
              >
                <TableCell className="font-mono text-xs">
                  {/* Distinct link to the payment detail; stops the row's
                      SO navigation so both destinations stay reachable. */}
                  <Link
                    href={`/payments/${row.id}`}
                    onClick={(e) => e.stopPropagation()}
                    className="text-primary hover:underline"
                  >
                    {row.number}
                  </Link>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {formatDate(row.receivedAt)}
                </TableCell>
                <TableCell>
                  <div className="flex flex-col text-sm leading-tight">
                    <span className="font-medium">{row.customerName}</span>
                    <span className="font-mono text-[10px] text-muted-foreground">
                      {row.customerCode}
                    </span>
                  </div>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {METHOD_LABELS[row.method] ?? row.method}
                </TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  {row.reference ?? '—'}
                </TableCell>
                <TableCell className="text-right tabular-nums font-medium">
                  {formatCurrency(row.amount)}
                </TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">
                  {formatCurrency(row.applied)}
                </TableCell>
                <TableCell
                  className={
                    'text-right tabular-nums ' +
                    (showAmber
                      ? 'font-semibold text-amber-600'
                      : 'text-muted-foreground')
                  }
                >
                  {row.status === 'RECORDED'
                    ? formatCurrency(row.unapplied)
                    : '—'}
                </TableCell>
                <TableCell>
                  <StatusBadge entityType="Payment" status={row.status} />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

function formatDate(d: Date): string {
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}
