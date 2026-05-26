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

// Money values arrive as JS numbers (Decimal.toNumber()).
export type BillRowData = {
  id: string;
  number: string;
  vendorId: string;
  vendorCode: string;
  vendorName: string;
  vendorReference: string | null;
  billDate: Date;
  dueDate: Date | null;
  status: string;
  paymentStatus: string;
  source: string;
  total: number;
  balance: number;
  tags: Array<{ id: string; name: string }>;
};

const PREF_KEY = 'table.bills';

type Column = CustomizableColumn & {
  headClass?: string;
  cellClass?: string;
  render: (row: BillRowData) => ReactNode;
};

const BILL_COLUMNS: Column[] = [
  {
    id: 'number',
    label: 'Bill #',
    defaultVisible: true,
    locked: true,
    cellClass: 'font-mono text-xs',
    render: (row) => (
      <>
        <Link
          href={`/bills/${row.id}`}
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
    id: 'vendorRef',
    label: 'Vendor ref',
    defaultVisible: true,
    cellClass: 'font-mono text-xs text-muted-foreground',
    render: (row) => row.vendorReference ?? '—',
  },
  {
    id: 'billDate',
    label: 'Bill date',
    defaultVisible: true,
    cellClass: 'text-muted-foreground whitespace-nowrap',
    render: (row) => formatDate(row.billDate),
  },
  {
    id: 'due',
    label: 'Due',
    defaultVisible: true,
    cellClass: 'text-muted-foreground whitespace-nowrap',
    render: (row) => (row.dueDate ? formatDate(row.dueDate) : '—'),
  },
  {
    id: 'source',
    label: 'Source',
    defaultVisible: false,
    render: (row) => (
      <Badge variant="outline" className="text-muted-foreground">
        {row.source === 'PRODUCT' ? 'Product' : 'Expense'}
      </Badge>
    ),
  },
  {
    id: 'status',
    label: 'Status',
    defaultVisible: true,
    render: (row) => <StatusBadge entityType="Bill" status={row.status} />,
  },
  {
    id: 'payment',
    label: 'Payment',
    defaultVisible: true,
    // Payment status only meaningful on CONFIRMED bills. DRAFT has no AP
    // entry yet; CANCELLED unwinds the AP.
    render: (row) =>
      row.status === 'CONFIRMED' ? (
        <StatusBadge
          entityType="BillPaymentStatus"
          status={row.paymentStatus}
        />
      ) : (
        <span className="text-xs text-muted-foreground">—</span>
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
    cellClass: 'text-right tabular-nums',
    // Balance is undefined until CONFIRMED; CANCELLED is 0.
    render: (row) =>
      row.status === 'DRAFT'
        ? '—'
        : row.status === 'CANCELLED'
          ? formatCurrency(0)
          : formatCurrency(row.balance),
  },
];

export function BillsTable({
  rows,
  initialPrefs,
}: {
  rows: BillRowData[];
  initialPrefs: TableViewPrefValue;
}) {
  const colById = new Map(BILL_COLUMNS.map((c) => [c.id, c]));
  const customizerColumns: CustomizableColumn[] = BILL_COLUMNS.map((c) => ({
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
          No bills match these filters.
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
