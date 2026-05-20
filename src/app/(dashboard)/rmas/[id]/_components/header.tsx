import Link from 'next/link';
import { ChevronLeft, Printer } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/shared/status-badge';

export type RmaHeaderProps = {
  rma: {
    id: string;
    number: string;
    status: string;
    returnless: boolean;
    customer: { id: string; code: string; name: string };
    invoice: { id: string; number: string; invoiceDate: Date };
    creditMemo: { id: string; number: string; status: string } | null;
    createdAt: Date;
    approvedAt: Date | null;
    receivedAt: Date | null;
    inspectedAt: Date | null;
    creditedAt: Date | null;
    rejectedAt: Date | null;
  };
};

export function RmaHeader({ rma }: RmaHeaderProps) {
  return (
    <div className="space-y-3">
      <Link
        href="/rmas"
        className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-3.5" />
        RMAs
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="font-mono text-2xl font-semibold tracking-tight">
              {rma.number}
            </h1>
            <StatusBadge entityType="Rma" status={rma.status} />
            <Badge variant="outline" className="text-muted-foreground">
              {rma.returnless ? 'Returnless' : 'Standard'}
            </Badge>
            {rma.creditMemo ? (
              <Link
                href={`/credit-memos/${rma.creditMemo.id}`}
                className="text-xs underline-offset-2 hover:underline"
              >
                <Badge variant="secondary">{rma.creditMemo.number}</Badge>
              </Link>
            ) : null}
          </div>
          <div className="text-sm text-muted-foreground">
            <Link
              href={`/customers/${rma.customer.id}`}
              className="font-medium text-foreground underline-offset-2 hover:underline"
            >
              {rma.customer.name}
            </Link>
            <span className="px-2 text-muted-foreground/60">·</span>
            <span className="font-mono text-xs">{rma.customer.code}</span>
            <span className="px-2 text-muted-foreground/60">·</span>
            <span>
              Against{' '}
              <Link
                href={`/invoices/${rma.invoice.id}`}
                className="font-mono text-foreground underline-offset-2 hover:underline"
              >
                {rma.invoice.number}
              </Link>
            </span>
          </div>
          <DateLine
            createdAt={rma.createdAt}
            approvedAt={rma.approvedAt}
            receivedAt={rma.receivedAt}
            inspectedAt={rma.inspectedAt}
            creditedAt={rma.creditedAt}
            rejectedAt={rma.rejectedAt}
          />
        </div>
        <Button
          variant="outline"
          size="sm"
          render={
            <Link
              href={`/print/rmas/${rma.id}`}
              target="_blank"
              rel="noopener noreferrer"
            />
          }
        >
          <Printer />
          Print
        </Button>
      </div>
    </div>
  );
}

function DateLine({
  createdAt,
  approvedAt,
  receivedAt,
  inspectedAt,
  creditedAt,
  rejectedAt,
}: {
  createdAt: Date;
  approvedAt: Date | null;
  receivedAt: Date | null;
  inspectedAt: Date | null;
  creditedAt: Date | null;
  rejectedAt: Date | null;
}) {
  const parts: Array<{ label: string; date: Date }> = [
    { label: 'Created', date: createdAt },
  ];
  if (approvedAt) parts.push({ label: 'Approved', date: approvedAt });
  if (receivedAt) parts.push({ label: 'Received', date: receivedAt });
  if (inspectedAt) parts.push({ label: 'Inspected', date: inspectedAt });
  if (creditedAt) parts.push({ label: 'Credited', date: creditedAt });
  if (rejectedAt) parts.push({ label: 'Rejected', date: rejectedAt });
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
