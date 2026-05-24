import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

export function PurchaseOrderInfoCard({
  po,
}: {
  po: {
    expectedReceiveDate: Date | null;
    currency: string;
    notes: string | null;
    closeReason: string | null;
  };
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">PO info</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm md:grid-cols-2">
          <Row
            label="Expected receive"
            value={
              po.expectedReceiveDate ? formatDate(po.expectedReceiveDate) : '—'
            }
          />
          <Row label="Currency" value={po.currency} />
        </dl>

        {po.closeReason ? (
          // Renders only on PURs closed via the manual close-with-reason
          // path. Auto-closed POs (every line fully received) leave
          // closeReason NULL and this section stays hidden.
          <NoteBlock label="Close reason" body={po.closeReason} />
        ) : null}
        {po.notes ? (
          <NoteBlock label="Internal notes" body={po.notes} />
        ) : null}
      </CardContent>
    </Card>
  );
}

function NoteBlock({
  label,
  body,
}: {
  label: string;
  body: string;
}) {
  return (
    <div className="mt-4 border-t pt-3">
      <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <p className="whitespace-pre-line text-sm">{body}</p>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-0.5">
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="text-sm">{value}</dd>
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
