import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { formatStatusLabel } from '@/lib/format';
import { LifecycleActions } from './lifecycle-actions';

export type BillHeaderProps = {
  bill: {
    id: string;
    number: string;
    status: string;
    paymentStatus: string;
    source: string;
    vendor: { id: string; code: string; name: string };
    billDate: Date;
    dueDate: Date | null;
    confirmedAt: Date | null;
    cancelledAt: Date | null;
    hasAppliedMoney: boolean;
  };
};

export function BillHeader({ bill }: BillHeaderProps) {
  return (
    <div className="space-y-3">
      <Link
        href="/bills"
        className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-3.5" />
        Bills
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="font-mono text-2xl font-semibold tracking-tight">
              {bill.number}
            </h1>
            <StatusBadge status={bill.status} />
            <PaymentStatusBadge
              status={bill.paymentStatus}
              billStatus={bill.status}
            />
            <Badge variant="outline" className="text-muted-foreground">
              {bill.source === 'PRODUCT' ? 'Product' : 'Expense'}
            </Badge>
          </div>
          <div className="text-sm text-muted-foreground">
            <Link
              href={`/vendors/${bill.vendor.id}`}
              className="font-medium text-foreground underline-offset-2 hover:underline"
            >
              {bill.vendor.name}
            </Link>
            <span className="px-2 text-muted-foreground/60">·</span>
            <span className="font-mono text-xs">{bill.vendor.code}</span>
          </div>
          <DateLine
            billDate={bill.billDate}
            dueDate={bill.dueDate}
            confirmedAt={bill.confirmedAt}
            cancelledAt={bill.cancelledAt}
          />
        </div>
        <LifecycleActions
          billId={bill.id}
          billNumber={bill.number}
          status={bill.status}
          hasAppliedMoney={bill.hasAppliedMoney}
        />
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const label = formatStatusLabel(status);
  if (status === 'CONFIRMED') return <Badge>{label}</Badge>;
  if (status === 'CANCELLED') {
    return (
      <Badge variant="outline" className="text-muted-foreground">
        {label}
      </Badge>
    );
  }
  return <Badge variant="outline">{label}</Badge>;
}

function PaymentStatusBadge({
  status,
  billStatus,
}: {
  status: string;
  billStatus: string;
}) {
  // Payment status only meaningful on CONFIRMED bills — DRAFT and
  // CANCELLED bills have no AP balance.
  if (billStatus !== 'CONFIRMED') return null;
  const label = formatStatusLabel(status);
  if (status === 'PAID') return <Badge variant="secondary">{label}</Badge>;
  if (status === 'PARTIAL') return <Badge variant="outline">{label}</Badge>;
  return (
    <Badge variant="outline" className="text-muted-foreground">
      {label}
    </Badge>
  );
}

function DateLine({
  billDate,
  dueDate,
  confirmedAt,
  cancelledAt,
}: {
  billDate: Date;
  dueDate: Date | null;
  confirmedAt: Date | null;
  cancelledAt: Date | null;
}) {
  const parts: Array<{ label: string; date: Date }> = [
    { label: 'Bill date', date: billDate },
  ];
  if (confirmedAt) parts.push({ label: 'Confirmed', date: confirmedAt });
  if (dueDate) parts.push({ label: 'Due', date: dueDate });
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
    timeZone: 'UTC',
  });
}
