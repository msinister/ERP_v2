import Link from 'next/link';
import { ChevronLeft, Printer } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/shared/status-badge';
import { PaymentActions, type OpenInvoiceOption } from './actions';

export type PaymentHeaderProps = {
  payment: {
    id: string;
    number: string;
    status: string;
    method: string;
    receivedAt: Date;
    reversedAt: Date | null;
    customer: { id: string; code: string; name: string };
    unapplied: string;
  };
  openInvoices: OpenInvoiceOption[];
};

export function PaymentHeader({ payment, openInvoices }: PaymentHeaderProps) {
  return (
    <div className="space-y-3">
      <Link
        href="/payments"
        className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-3.5" />
        Payments
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="font-mono text-2xl font-semibold tracking-tight">
              {payment.number}
            </h1>
            <StatusBadge entityType="Payment" status={payment.status} />
          </div>
          <div className="text-sm text-muted-foreground">
            <Link
              href={`/customers/${payment.customer.id}`}
              className="font-medium text-foreground underline-offset-2 hover:underline"
            >
              {payment.customer.name}
            </Link>
            <span className="px-2 text-muted-foreground/60">·</span>
            <span className="font-mono text-xs">{payment.customer.code}</span>
          </div>
          <DateLine
            receivedAt={payment.receivedAt}
            reversedAt={payment.reversedAt}
          />
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            render={
              <Link
                href={`/print/payments/${payment.id}`}
                target="_blank"
                rel="noopener noreferrer"
              />
            }
          >
            <Printer />
            Print
          </Button>
          <PaymentActions
            paymentId={payment.id}
            paymentNumber={payment.number}
            status={payment.status}
            method={payment.method}
            unapplied={payment.unapplied}
            openInvoices={openInvoices}
          />
        </div>
      </div>
    </div>
  );
}

function DateLine({
  receivedAt,
  reversedAt,
}: {
  receivedAt: Date;
  reversedAt: Date | null;
}) {
  const parts: Array<{ label: string; date: Date }> = [
    { label: 'Received', date: receivedAt },
  ];
  if (reversedAt) parts.push({ label: 'Reversed', date: reversedAt });
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
