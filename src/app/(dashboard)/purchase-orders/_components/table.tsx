import Link from 'next/link';
import type { Prisma } from '@/generated/tenant';
import { Badge } from '@/components/ui/badge';
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
import { BalanceSortHeader } from './balance-sort-header';

export type PurchaseOrderRowData = {
  id: string;
  number: string;
  vendorId: string;
  vendorCode: string;
  vendorName: string;
  orderDate: Date;
  expectedReceiveDate: Date | null;
  status: string;
  lineCount: number;
  total: Prisma.Decimal;
  // Rolled-up shipment status (null when the PO has no shipments).
  shipmentRollup: string | null;
  // Sum of RECORDED deposits, as a decimal string. hasPayments drives the
  // "Prepaid" badge even when the total nets to a small value.
  paid: string;
  hasPayments: boolean;
  // Remaining balance (line total − recorded payments), decimal string.
  balance: string;
};

export function PurchaseOrdersTable({
  rows,
}: {
  rows: PurchaseOrderRowData[];
}) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border p-12 text-center text-sm text-muted-foreground">
        No purchase orders match these filters.
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/30 hover:bg-muted/30">
            <TableHead>PO #</TableHead>
            <TableHead>Vendor</TableHead>
            <TableHead>Order date</TableHead>
            <TableHead>Expected</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Shipment</TableHead>
            <TableHead className="text-right">Lines</TableHead>
            <TableHead className="text-right">Total</TableHead>
            <TableHead className="text-right">
              <BalanceSortHeader />
            </TableHead>
            <TableHead className="text-right">Paid</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow
              key={row.id}
              className="relative cursor-pointer hover:bg-muted/50"
            >
              <TableCell className="font-mono text-xs">
                {/* Stretched-link overlay — target is the PO detail
                    page added in 6F. */}
                <Link
                  href={`/purchase-orders/${row.id}`}
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
                {row.orderDate.toLocaleDateString('en-US', {
                  month: 'short',
                  day: 'numeric',
                  year: 'numeric',
                  timeZone: 'UTC',
                })}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {row.expectedReceiveDate
                  ? row.expectedReceiveDate.toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric',
                      timeZone: 'UTC',
                    })
                  : '—'}
              </TableCell>
              <TableCell>
                <StatusBadge entityType="PurchaseOrder" status={row.status} />
              </TableCell>
              <TableCell>
                {row.shipmentRollup ? (
                  <StatusBadge
                    entityType="PoShipment"
                    status={row.shipmentRollup}
                  />
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </TableCell>
              <TableCell className="text-right tabular-nums text-muted-foreground">
                {row.lineCount}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatCurrency(row.total)}
              </TableCell>
              <TableCell
                className={
                  'text-right tabular-nums ' +
                  // Fully paid (balance <= 0) reads green; otherwise normal.
                  (Number(row.balance) <= 0
                    ? 'text-emerald-600 dark:text-emerald-500'
                    : '')
                }
              >
                {formatCurrency(row.balance)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {row.hasPayments ? (
                  <div className="flex items-center justify-end gap-1.5">
                    <Badge variant="secondary" className="text-[10px]">
                      Prepaid
                    </Badge>
                    <span>{formatCurrency(row.paid)}</span>
                  </div>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

