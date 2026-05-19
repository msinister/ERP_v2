import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { formatStatusLabel } from '@/lib/format';
import { LifecycleActions } from './lifecycle-actions';

export type CreditMemoHeaderProps = {
  cm: {
    id: string;
    number: string;
    status: string;
    customer: { id: string; code: string; name: string };
    invoice: { id: string; number: string } | null;
    rma: { id: string; number: string } | null;
    category: { id: string; code: string; label: string };
    createdAt: Date;
    issuedAt: Date | null;
    voidedAt: Date | null;
    hasApplications: boolean;
  };
};

export function CreditMemoHeader({ cm }: CreditMemoHeaderProps) {
  return (
    <div className="space-y-3">
      <Link
        href="/credit-memos"
        className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-3.5" />
        Credit Memos
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="font-mono text-2xl font-semibold tracking-tight">
              {cm.number}
            </h1>
            <StatusBadge status={cm.status} />
            {cm.rma ? (
              <Badge variant="outline" className="text-muted-foreground">
                From RMA {cm.rma.number}
              </Badge>
            ) : null}
            <Badge variant="outline" className="text-muted-foreground">
              {cm.category.label}
            </Badge>
          </div>
          <div className="text-sm text-muted-foreground">
            <Link
              href={`/customers/${cm.customer.id}`}
              className="font-medium text-foreground underline-offset-2 hover:underline"
            >
              {cm.customer.name}
            </Link>
            <span className="px-2 text-muted-foreground/60">·</span>
            <span className="font-mono text-xs">{cm.customer.code}</span>
            {cm.invoice ? (
              <>
                <span className="px-2 text-muted-foreground/60">·</span>
                <span>
                  Against{' '}
                  <Link
                    href={`/invoices/${cm.invoice.id}`}
                    className="font-mono text-foreground underline-offset-2 hover:underline"
                  >
                    {cm.invoice.number}
                  </Link>
                </span>
              </>
            ) : null}
          </div>
          <DateLine
            createdAt={cm.createdAt}
            issuedAt={cm.issuedAt}
            voidedAt={cm.voidedAt}
          />
        </div>
        <LifecycleActions
          creditMemoId={cm.id}
          creditMemoNumber={cm.number}
          status={cm.status}
          hasApplications={cm.hasApplications}
          isFromRma={!!cm.rma}
        />
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const label = formatStatusLabel(status);
  if (status === 'CONFIRMED') return <Badge>{label}</Badge>;
  if (status === 'VOIDED') {
    return (
      <Badge variant="outline" className="text-muted-foreground">
        {label}
      </Badge>
    );
  }
  return <Badge variant="outline">{label}</Badge>;
}

function DateLine({
  createdAt,
  issuedAt,
  voidedAt,
}: {
  createdAt: Date;
  issuedAt: Date | null;
  voidedAt: Date | null;
}) {
  const parts: Array<{ label: string; date: Date }> = [
    { label: 'Created', date: createdAt },
  ];
  if (issuedAt) parts.push({ label: 'Issued', date: issuedAt });
  if (voidedAt) parts.push({ label: 'Voided', date: voidedAt });
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
