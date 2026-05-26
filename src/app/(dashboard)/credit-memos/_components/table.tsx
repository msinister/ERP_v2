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
import { StatusBadge } from '@/components/shared/status-badge';
import { TagPills } from '@/components/shared/tag-pills';
import { formatCurrency } from '@/lib/format';

export type CreditMemoRowData = {
  id: string;
  number: string;
  customerId: string;
  customerCode: string;
  customerName: string;
  categoryId: string;
  categoryCode: string;
  categoryLabel: string;
  // Issued-at when confirmed; otherwise createdAt — gives operators a
  // single "Date" column that reads as the document's effective date.
  creditDate: Date;
  amount: Prisma.Decimal;
  netCredit: Prisma.Decimal;
  appliedAmount: Prisma.Decimal;
  status: string;
  tags: Array<{ id: string; name: string }>;
};

export function CreditMemosTable({ rows }: { rows: CreditMemoRowData[] }) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border p-12 text-center text-sm text-muted-foreground">
        No credit memos match these filters.
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/30 hover:bg-muted/30">
            <TableHead>CM #</TableHead>
            <TableHead>Date</TableHead>
            <TableHead>Customer</TableHead>
            <TableHead>Category</TableHead>
            <TableHead className="text-right">Total</TableHead>
            <TableHead className="text-right">Applied</TableHead>
            <TableHead className="text-right">Available</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Tags</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            const available = row.netCredit.minus(row.appliedAmount);
            return (
              <TableRow
                key={row.id}
                className="relative cursor-pointer hover:bg-muted/50"
              >
                <TableCell className="font-mono text-xs">
                  <Link
                    href={`/credit-memos/${row.id}`}
                    className="absolute inset-0 rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                  >
                    <span className="sr-only">View {row.number}</span>
                  </Link>
                  {row.number}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {formatDate(row.creditDate)}
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
                  {row.categoryLabel}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatCurrency(row.netCredit)}
                </TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">
                  {formatCurrency(row.appliedAmount)}
                </TableCell>
                <TableCell className="text-right tabular-nums font-medium">
                  {/* Available = netCredit − applied. Only meaningful on
                      CONFIRMED rows; DRAFT/VOIDED collapse visually
                      to —. */}
                  {row.status === 'CONFIRMED'
                    ? formatCurrency(available)
                    : '—'}
                </TableCell>
                <TableCell>
                  <StatusBadge entityType="CreditMemo" status={row.status} />
                </TableCell>
                <TableCell className="relative z-10">
                  <TagPills tags={row.tags} />
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
