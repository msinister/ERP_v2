import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

const METHOD_LABELS: Record<string, string> = {
  CREDIT_CARD: 'Credit card',
  ACH: 'ACH',
  WIRE: 'Wire',
  CHECK: 'Check',
  CASH: 'Cash',
  MONEY_ORDER: 'Money order',
  APPLIED_CREDIT: 'Applied credit',
};

export function PaymentInfoCard({
  method,
  reference,
  currency,
  notes,
  reversedReason,
}: {
  method: string;
  reference: string | null;
  currency: string;
  notes: string | null;
  reversedReason: string | null;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Payment info</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
          <Row label="Method" value={METHOD_LABELS[method] ?? method} />
          <Row label="Reference" value={reference ?? '—'} mono={!!reference} />
          <Row label="Currency" value={currency} />
        </dl>
        {notes ? (
          <div className="mt-4 border-t border-border pt-3">
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Notes
            </div>
            <p className="whitespace-pre-line text-sm">{notes}</p>
          </div>
        ) : null}
        {reversedReason ? (
          <div className="mt-4 rounded border border-destructive/30 bg-destructive/5 p-3">
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-destructive">
              Reversal reason
            </div>
            <p className="whitespace-pre-line text-sm text-muted-foreground">
              {reversedReason}
            </p>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Row({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="space-y-0.5">
      <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className={'text-sm ' + (mono ? 'font-mono text-xs' : '')}>{value}</dd>
    </div>
  );
}
