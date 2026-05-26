'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { StatusBadge } from '@/components/shared/status-badge';
import { TableCustomizer } from '@/components/shared/table-customizer';
import {
  useTablePreferences,
  type CustomizableColumn,
  type TableViewPrefValue,
} from '@/components/shared/use-table-preferences';
import { formatCurrency } from '@/lib/format';

// Money fields are plain numbers, not Prisma.Decimal: client component
// boundary. The page derives them (with Decimal precision) and converts
// to number here for display + comparison.
export type PaymentRowData = {
  id: string;
  number: string;
  receivedAt: Date;
  customerId: string;
  customerCode: string;
  customerName: string;
  method: string;
  reference: string | null;
  amount: number;
  // Sum of non-reversed application amounts (correct for both cash and
  // applied-credit payments; the Payment.appliedAmount denorm stays 0
  // for APPLIED_CREDIT so we derive from applications instead).
  applied: number;
  unapplied: number;
  status: string;
  // Source SO for row navigation: the first non-reversed application's
  // invoice → salesOrder. Null when the payment is unapplied or none of
  // its invoices still link to a live SO → row falls back to the detail.
  sourceSalesOrderId: string | null;
};

const PREF_KEY = 'table.payments';

const METHOD_LABELS: Record<string, string> = {
  CREDIT_CARD: 'Credit card',
  ACH: 'ACH',
  WIRE: 'Wire',
  CHECK: 'Check',
  CASH: 'Cash',
  MONEY_ORDER: 'Money order',
  APPLIED_CREDIT: 'Applied credit',
};

type Column = CustomizableColumn & {
  headClass?: string;
  cellClass?: string;
  render: (row: PaymentRowData) => ReactNode;
};

const PAYMENT_COLUMNS: Column[] = [
  {
    id: 'number',
    label: 'Payment #',
    defaultVisible: true,
    locked: true,
    cellClass: 'font-mono text-xs',
    // The row's onClick navigates to the source SO; the # Link stops
    // propagation so a click on it still opens the payment detail.
    render: (row) => (
      <Link
        href={`/payments/${row.id}`}
        onClick={(e) => e.stopPropagation()}
        className="text-primary hover:underline"
      >
        {row.number}
      </Link>
    ),
  },
  {
    id: 'date',
    label: 'Date',
    defaultVisible: true,
    cellClass: 'text-muted-foreground whitespace-nowrap',
    render: (row) => formatDate(row.receivedAt),
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
    id: 'method',
    label: 'Method',
    defaultVisible: true,
    cellClass: 'text-muted-foreground',
    render: (row) => METHOD_LABELS[row.method] ?? row.method,
  },
  {
    id: 'reference',
    label: 'Reference',
    defaultVisible: true,
    cellClass: 'font-mono text-xs text-muted-foreground',
    render: (row) => row.reference ?? '—',
  },
  {
    id: 'amount',
    label: 'Amount',
    defaultVisible: true,
    headClass: 'text-right',
    cellClass: 'text-right tabular-nums font-medium',
    render: (row) => formatCurrency(row.amount),
  },
  {
    id: 'applied',
    label: 'Applied',
    defaultVisible: true,
    headClass: 'text-right',
    cellClass: 'text-right tabular-nums text-muted-foreground',
    render: (row) => formatCurrency(row.applied),
  },
  {
    id: 'unapplied',
    label: 'Unapplied',
    defaultVisible: true,
    headClass: 'text-right',
    // Amber for RECORDED payments with money still sitting unapplied —
    // signals "credit on account" that AR may want to allocate.
    render: (row) => {
      const showAmber = row.status === 'RECORDED' && row.unapplied > 0;
      return (
        <span
          className={
            showAmber
              ? 'font-semibold text-amber-600'
              : 'text-muted-foreground'
          }
        >
          {row.status === 'RECORDED' ? formatCurrency(row.unapplied) : '—'}
        </span>
      );
    },
    cellClass: 'text-right tabular-nums',
  },
  {
    id: 'status',
    label: 'Status',
    defaultVisible: true,
    render: (row) => <StatusBadge entityType="Payment" status={row.status} />,
  },
];

export function PaymentsTable({
  rows,
  initialPrefs,
}: {
  rows: PaymentRowData[];
  initialPrefs: TableViewPrefValue;
}) {
  const router = useRouter();
  const colById = new Map(PAYMENT_COLUMNS.map((c) => [c.id, c]));
  const customizerColumns: CustomizableColumn[] = PAYMENT_COLUMNS.map((c) => ({
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
          No payments match these filters.
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
              {rows.map((row) => {
                // Row navigates to the source SO (per spec); fall back to
                // the payment detail when there's no live SO link.
                const rowHref = row.sourceSalesOrderId
                  ? `/sales-orders/${row.sourceSalesOrderId}`
                  : `/payments/${row.id}`;
                return (
                  <TableRow
                    key={row.id}
                    className="cursor-pointer hover:bg-muted/50"
                    onClick={() => router.push(rowHref)}
                  >
                    {visibleColumns.map((c) => (
                      <TableCell key={c.id} className={c.cellClass}>
                        {c.render(row)}
                      </TableCell>
                    ))}
                  </TableRow>
                );
              })}
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
