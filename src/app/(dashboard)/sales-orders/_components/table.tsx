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
import { formatCurrency } from '@/lib/format';

export type SalesOrderRowData = {
  id: string;
  number: string;
  customerName: string;
  customerId: string;
  orderDate: Date;
  status: string;
  total: Prisma.Decimal;
  salesRepName: string;
};

export function SalesOrdersTable({ rows }: { rows: SalesOrderRowData[] }) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border p-12 text-center text-sm text-muted-foreground">
        No sales orders match these filters.
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/30 hover:bg-muted/30">
            <TableHead>SO #</TableHead>
            <TableHead>Customer</TableHead>
            <TableHead>Order date</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Total</TableHead>
            <TableHead>Sales rep</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow
              key={row.id}
              className="relative cursor-pointer hover:bg-muted/50"
            >
              <TableCell className="font-mono text-xs text-muted-foreground">
                {/* Stretched-link overlay: whole row clickable, cmd/middle
                    click still opens in a new tab. */}
                <Link
                  href={`/sales-orders/${row.id}`}
                  className="absolute inset-0 rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  <span className="sr-only">View {row.number}</span>
                </Link>
                {row.number}
              </TableCell>
              <TableCell className="font-medium">{row.customerName}</TableCell>
              <TableCell className="text-muted-foreground tabular-nums">
                {formatOrderDate(row.orderDate)}
              </TableCell>
              <TableCell>
                <StatusBadge entityType="SalesOrder" status={row.status} />
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatCurrency(row.total)}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {row.salesRepName}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

// "MMM D, YYYY" — short, scannable, fits the column. No times shown;
// staff don't care about the minute they booked an order.
function formatOrderDate(d: Date): string {
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}
