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
import { TagPills } from '@/components/shared/tag-pills';
import { TableCustomizer } from '@/components/shared/table-customizer';
import {
  useTablePreferences,
  type CustomizableColumn,
  type TableViewPrefValue,
} from '@/components/shared/use-table-preferences';
import { formatCurrency } from '@/lib/format';

// Money + qty arrive as JS numbers (Decimal.toNumber()).
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
  totalQty: number;
  total: number;
  status: string;
  returnless: boolean;
  hasCreditMemo: boolean;
  tags: Array<{ id: string; name: string }>;
};

const PREF_KEY = 'table.rmas';

type Column = CustomizableColumn & {
  headClass?: string;
  cellClass?: string;
  render: (row: RmaRowData) => ReactNode;
};

const RMA_COLUMNS: Column[] = [
  {
    id: 'number',
    label: 'RMA #',
    defaultVisible: true,
    locked: true,
    cellClass: 'font-mono text-xs',
    render: (row) => (
      <>
        <Link
          href={`/rmas/${row.id}`}
          className="absolute inset-0 rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <span className="sr-only">View {row.number}</span>
        </Link>
        {row.number}
      </>
    ),
  },
  {
    id: 'date',
    label: 'Date',
    defaultVisible: true,
    cellClass: 'text-muted-foreground whitespace-nowrap',
    render: (row) => formatDate(row.createdAt),
  },
  {
    id: 'customer',
    label: 'Customer',
    defaultVisible: true,
    render: (row) => (
      <div className="flex flex-col text-sm leading-tight">
        <span className="font-medium">{row.customerName}</span>
        <span className="font-mono text-[10px] text-muted-foreground">
          {row.customerCode}
        </span>
      </div>
    ),
  },
  {
    id: 'invoice',
    label: 'Invoice',
    defaultVisible: true,
    cellClass: 'font-mono text-xs text-muted-foreground',
    render: (row) => row.invoiceNumber,
  },
  {
    id: 'items',
    label: 'Items',
    defaultVisible: true,
    headClass: 'text-right',
    cellClass: 'text-right tabular-nums',
    render: (row) => (
      <>
        {row.itemCount}
        <span className="ml-1 text-[10px] text-muted-foreground">
          ({formatQty(row.totalQty)} units)
        </span>
      </>
    ),
  },
  {
    id: 'total',
    label: 'Total',
    defaultVisible: true,
    headClass: 'text-right',
    cellClass: 'text-right tabular-nums font-medium',
    render: (row) => formatCurrency(row.total),
  },
  {
    id: 'status',
    label: 'Status',
    defaultVisible: true,
    render: (row) => (
      <div className="flex flex-wrap items-center gap-1.5">
        <StatusBadge entityType="Rma" status={row.status} />
        {row.returnless ? (
          <Badge
            variant="outline"
            className="text-[10px] text-muted-foreground"
          >
            Returnless
          </Badge>
        ) : null}
      </div>
    ),
  },
  {
    id: 'tags',
    label: 'Tags',
    defaultVisible: true,
    cellClass: 'relative z-10',
    render: (row) => <TagPills tags={row.tags} />,
  },
];

export function RmasTable({
  rows,
  initialPrefs,
}: {
  rows: RmaRowData[];
  initialPrefs: TableViewPrefValue;
}) {
  const colById = new Map(RMA_COLUMNS.map((c) => [c.id, c]));
  const customizerColumns: CustomizableColumn[] = RMA_COLUMNS.map((c) => ({
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
          No RMAs match these filters.
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

function formatDate(d: Date): string {
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function formatQty(qty: number): string {
  const s = qty.toString();
  if (!s.includes('.')) return s;
  return s.replace(/\.?0+$/, '');
}
