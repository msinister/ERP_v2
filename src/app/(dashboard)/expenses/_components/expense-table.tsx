import Link from 'next/link';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatCurrency } from '@/lib/format';

export type ExpenseRowData = {
  billId: string;
  billNumber: string;
  billDate: Date;
  vendorName: string;
  vendorCode: string;
  amount: string;
  categoryCode: string | null;
  categoryName: string | null;
  paymentAccountCode: string | null;
  paymentAccountName: string | null;
};

export function ExpenseTable({ rows }: { rows: ExpenseRowData[] }) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border p-12 text-center text-sm text-muted-foreground">
        No expenses match these filters.
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/30 hover:bg-muted/30">
            <TableHead>Date</TableHead>
            <TableHead>Vendor</TableHead>
            <TableHead className="text-right">Amount</TableHead>
            <TableHead>Category</TableHead>
            <TableHead>Paid from</TableHead>
            <TableHead>Bill #</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow
              key={row.billId}
              className="relative cursor-pointer hover:bg-muted/50"
            >
              <TableCell className="text-muted-foreground">
                {/* Stretched-link overlay → the linked bill detail page. */}
                <Link
                  href={`/bills/${row.billId}`}
                  className="absolute inset-0 rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  <span className="sr-only">View {row.billNumber}</span>
                </Link>
                {formatDate(row.billDate)}
              </TableCell>
              <TableCell>
                <div className="flex flex-col text-sm leading-tight">
                  <span className="font-medium">{row.vendorName}</span>
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {row.vendorCode}
                  </span>
                </div>
              </TableCell>
              <TableCell className="text-right tabular-nums font-medium">
                {formatCurrency(row.amount)}
              </TableCell>
              <TableCell>
                {row.categoryName ? (
                  <div className="flex flex-col text-sm leading-tight">
                    <span>{row.categoryName}</span>
                    <span className="font-mono text-[10px] text-muted-foreground">
                      {row.categoryCode}
                    </span>
                  </div>
                ) : (
                  <span className="text-xs text-muted-foreground">—</span>
                )}
              </TableCell>
              <TableCell>
                {row.paymentAccountName ? (
                  <div className="flex flex-col text-sm leading-tight">
                    <span>{row.paymentAccountName}</span>
                    <span className="font-mono text-[10px] text-muted-foreground">
                      {row.paymentAccountCode}
                    </span>
                  </div>
                ) : (
                  <span className="text-xs text-muted-foreground">—</span>
                )}
              </TableCell>
              <TableCell className="font-mono text-xs">
                {row.billNumber}
              </TableCell>
            </TableRow>
          ))}
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
