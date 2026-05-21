import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  SalesRepInlineEdit,
  type RepOption,
} from './sales-rep-inline-edit';

// When `repEdit` is provided (Draft/Confirmed/Dispatched), the Sales rep
// field becomes an inline searchable picker; otherwise it's static text
// (Closed/Cancelled — changing the rep then would affect commission).
export type SalesRepEdit = {
  salesOrderId: string;
  reps: RepOption[];
  overrideRepId: string | null;
  customerDefaultName: string | null;
  // Distinct names of reps commission was already accrued under for this
  // order (via its invoice). Non-empty → render the "won't recalculate"
  // warning. Empty for orders with no accrued commission.
  accruedRepNames: string[];
};

export function SalesOrderInfoCard({
  so,
  warehouse,
  salesRep,
  repEdit,
}: {
  so: {
    customerPo: string | null;
    promisedShipDate: Date | null;
    shippingAddress: string | null;
    customerNotes: string | null;
    internalNotes: string | null;
    cancelReason: string | null;
    currency: string;
    source: string;
  };
  warehouse: { id: string; code: string; name: string } | null;
  salesRep: { id: string; name: string } | null;
  repEdit?: SalesRepEdit | null;
}) {
  const repName = salesRep?.name ?? '—';
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Order info</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm md:grid-cols-2">
          <div className="space-y-0.5">
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">
              Sales rep
            </dt>
            <dd className="text-sm">
              {repEdit ? (
                <SalesRepInlineEdit
                  salesOrderId={repEdit.salesOrderId}
                  reps={repEdit.reps}
                  effectiveRepName={repName}
                  overrideRepId={repEdit.overrideRepId}
                  customerDefaultName={repEdit.customerDefaultName}
                />
              ) : (
                repName
              )}
              {repEdit && repEdit.accruedRepNames.length > 0 ? (
                <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                  Commission was accrued under{' '}
                  {repEdit.accruedRepNames.join(', ')}. Changing the rep will
                  not automatically recalculate past commissions.
                </p>
              ) : null}
            </dd>
          </div>
          <Row
            label="Warehouse"
            value={warehouse ? `${warehouse.name} (${warehouse.code})` : '—'}
          />
          <Row label="Customer PO" value={so.customerPo ?? '—'} mono={!!so.customerPo} />
          <Row
            label="Promised ship date"
            value={so.promisedShipDate ? formatDate(so.promisedShipDate) : '—'}
          />
          <Row label="Currency" value={so.currency} />
          <Row label="Source" value={formatSource(so.source)} />
        </dl>

        {so.shippingAddress ? (
          <div className="mt-4 border-t pt-3">
            <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Ship to
            </div>
            <p className="whitespace-pre-line text-sm">{so.shippingAddress}</p>
          </div>
        ) : null}

        {so.customerNotes ? (
          <NoteBlock label="Customer notes" body={so.customerNotes} />
        ) : null}
        {so.internalNotes ? (
          <NoteBlock label="Internal notes" body={so.internalNotes} />
        ) : null}
        {so.cancelReason ? (
          <NoteBlock label="Cancel reason" body={so.cancelReason} tone="muted" />
        ) : null}
      </CardContent>
    </Card>
  );
}

function NoteBlock({
  label,
  body,
  tone = 'default',
}: {
  label: string;
  body: string;
  tone?: 'default' | 'muted';
}) {
  return (
    <div className="mt-4 border-t pt-3">
      <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <p
        className={
          tone === 'muted'
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

function formatSource(s: string): string {
  // STAFF / PORTAL / SHOPIFY → "Staff" / "Portal" / "Shopify"
  return s.charAt(0) + s.slice(1).toLowerCase();
}

function formatDate(d: Date): string {
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}
