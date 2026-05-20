import Link from 'next/link';
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
import { categoryLabel } from './categories';

export type AdjustmentRowData = {
  id: string;
  number: string;
  adjustmentDate: Date;
  warehouseCode: string;
  warehouseName: string;
  lineCount: number;
  category: string;
  totalValue: string; // Decimal-as-string
  status: string;
  createdByName: string | null;
};

export function AdjustmentsTable({ rows }: { rows: AdjustmentRowData[] }) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border p-12 text-center text-sm text-muted-foreground">
        No inventory adjustments match these filters.
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/30 hover:bg-muted/30">
            <TableHead>Adj #</TableHead>
            <TableHead>Date</TableHead>
            <TableHead>Warehouse</TableHead>
            <TableHead className="text-right">Lines</TableHead>
            <TableHead>Category</TableHead>
            <TableHead className="text-right">Total value</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Created by</TableHead>
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
                  href={`/inventory-adjustments/${row.id}`}
                  className="absolute inset-0 rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  <span className="sr-only">View {row.number}</span>
                </Link>
                {row.number}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {formatDate(row.adjustmentDate)}
              </TableCell>
              <TableCell>
                <span className="font-mono text-xs text-muted-foreground">
                  {row.warehouseCode}
                </span>{' '}
                {row.warehouseName}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {row.lineCount}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {categoryLabel(row.category)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatCurrency(row.totalValue)}
              </TableCell>
              <TableCell>
                <StatusBadge entityType="InventoryAdjustment" status={row.status} />
              </TableCell>
              <TableCell className="text-muted-foreground">
                {row.createdByName ?? '—'}
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
