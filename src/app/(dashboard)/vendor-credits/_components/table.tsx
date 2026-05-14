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

export type VendorCreditRowData = {
  id: string;
  number: string;
  vendorId: string;
  vendorCode: string;
  vendorName: string;
  creditDate: Date;
  amount: Prisma.Decimal;
  appliedAmount: Prisma.Decimal;
  status: string;
  // Set when the VC was auto-created from an overpayment. We surface
  // this as an "Overpayment" badge so it's clear AP didn't enter it
  // manually.
  isOverpayment: boolean;
};

export function VendorCreditsTable({ rows }: { rows: VendorCreditRowData[] }) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border p-12 text-center text-sm text-muted-foreground">
        No vendor credits match these filters.
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/30 hover:bg-muted/30">
            <TableHead>VC #</TableHead>
            <TableHead>Vendor</TableHead>
            <TableHead>Date</TableHead>
            <TableHead className="text-right">Amount</TableHead>
            <TableHead className="text-right">Applied</TableHead>
            <TableHead className="text-right">Available</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Origin</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            const available = row.amount.minus(row.appliedAmount);
            return (
              <TableRow
                key={row.id}
                className="relative cursor-pointer hover:bg-muted/50"
              >
                <TableCell className="font-mono text-xs">
                  <Link
                    href={`/vendor-credits/${row.id}`}
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
                <TableCell className="text-muted-foreground">
                  {formatDate(row.creditDate)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatCurrency(row.amount)}
                </TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">
                  {formatCurrency(row.appliedAmount)}
                </TableCell>
                <TableCell className="text-right tabular-nums font-medium">
                  {/* Available = amount − applied. Only meaningful on
                      CONFIRMED rows; DRAFT/CANCELLED collapse visually
                      to 0. */}
                  {row.status === 'CONFIRMED'
                    ? formatCurrency(available)
                    : '—'}
                </TableCell>
                <TableCell>
                  <StatusBadge status={row.status} />
                </TableCell>
                <TableCell>
                  {row.isOverpayment ? (
                    <Badge variant="outline" className="text-muted-foreground">
                      Overpayment
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="text-muted-foreground">
                      Manual
                    </Badge>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
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

function formatDate(d: Date): string {
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}
