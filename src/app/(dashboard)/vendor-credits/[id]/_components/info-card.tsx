import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

export function VendorCreditInfoCard({
  vc,
}: {
  vc: {
    reason: string | null;
    notes: string | null;
    cancelReason: string | null;
    sourceTag: string | null;
  };
}) {
  // Surface the auto-overpayment origin as informational — the source
  // BillPayment id is encoded in the sourceTag, but the GUI doesn't
  // expose a clickable link (would need a billPayment-by-id lookup
  // route; deferred). Showing the tag verbatim is enough for audit.
  const overpaymentBillPaymentId = vc.sourceTag?.startsWith('OVERPAYMENT:')
    ? vc.sourceTag.slice('OVERPAYMENT:'.length)
    : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Credit info</CardTitle>
      </CardHeader>
      <CardContent>
        {overpaymentBillPaymentId ? (
          <div className="mb-3 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs">
            <div className="mb-1 font-medium text-foreground">
              Auto-created from overpayment
            </div>
            <p className="text-muted-foreground">
              Source BillPayment id:{' '}
              <span className="font-mono">{overpaymentBillPaymentId}</span>
              {'. '}
              Reversing the original payment will cancel this credit
              automatically (only while unapplied).
            </p>
          </div>
        ) : null}

        {vc.reason ? <Block label="Reason" body={vc.reason} /> : null}
        {vc.notes ? <Block label="Internal notes" body={vc.notes} /> : null}
        {vc.cancelReason ? (
          <Block label="Cancel reason" body={vc.cancelReason} muted />
        ) : null}

        {!vc.reason && !vc.notes && !vc.cancelReason && !overpaymentBillPaymentId ? (
          <p className="text-sm text-muted-foreground">
            No additional info on this credit.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Block({
  label,
  body,
  muted,
}: {
  label: string;
  body: string;
  muted?: boolean;
}) {
  return (
    <div className="mb-3 last:mb-0">
      <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <p
        className={
          muted
            ? 'whitespace-pre-line text-sm text-muted-foreground'
            : 'whitespace-pre-line text-sm'
        }
      >
        {body}
      </p>
    </div>
  );
}
