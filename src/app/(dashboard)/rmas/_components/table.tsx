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
import { formatCurrency } from '@/lib/format';
import { formatRmaStatusLabel } from '../_lib/status';

export type RmaRowData = {
  id: string;
  number: string;
  customerId: string;
  customerCode: string;
  customerName: string;
  invoiceId: string;
  invoiceNumber: string;
  createdAt: Date;
  itemCount: number;
  totalQty: Prisma.Decimal;
  total: Prisma.Decimal;
  status: string;
  returnless: boolean;
  hasCreditMemo: boolean;
};

export function RmasTable({ rows }: { rows: RmaRowData[] }) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border p-12 text-center text-sm text-muted-foreground">
        No RMAs match these filters.
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/30 hover:bg-muted/30">
            <TableHead>RMA #</TableHead>
            <TableHead>Date</TableHead>
            <TableHead>Customer</TableHead>
            <TableHead>Invoice</TableHead>
            <TableHead className="text-right">Items</TableHead>
            <TableHead className="text-right">Total</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow
              key={row.id}
              className="relative cursor-pointer hover:bg-muted/50"
            >
              <TableCell className="font-mono text-xs">
                <Link
                  href={`/rmas/${row.id}`}
                  className="absolute inset-0 rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  <span className="sr-only">View {row.number}</span>
                </Link>
                {row.number}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {formatDate(row.createdAt)}
              </TableCell>
              <TableCell>
                <div className="flex flex-col text-sm leading-tight">
                  <span className="font-medium">{row.customerName}</span>
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {row.customerCode}
                  </span>
                </div>
              </TableCell>
              <TableCell className="font-mono text-xs text-muted-foreground">
                {row.invoiceNumber}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {row.itemCount}
                <span className="ml-1 text-[10px] text-muted-foreground">
                  ({formatQty(row.totalQty)} units)
                </span>
              </TableCell>
              <TableCell className="text-right tabular-nums font-medium">
                {formatCurrency(row.total)}
              </TableCell>
              <TableCell>
                <div className="flex flex-wrap items-center gap-1.5">
                  <StatusBadge status={row.status} />
                  {row.returnless ? (
                    <Badge
                      variant="outline"
                      className="text-[10px] text-muted-foreground"
                    >
                      Returnless
                    </Badge>
                  ) : null}
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const label = formatRmaStatusLabel(status);
  if (status === 'CREDITED') return <Badge>{label}</Badge>;
  if (status === 'REJECTED') {
    return (
      <Badge variant="outline" className="text-muted-foreground">
        {label}
      </Badge>
    );
  }
  if (status === 'INSPECTED') return <Badge variant="secondary">{label}</Badge>;
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

function formatQty(qty: Prisma.Decimal): string {
  const s = qty.toString();
  if (!s.includes('.')) return s;
  return s.replace(/\.?0+$/, '');
}
