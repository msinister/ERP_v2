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
import { StatusBadge } from '@/components/shared/status-badge';
import { TagPills } from '@/components/shared/tag-pills';
import { TableCustomizer } from '@/components/shared/table-customizer';
import {
  useTablePreferences,
  type CustomizableColumn,
  type TableViewPrefValue,
} from '@/components/shared/use-table-preferences';

// Qty values arrive as JS numbers (Decimal.toNumber()).
export type WorkOrderRowData = {
  id: string;
  number: string;
  productName: string;
  variantSku: string;
  warehouseCode: string;
  qtyToBuild: number;
  qtyCompleted: number;
  status: string;
  createdAt: Date;
  tags: Array<{ id: string; name: string }>;
};

const PREF_KEY = 'table.workOrders';

type Column = CustomizableColumn & {
  headClass?: string;
  cellClass?: string;
  render: (row: WorkOrderRowData) => ReactNode;
};

const WORK_ORDER_COLUMNS: Column[] = [
  {
    id: 'number',
    label: 'Number',
    defaultVisible: true,
    locked: true,
    cellClass: 'font-mono text-xs',
    render: (row) => (
      <>
        <Link
          href={`/work-orders/${row.id}`}
          className="absolute inset-0 rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <span className="sr-only">View {row.number}</span>
        </Link>
        {row.number}
      </>
    ),
  },
  {
    id: 'product',
    label: 'Product',
    defaultVisible: true,
    render: (row) => (
      <>
        <div className="font-medium">{row.productName}</div>
        <div className="font-mono text-xs text-muted-foreground">
          {row.variantSku}
        </div>
      </>
    ),
  },
  {
    id: 'warehouse',
    label: 'Warehouse',
    defaultVisible: true,
    cellClass: 'font-mono text-xs text-muted-foreground',
    render: (row) => row.warehouseCode,
  },
  {
    id: 'qty',
    label: 'Qty',
    defaultVisible: true,
    headClass: 'text-right',
    cellClass: 'text-right tabular-nums',
    render: (row) => `${formatQty(row.qtyCompleted)} / ${formatQty(row.qtyToBuild)}`,
  },
  {
    id: 'status',
    label: 'Status',
    defaultVisible: true,
    render: (row) => <StatusBadge entityType="WorkOrder" status={row.status} />,
  },
  {
    id: 'tags',
    label: 'Tags',
    defaultVisible: true,
    cellClass: 'relative z-10',
    render: (row) => <TagPills tags={row.tags} />,
  },
  {
    id: 'created',
    label: 'Created',
    defaultVisible: true,
    cellClass: 'text-xs text-muted-foreground whitespace-nowrap',
    render: (row) => row.createdAt.toLocaleDateString(),
  },
];

export function WorkOrdersTable({
  rows,
  initialPrefs,
}: {
  rows: WorkOrderRowData[];
  initialPrefs: TableViewPrefValue;
}) {
  const colById = new Map(WORK_ORDER_COLUMNS.map((c) => [c.id, c]));
  const customizerColumns: CustomizableColumn[] = WORK_ORDER_COLUMNS.map(
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
      <div className="overflow-hidden rounded-lg border border-border">
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
    </div>
  );
}

function formatQty(qty: number): string {
  const s = qty.toString();
  if (!s.includes('.')) return s;
  return s.replace(/\.?0+$/, '');
}
