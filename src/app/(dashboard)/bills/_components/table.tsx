import Link from 'next/link';
import type { Prisma } from '@/generated/tenant';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { formatCurrency, formatStatusLabel } from '@/lib/format';

export type BillRowData = {
  id: string;
  number: string;
  vendorId: string;
  vendorCode: string;
  vendorName: string;
  vendorReference: string | null;
  billDate: Date;
  dueDate: Date | null;
  status: string;
  paymentStatus: string;
  source: string;
  total: Prisma.Decimal;
  balance: Prisma.Decimal;
};

export function BillsTable({ rows }: { rows: BillRowData[] }) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border p-12 text-center text-sm text-muted-foreground">
        No bills match these filters.
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/30 hover:bg-muted/30">
            <TableHead>Bill #</TableHead>
            <TableHead>Vendor</TableHead>
            <TableHead>Vendor ref</TableHead>
            <TableHead>Bill date</TableHead>
            <TableHead>Due</TableHead>
            <TableHead>Source</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Payment</TableHead>
            <TableHead className="text-right">Total</TableHead>
            <TableHead className="text-right">Balance</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow
              key={row.id}
              className="relative cursor-pointer hover:bg-muted/50"
            >
              <TableCell className="font-mono text-xs">
                {/* Stretched-link overlay — target is the detail page
                    added in 7B. */}
                <Link
                  href={`/bills/${row.id}`}
                  className="absolute inset-0 rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  <span className="sr-only">View {row.number}</span>
                </Link>
                {row.number}
              </TableCell>
              <TableCell>
                <div className="flex flex-col text-sm leading-tight">
                  <span className="font-medium">{row.vendorName}</span>
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {row.vendorCode}
                  </span>
                </div>
              </TableCell>
              <TableCell className="font-mono text-xs text-muted-foreground">
                {row.vendorReference ?? '—'}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {formatDate(row.billDate)}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {row.dueDate ? formatDate(row.dueDate) : '—'}
              </TableCell>
              <TableCell>
                <Badge variant="outline" className="text-muted-foreground">
                  {row.source === 'PRODUCT' ? 'Product' : 'Expense'}
                </Badge>
              </TableCell>
              <TableCell>
                <StatusBadge status={row.status} />
              </TableCell>
              <TableCell>
                <PaymentStatusBadge
                  status={row.paymentStatus}
                  billStatus={row.status}
                />
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatCurrency(row.total)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {/* Balance is undefined until CONFIRMED (lines + total
                    are immutable on DRAFT but the AP entry doesn't
                    exist yet). CANCELLED bills have a balance of 0. */}
                {row.status === 'DRAFT'
                  ? '—'
                  : row.status === 'CANCELLED'
                    ? formatCurrency(0)
                    : formatCurrency(row.balance)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const label = formatStatusLabel(status);
  if (status === 'CONFIRMED') return <Badge>{label}</Badge>;
  if (status === 'CANCELLED') {
    return (
      <Badge variant="outline" className="text-muted-foreground">
        {label}
      </Badge>
    );
  }
  return <Badge variant="outline">{label}</Badge>;
}

function PaymentStatusBadge({
  status,
  billStatus,
}: {
  status: string;
  billStatus: string;
}) {
  // Payment status only meaningful on CONFIRMED bills.
  if (billStatus !== 'CONFIRMED') {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  const label = formatStatusLabel(status);
  if (status === 'PAID') return <Badge variant="secondary">{label}</Badge>;
  if (status === 'PARTIAL') return <Badge variant="outline">{label}</Badge>;
  return (
    <Badge variant="outline" className="text-muted-foreground">
      {label}
    </Badge>
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
