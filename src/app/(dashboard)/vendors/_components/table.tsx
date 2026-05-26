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
import { TableCustomizer } from '@/components/shared/table-customizer';
import {
  useTablePreferences,
  type CustomizableColumn,
  type TableViewPrefValue,
} from '@/components/shared/use-table-preferences';
import { formatCurrency } from '@/lib/format';

// Money values arrive as JS numbers (Decimal.toNumber()).
export type VendorRowData = {
  id: string;
  code: string;
  name: string;
  type: string;
  primaryContactName: string | null;
  primaryContactEmail: string | null;
  primaryContactPhone: string | null;
  apBalance: number;
  active: boolean;
};

const PREF_KEY = 'table.vendors';

type Column = CustomizableColumn & {
  headClass?: string;
  cellClass?: string;
  render: (row: VendorRowData) => ReactNode;
};

const VENDOR_COLUMNS: Column[] = [
  {
    id: 'code',
    label: 'Code',
    defaultVisible: true,
    locked: true,
    cellClass: 'font-mono text-xs text-muted-foreground',
    render: (row) => (
      <>
        <Link
          href={`/vendors/${row.id}`}
          className="absolute inset-0 rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <span className="sr-only">View {row.name}</span>
        </Link>
        {row.code}
      </>
    ),
  },
  {
    id: 'name',
    label: 'Name',
    defaultVisible: true,
    cellClass: 'font-medium',
    render: (row) => row.name,
  },
  {
    id: 'type',
    label: 'Type',
    defaultVisible: true,
    cellClass: 'text-muted-foreground',
    render: (row) => formatVendorType(row.type),
  },
  {
    id: 'contact',
    label: 'Contact',
    defaultVisible: true,
    cellClass: 'text-muted-foreground',
    render: (row) => (
      <ContactCell
        name={row.primaryContactName}
        email={row.primaryContactEmail}
        phone={row.primaryContactPhone}
      />
    ),
  },
  {
    id: 'apBalance',
    label: 'AP balance',
    defaultVisible: true,
    headClass: 'text-right',
    cellClass: 'text-right tabular-nums',
    render: (row) => formatCurrency(row.apBalance),
  },
  {
    id: 'status',
    label: 'Status',
    defaultVisible: true,
    render: (row) =>
      row.active ? (
        <Badge variant="secondary">Active</Badge>
      ) : (
        <Badge variant="outline" className="text-muted-foreground">
          Inactive
        </Badge>
      ),
  },
];

export function VendorsTable({
  rows,
  initialPrefs,
}: {
  rows: VendorRowData[];
  initialPrefs: TableViewPrefValue;
}) {
  const colById = new Map(VENDOR_COLUMNS.map((c) => [c.id, c]));
  const customizerColumns: CustomizableColumn[] = VENDOR_COLUMNS.map((c) => ({
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
          No vendors match these filters.
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

function ContactCell({
  name,
  email,
  phone,
}: {
  name: string | null;
  email: string | null;
  phone: string | null;
}) {
  if (!name && !email && !phone) return <span>—</span>;
  return (
    <div className="flex flex-col text-xs leading-tight">
      {name ? <span className="text-foreground">{name}</span> : null}
      {email ? <span className="truncate">{email}</span> : null}
      {phone ? <span>{phone}</span> : null}
    </div>
  );
}

function formatVendorType(value: string): string {
  if (value === 'STOCK') return 'Stock';
  if (value === 'DROP_SHIP') return 'Drop-ship';
  if (value === 'SERVICE') return 'Service';
  return value;
}
