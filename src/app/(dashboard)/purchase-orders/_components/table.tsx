'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
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
import { TagPills } from '@/components/shared/tag-pills';
import { TableCustomizer } from '@/components/shared/table-customizer';
import {
  useTablePreferences,
  type CustomizableColumn,
  type TableViewPrefValue,
} from '@/components/shared/use-table-preferences';
import { formatCurrency } from '@/lib/format';
import { BalanceSortHeader } from './balance-sort-header';

// Money values arrive as JS numbers (Decimal.toNumber()) so nothing
// non-serializable crosses the server→client boundary.
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
  total: number;
  // Rolled-up shipment status (null when the PO has no shipments).
  shipmentRollup: string | null;
  paid: number;
  hasPayments: boolean;
  // Remaining balance (line total − recorded payments).
  balance: number;
  tags: Array<{ id: string; name: string }>;
};

const PREF_KEY = 'table.purchaseOrders';

type Column = CustomizableColumn & {
  headClass?: string;
  cellClass?: string;
  headRender?: () => ReactNode;
  render: (row: PurchaseOrderRowData) => ReactNode;
};

// Single source of truth for the PO table's columns: default order, labels,
// default visibility, locking, and cell rendering. Same shape as
// PRODUCT_COLUMNS / SALES_ORDER_COLUMNS.
const PURCHASE_ORDER_COLUMNS: Column[] = [
  {
    id: 'number',
    label: 'PO #',
    defaultVisible: true,
    locked: true,
    cellClass: 'font-mono text-xs',
    render: (row) => (
      <>
        {/* Stretched-link overlay — whole row clickable. Lives in the
            always-visible PO # cell so the row is always navigable. */}
        <Link
          href={`/purchase-orders/${row.id}`}
          className="absolute inset-0 rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <span className="sr-only">View {row.number}</span>
        </Link>
        {row.number}
      </>
    ),
  },
  {
    id: 'vendor',
    label: 'Vendor',
    defaultVisible: true,
    render: (row) => (
      <div className="flex flex-col text-sm leading-tight">
        <span className="font-medium">{row.vendorName}</span>
        <span className="font-mono text-[10px] text-muted-foreground">
          {row.vendorCode}
        </span>
      </div>
    ),
  },
  {
    id: 'orderDate',
    label: 'Order date',
    defaultVisible: true,
    cellClass: 'text-muted-foreground tabular-nums whitespace-nowrap',
    render: (row) =>
      row.orderDate.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        timeZone: 'UTC',
      }),
  },
  {
    id: 'expected',
    label: 'Expected',
    defaultVisible: true,
    cellClass: 'text-muted-foreground tabular-nums whitespace-nowrap',
    render: (row) =>
      row.expectedReceiveDate
        ? row.expectedReceiveDate.toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
            timeZone: 'UTC',
          })
        : '—',
  },
  {
    id: 'status',
    label: 'Status',
    defaultVisible: true,
    render: (row) => (
      <StatusBadge entityType="PurchaseOrder" status={row.status} />
    ),
  },
  {
    id: 'tags',
    label: 'Tags',
    defaultVisible: true,
    cellClass: 'relative z-10',
    render: (row) => <TagPills tags={row.tags} />,
  },
  {
    id: 'shipment',
    label: 'Shipment',
    defaultVisible: true,
    render: (row) =>
      row.shipmentRollup ? (
        <StatusBadge entityType="PoShipment" status={row.shipmentRollup} />
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  },
  {
    id: 'lines',
    label: 'Lines',
    defaultVisible: false,
    headClass: 'text-right',
    cellClass: 'text-right tabular-nums text-muted-foreground',
    render: (row) => row.lineCount,
  },
  {
    id: 'total',
    label: 'Total',
    defaultVisible: true,
    headClass: 'text-right',
    cellClass: 'text-right tabular-nums',
    render: (row) => formatCurrency(row.total),
  },
  {
    id: 'balance',
    label: 'Balance',
    defaultVisible: true,
    headClass: 'text-right',
    // Fully paid (balance <= 0) reads green; otherwise normal.
    headRender: () => <BalanceSortHeader />,
    render: (row) => (
      <span className={row.balance <= 0 ? 'text-emerald-600 dark:text-emerald-500' : ''}>
        {formatCurrency(row.balance)}
      </span>
    ),
    cellClass: 'text-right tabular-nums',
  },
  {
    id: 'paid',
    label: 'Paid',
    defaultVisible: false,
    headClass: 'text-right',
    cellClass: 'text-right tabular-nums',
    render: (row) =>
      row.hasPayments ? (
        <div className="flex items-center justify-end gap-1.5">
          <Badge variant="secondary" className="text-[10px]">
            Prepaid
          </Badge>
          <span>{formatCurrency(row.paid)}</span>
        </div>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  },
];

export function PurchaseOrdersTable({
  rows,
  initialPrefs,
}: {
  rows: PurchaseOrderRowData[];
  initialPrefs: TableViewPrefValue;
}) {
  const colById = new Map(PURCHASE_ORDER_COLUMNS.map((c) => [c.id, c]));
  const customizerColumns: CustomizableColumn[] = PURCHASE_ORDER_COLUMNS.map(
    (c) => ({
      id: c.id,
      label: c.label,
      defaultVisible: c.defaultVisible,
      locked: c.locked,
    }),
  );

  const { isVisible, toggleColumn, orderedColumnIds, moveColumn } =
    useTablePreferences({
      prefKey: PREF_KEY,
      columns: customizerColumns,
      initial: initialPrefs,
    });

  const orderedColumns = orderedColumnIds
    .map((id) => colById.get(id))
    .filter((c): c is Column => c != null);
  const visibleColumns = orderedColumns.filter((c) => isVisible(c.id));

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <TableCustomizer
          columns={orderedColumns}
          isVisible={isVisible}
          onToggleColumn={toggleColumn}
          onReorder={moveColumn}
        />
      </div>

      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-12 text-center text-sm text-muted-foreground">
          No purchase orders match these filters.
        </div>
      ) : (
        <div className="rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/30 hover:bg-muted/30">
                {visibleColumns.map((c) => (
                  <TableHead key={c.id} className={c.headClass}>
                    {c.headRender ? c.headRender() : c.label}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow
                  key={row.id}
                  className="relative cursor-pointer hover:bg-muted/50"
                >
                  {visibleColumns.map((c) => (
                    <TableCell key={c.id} className={c.cellClass}>
                      {c.render(row)}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
