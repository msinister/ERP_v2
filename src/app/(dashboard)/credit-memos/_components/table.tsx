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
import { formatCurrency } from '@/lib/format';

// Money values arrive as JS numbers (Decimal.toNumber()).
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
  amount: number;
  netCredit: number;
  appliedAmount: number;
  status: string;
  tags: Array<{ id: string; name: string }>;
};

const PREF_KEY = 'table.creditMemos';

type Column = CustomizableColumn & {
  headClass?: string;
  cellClass?: string;
  render: (row: CreditMemoRowData) => ReactNode;
};

const CREDIT_MEMO_COLUMNS: Column[] = [
  {
    id: 'number',
    label: 'CM #',
    defaultVisible: true,
    locked: true,
    cellClass: 'font-mono text-xs',
    render: (row) => (
      <>
        <Link
          href={`/credit-memos/${row.id}`}
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
    render: (row) => formatDate(row.creditDate),
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
    id: 'category',
    label: 'Category',
    defaultVisible: true,
    cellClass: 'text-muted-foreground',
    render: (row) => row.categoryLabel,
  },
  {
    id: 'total',
    label: 'Total',
    defaultVisible: true,
    headClass: 'text-right',
    cellClass: 'text-right tabular-nums',
    render: (row) => formatCurrency(row.netCredit),
  },
  {
    id: 'applied',
    label: 'Applied',
    defaultVisible: true,
    headClass: 'text-right',
    cellClass: 'text-right tabular-nums text-muted-foreground',
    render: (row) => formatCurrency(row.appliedAmount),
  },
  {
    id: 'available',
    label: 'Available',
    defaultVisible: true,
    headClass: 'text-right',
    cellClass: 'text-right tabular-nums font-medium',
    // Only meaningful on CONFIRMED rows; DRAFT/VOIDED collapse to —.
    render: (row) =>
      row.status === 'CONFIRMED'
        ? formatCurrency(row.netCredit - row.appliedAmount)
        : '—',
  },
  {
    id: 'status',
    label: 'Status',
    defaultVisible: true,
    render: (row) => <StatusBadge entityType="CreditMemo" status={row.status} />,
  },
  {
    id: 'tags',
    label: 'Tags',
    defaultVisible: true,
    cellClass: 'relative z-10',
    render: (row) => <TagPills tags={row.tags} />,
  },
];

export function CreditMemosTable({
  rows,
  initialPrefs,
}: {
  rows: CreditMemoRowData[];
  initialPrefs: TableViewPrefValue;
}) {
  const colById = new Map(CREDIT_MEMO_COLUMNS.map((c) => [c.id, c]));
  const customizerColumns: CustomizableColumn[] = CREDIT_MEMO_COLUMNS.map(
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
          No credit memos match these filters.
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
