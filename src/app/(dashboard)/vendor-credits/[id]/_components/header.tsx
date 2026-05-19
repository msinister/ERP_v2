import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { StatusBadge } from '@/components/shared/status-badge';
import { LifecycleActions } from './lifecycle-actions';

export type VendorCreditHeaderProps = {
  vc: {
    id: string;
    number: string;
    status: string;
    vendor: { id: string; code: string; name: string };
    creditDate: Date;
    confirmedAt: Date | null;
    cancelledAt: Date | null;
    isOverpayment: boolean;
    hasApplications: boolean;
  };
};

export function VendorCreditHeader({ vc }: VendorCreditHeaderProps) {
  return (
    <div className="space-y-3">
      <Link
        href="/vendor-credits"
        className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-3.5" />
        Vendor Credits
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="font-mono text-2xl font-semibold tracking-tight">
              {vc.number}
            </h1>
            <StatusBadge entityType="VendorCredit" status={vc.status} />
            {vc.isOverpayment ? (
              <Badge variant="outline" className="text-muted-foreground">
                Overpayment
              </Badge>
            ) : null}
          </div>
          <div className="text-sm text-muted-foreground">
            <Link
              href={`/vendors/${vc.vendor.id}`}
              className="font-medium text-foreground underline-offset-2 hover:underline"
            >
              {vc.vendor.name}
            </Link>
            <span className="px-2 text-muted-foreground/60">·</span>
            <span className="font-mono text-xs">{vc.vendor.code}</span>
          </div>
          <DateLine
            creditDate={vc.creditDate}
            confirmedAt={vc.confirmedAt}
            cancelledAt={vc.cancelledAt}
          />
        </div>
        <LifecycleActions
          vendorCreditId={vc.id}
          vendorCreditNumber={vc.number}
          status={vc.status}
          hasApplications={vc.hasApplications}
        />
      </div>
    </div>
  );
}

function DateLine({
  creditDate,
  confirmedAt,
  cancelledAt,
}: {
  creditDate: Date;
  confirmedAt: Date | null;
  cancelledAt: Date | null;
}) {
  const parts: Array<{ label: string; date: Date }> = [
    { label: 'Credit date', date: creditDate },
  ];
  if (confirmedAt) parts.push({ label: 'Confirmed', date: confirmedAt });
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
