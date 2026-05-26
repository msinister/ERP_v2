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
export type VendorCreditRowData = {
  id: string;
  number: string;
  vendorId: string;
  vendorCode: string;
  vendorName: string;
  creditDate: Date;
  amount: number;
  appliedAmount: number;
  status: string;
  // Set when the VC was auto-created from an overpayment. We surface
  // this as an "Overpayment" badge so it's clear AP didn't enter it
  // manually.
  isOverpayment: boolean;
  tags: Array<{ id: string; name: string }>;
};

const PREF_KEY = 'table.vendorCredits';

type Column = CustomizableColumn & {
  headClass?: string;
  cellClass?: string;
  render: (row: VendorCreditRowData) => ReactNode;
};

const VENDOR_CREDIT_COLUMNS: Column[] = [
  {
    id: 'number',
    label: 'VC #',
    defaultVisible: true,
    locked: true,
    cellClass: 'font-mono text-xs',
    render: (row) => (
      <>
        <Link
          href={`/vendor-credits/${row.id}`}
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
    id: 'date',
    label: 'Date',
    defaultVisible: true,
    cellClass: 'text-muted-foreground whitespace-nowrap',
    render: (row) => formatDate(row.creditDate),
  },
  {
    id: 'amount',
    label: 'Amount',
    defaultVisible: true,
    headClass: 'text-right',
    cellClass: 'text-right tabular-nums',
    render: (row) => formatCurrency(row.amount),
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
    // Only meaningful on CONFIRMED; DRAFT/CANCELLED collapse to —.
    render: (row) =>
      row.status === 'CONFIRMED'
        ? formatCurrency(row.amount - row.appliedAmount)
        : '—',
  },
  {
    id: 'status',
    label: 'Status',
    defaultVisible: true,
    render: (row) => (
      <StatusBadge entityType="VendorCredit" status={row.status} />
    ),
  },
  {
    id: 'origin',
    label: 'Origin',
    defaultVisible: false,
    render: (row) =>
      row.isOverpayment ? (
        <Badge variant="outline" className="text-muted-foreground">
          Overpayment
        </Badge>
      ) : (
        <Badge variant="outline" className="text-muted-foreground">
          Manual
        </Badge>
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

export function VendorCreditsTable({
  rows,
  initialPrefs,
}: {
  rows: VendorCreditRowData[];
  initialPrefs: TableViewPrefValue;
}) {
  const colById = new Map(VENDOR_CREDIT_COLUMNS.map((c) => [c.id, c]));
  const customizerColumns: CustomizableColumn[] = VENDOR_CREDIT_COLUMNS.map(
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
          No vendor credits match these filters.
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
