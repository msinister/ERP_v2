import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { formatStatusLabel } from '@/lib/format';
import { ReceiptLifecycleActions } from './lifecycle-actions';

export type ReceiptHeaderProps = {
  receipt: {
    id: string;
    number: string;
    status: string;
    vendor: { id: string; code: string; name: string };
    receivedAt: Date | null;
    createdAt: Date;
  };
};

export function ReceiptHeader({ receipt }: ReceiptHeaderProps) {
  return (
    <div className="space-y-3">
      <Link
        href="/purchase-orders"
        className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-3.5" />
        Purchase Orders
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="font-mono text-2xl font-semibold tracking-tight">
              {receipt.number}
            </h1>
            <StatusBadge status={receipt.status} />
          </div>
          <div className="text-sm text-muted-foreground">
            <Link
              href={`/vendors/${receipt.vendor.id}`}
              className="font-medium text-foreground underline-offset-2 hover:underline"
            >
              {receipt.vendor.name}
            </Link>
            <span className="px-2 text-muted-foreground/60">·</span>
            <span className="font-mono text-xs">{receipt.vendor.code}</span>
          </div>
          <DateLine
            createdAt={receipt.createdAt}
            receivedAt={receipt.receivedAt}
            status={receipt.status}
          />
        </div>
        <ReceiptLifecycleActions
          receiptId={receipt.id}
          receiptNumber={receipt.number}
          status={receipt.status}
        />
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const label = formatStatusLabel(status);
  if (status === 'POSTED') return <Badge variant="secondary">{label}</Badge>;
  if (status === 'CANCELLED') {
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
  receivedAt,
  status,
}: {
  createdAt: Date;
  receivedAt: Date | null;
  status: string;
}) {
  const parts: Array<{ label: string; date: Date }> = [
    { label: 'Created', date: createdAt },
  ];
  if (receivedAt) parts.push({ label: 'Posted', date: receivedAt });
  // Receipt has no cancelledAt column today — the audit log row tracks
  // the cancel timestamp until that schema fill-in lands (see receipts
  // service comment around the cancelReceipt GL leg).
  void status;
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
