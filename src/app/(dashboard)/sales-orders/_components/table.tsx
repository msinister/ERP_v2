'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { StatusBadge } from '@/components/shared/status-badge';
import { formatCurrency } from '@/lib/format';
import { TableCustomizer } from '@/components/shared/table-customizer';
import {
  useTablePreferences,
  type CustomizableColumn,
  type TableViewPrefValue,
} from '@/components/shared/use-table-preferences';

// Money values arrive as decimal strings (Decimal.toString()) so nothing
// non-serializable crosses the server→client boundary. orderDate stays a
// Date (serializes fine). totalCogs is present only when the caller had
// products.view_cost; null otherwise (column also absent from customizer).
export type SalesOrderRowData = {
  id: string;
  number: string;
  customerId: string;
  customerName: string;
  orderDate: Date;
  status: string;
  salesRepName: string;
  total: string;
  amountPaid: string;
  balanceDue: string;
  credits: string;
  shippingFee: string;
  discounts: string;
  netTotal: string;
  totalCogs: string | null;
  tags: Array<{ id: string; name: string }>;
};

const PREF_KEY = 'table.salesOrders';
const MAX_VISIBLE_TAGS = 3;

type SalesOrderColumn = CustomizableColumn & {
  requiresCost?: boolean;
  headClass?: string;
  cellClass?: string;
  render: (row: SalesOrderRowData) => ReactNode;
};

// Single source of truth for the SO table columns: default order, labels,
// default visibility, locking, permission gating, and cell rendering.
// Mirrors PRODUCT_COLUMNS in products/_components/table.tsx.
const SALES_ORDER_COLUMNS: SalesOrderColumn[] = [
  {
    id: 'number',
    label: 'SO #',
    defaultVisible: true,
    locked: true,
    cellClass: 'font-mono text-xs text-muted-foreground',
    render: (row) => (
      <>
        {/* Stretched-link overlay — whole row clickable. Lives in the
            always-visible SO # cell so the row is always navigable. */}
        <Link
          href={`/sales-orders/${row.id}`}
          className="absolute inset-0 rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <span className="sr-only">View {row.number}</span>
        </Link>
        {row.number}
      </>
    ),
  },
  {
    id: 'customer',
    label: 'Customer',
    defaultVisible: true,
    cellClass: 'font-medium',
    render: (row) => row.customerName,
  },
  {
    id: 'status',
    label: 'Status',
    defaultVisible: true,
    render: (row) => <StatusBadge entityType="SalesOrder" status={row.status} />,
  },
  {
    id: 'orderDate',
    label: 'Date',
    defaultVisible: true,
    cellClass: 'text-muted-foreground tabular-nums whitespace-nowrap',
    render: (row) => formatOrderDate(row.orderDate),
  },
  {
    id: 'salesRep',
    label: 'Sales rep',
    defaultVisible: true,
    cellClass: 'text-muted-foreground',
    render: (row) => row.salesRepName,
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
    id: 'balanceDue',
    label: 'Balance due',
    defaultVisible: true,
    headClass: 'text-right',
    cellClass: 'text-right tabular-nums',
    render: (row) => formatCurrency(row.balanceDue),
  },
  {
    id: 'tags',
    label: 'Tags',
    defaultVisible: true,
    cellClass: 'relative z-10',
    render: (row) => <TagPills tags={row.tags} />,
  },
  {
    id: 'amountPaid',
    label: 'Amount paid',
    defaultVisible: false,
    headClass: 'text-right',
    cellClass: 'text-right tabular-nums',
    render: (row) => formatCurrency(row.amountPaid),
  },
  {
    id: 'totalCogs',
    label: 'Total COGS',
    defaultVisible: false,
    requiresCost: true,
    headClass: 'text-right',
    cellClass: 'text-right tabular-nums',
    render: (row) =>
      row.totalCogs != null ? formatCurrency(row.totalCogs) : '—',
  },
  {
    id: 'shippingFee',
    label: 'Shipping fee',
    defaultVisible: false,
    headClass: 'text-right',
    cellClass: 'text-right tabular-nums',
    render: (row) => formatCurrency(row.shippingFee),
  },
  {
    id: 'credits',
    label: 'Credits',
    defaultVisible: false,
    headClass: 'text-right',
    cellClass: 'text-right tabular-nums',
    render: (row) => formatCurrency(row.credits),
  },
  {
    id: 'discounts',
    label: 'Discounts',
    defaultVisible: false,
    headClass: 'text-right',
    cellClass: 'text-right tabular-nums',
    render: (row) => formatCurrency(row.discounts),
  },
  {
    id: 'netTotal',
    label: 'Net total',
    defaultVisible: false,
    headClass: 'text-right',
    cellClass: 'text-right tabular-nums',
    render: (row) => formatCurrency(row.netTotal),
  },
];

export function SalesOrdersTable({
  rows,
  canViewCost,
  initialPrefs,
}: {
  rows: SalesOrderRowData[];
  // Drives whether Total COGS reaches the customizer + data set at all.
  canViewCost: boolean;
  initialPrefs: TableViewPrefValue;
}) {
  // Cost-gated columns are absent for users without the permission — not
  // just hidden. They never reach the customizer or the render set.
  const availableColumns = SALES_ORDER_COLUMNS.filter(
    (c) => !c.requiresCost || canViewCost,
  );
  const colById = new Map(availableColumns.map((c) => [c.id, c]));
  const customizerColumns: CustomizableColumn[] = availableColumns.map((c) => ({
    id: c.id,
    label: c.label,
    defaultVisible: c.defaultVisible,
    locked: c.locked,
  }));

  const { isVisible, toggleColumn, orderedColumnIds, moveColumn } =
    useTablePreferences({
      prefKey: PREF_KEY,
      columns: customizerColumns,
      initial: initialPrefs,
    });

  const orderedColumns = orderedColumnIds
    .map((id) => colById.get(id))
    .filter((c): c is SalesOrderColumn => c != null);
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
          No sales orders match these filters.
        </div>
      ) : (
        <div className="rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/30 hover:bg-muted/30">
                {visibleColumns.map((c) => (
                  <TableHead key={c.id} className={c.headClass}>
                    {c.label}
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

function TagPills({ tags }: { tags: Array<{ id: string; name: string }> }) {
  if (tags.length === 0) {
    return <span className="text-muted-foreground">—</span>;
  }
  const visible = tags.slice(0, MAX_VISIBLE_TAGS);
  const overflow = tags.length - visible.length;
  return (
    <div className="flex flex-wrap items-center gap-1">
      {visible.map((t) => (
        <Badge key={t.id} variant="secondary" className="text-[10px] font-normal">
          {t.name}
        </Badge>
      ))}
      {overflow > 0 ? (
        <span
          className="text-[10px] text-muted-foreground"
          title={tags.map((t) => t.name).join(', ')}
        >
          +{overflow} more
        </span>
      ) : null}
    </div>
  );
}

function formatOrderDate(d: Date): string {
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}
