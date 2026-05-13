import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { formatStatusLabel } from '@/lib/format';
import { LifecycleActions } from './lifecycle-actions';

export type SalesOrderHeaderProps = {
  so: {
    id: string;
    number: string;
    status: string;
    customer: { id: string; code: string; name: string };
    orderDate: Date;
    confirmedAt: Date | null;
    dispatchedAt: Date | null;
    closedAt: Date | null;
    cancelledAt: Date | null;
    invoice: { id: string; number: string } | null;
    // Pre-fill values for the Close dialog. Strings (decimal-as-string)
    // so we don't introduce a JS Number for money in the GUI plumbing.
    shippingAmount: string | null;
    handlingAmount: string | null;
  };
};

export function SalesOrderHeader({ so }: SalesOrderHeaderProps) {
  return (
    <div className="space-y-3">
      <Link
        href="/sales-orders"
        className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-3.5" />
        Sales Orders
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="font-mono text-2xl font-semibold tracking-tight">
              {so.number}
            </h1>
            <StatusBadge status={so.status} />
          </div>
          <div className="text-sm text-muted-foreground">
            <Link
              href={`/customers/${so.customer.id}`}
              className="font-medium text-foreground underline-offset-2 hover:underline"
            >
              {so.customer.name}
            </Link>
            <span className="px-2 text-muted-foreground/60">·</span>
            <span className="font-mono text-xs">{so.customer.code}</span>
          </div>
          <DateLine
            orderDate={so.orderDate}
            confirmedAt={so.confirmedAt}
            dispatchedAt={so.dispatchedAt}
            closedAt={so.closedAt}
            cancelledAt={so.cancelledAt}
          />
          {so.invoice ? (
            <div className="text-xs text-muted-foreground">
              Invoice{' '}
              <span className="font-mono text-foreground">
                {so.invoice.number}
              </span>
            </div>
          ) : null}
        </div>
        <LifecycleActions
          salesOrderId={so.id}
          salesOrderNumber={so.number}
          status={so.status}
          shippingAmount={so.shippingAmount}
          handlingAmount={so.handlingAmount}
        />
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const label = formatStatusLabel(status);
  switch (status) {
    case 'CLOSED':
      return <Badge variant="secondary">{label}</Badge>;
    case 'CANCELLED':
      return (
        <Badge variant="outline" className="text-muted-foreground">
          {label}
        </Badge>
      );
    case 'DRAFT':
      return <Badge variant="outline">{label}</Badge>;
    default:
      return <Badge>{label}</Badge>;
  }
}

function DateLine({
  orderDate,
  confirmedAt,
  dispatchedAt,
  closedAt,
  cancelledAt,
}: {
  orderDate: Date;
  confirmedAt: Date | null;
  dispatchedAt: Date | null;
  closedAt: Date | null;
  cancelledAt: Date | null;
}) {
  const parts: Array<{ label: string; date: Date }> = [
    { label: 'Ordered', date: orderDate },
  ];
  if (confirmedAt) parts.push({ label: 'Confirmed', date: confirmedAt });
  if (dispatchedAt) parts.push({ label: 'Dispatched', date: dispatchedAt });
  if (closedAt) parts.push({ label: 'Closed', date: closedAt });
  if (cancelledAt) parts.push({ label: 'Cancelled', date: cancelledAt });
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
      {parts.map((p, idx) => (
        <span key={idx}>
          <span className="font-medium text-foreground/80">{p.label}</span>{' '}
          {formatDate(p.date)}
        </span>
      ))}
    </div>
  );
}

function formatDate(d: Date): string {
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}
