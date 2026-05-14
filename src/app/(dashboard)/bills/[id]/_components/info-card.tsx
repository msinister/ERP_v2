import Link from 'next/link';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

export type LinkedReceipt = { id: string; number: string };
export type LinkedPurchaseOrder = { id: string; number: string };

export function BillInfoCard({
  bill,
  linkedReceipts,
  linkedPurchaseOrders,
}: {
  bill: {
    vendorReference: string | null;
    currency: string;
    notes: string | null;
    cancelReason: string | null;
  };
  linkedReceipts: LinkedReceipt[];
  linkedPurchaseOrders: LinkedPurchaseOrder[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Bill info</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm md:grid-cols-2">
          <Row
            label="Vendor reference"
            value={bill.vendorReference ?? '—'}
            mono={!!bill.vendorReference}
          />
          <Row label="Currency" value={bill.currency} />
        </dl>

        {linkedPurchaseOrders.length > 0 || linkedReceipts.length > 0 ? (
          <div className="mt-4 grid grid-cols-1 gap-3 border-t pt-3 md:grid-cols-2">
            {linkedPurchaseOrders.length > 0 ? (
              <div>
                <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Linked POs
                </div>
                <ul className="space-y-1 text-sm">
                  {linkedPurchaseOrders.map((po) => (
                    <li key={po.id}>
                      <Link
                        href={`/purchase-orders/${po.id}`}
                        className="font-mono text-foreground underline-offset-2 hover:underline"
                      >
                        {po.number}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {linkedReceipts.length > 0 ? (
              <div>
                <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Linked receipts
                </div>
                <ul className="space-y-1 text-sm">
                  {linkedReceipts.map((r) => (
                    <li key={r.id}>
                      <Link
                        href={`/receipts/${r.id}`}
                        className="font-mono text-foreground underline-offset-2 hover:underline"
                      >
                        {r.number}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}

        {bill.notes ? (
          <NoteBlock label="Internal notes" body={bill.notes} />
        ) : null}
        {bill.cancelReason ? (
          <NoteBlock label="Cancel reason" body={bill.cancelReason} muted />
        ) : null}
      </CardContent>
    </Card>
  );
}

function NoteBlock({
  label,
  body,
  muted,
}: {
  label: string;
  body: string;
  muted?: boolean;
}) {
  return (
    <div className="mt-4 border-t pt-3">
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

function Row({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="space-y-0.5">
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className={mono ? 'font-mono text-sm' : 'text-sm'}>{value}</dd>
    </div>
  );
}
