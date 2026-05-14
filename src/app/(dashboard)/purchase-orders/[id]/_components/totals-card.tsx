import { Prisma } from '@/generated/tenant';
import type { PurchaseOrderLine } from '@/generated/tenant';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { formatCurrency } from '@/lib/format';

// POs are simpler than SOs — no discount lines, no shipping/handling
// at this level. Total = Σ(qtyOrdered × unitCost). Receiving variance
// (over/under) is reflected per-line in the lines table, not here.

export function PurchaseOrderTotalsCard({
  lines,
  currency,
}: {
  lines: PurchaseOrderLine[];
  currency: string;
}) {
  const subtotal = lines.reduce(
    (acc, l) => acc.plus(l.qtyOrdered.times(l.unitCost)),
    new Prisma.Decimal(0),
  );
  const receivedSubtotal = lines.reduce(
    (acc, l) => acc.plus(l.qtyReceived.times(l.unitCost)),
    new Prisma.Decimal(0),
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Totals</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="space-y-2 text-sm">
          <Row label="Lines" value={String(lines.length)} tone="muted" />
          <Row label="Currency" value={currency} tone="muted" />
          <div className="my-2 border-t" />
          <Row
            label="Ordered total"
            value={formatCurrency(subtotal)}
            tone="emphasis"
          />
          {receivedSubtotal.greaterThan(0) ? (
            <Row
              label="Received so far"
              value={formatCurrency(receivedSubtotal)}
              tone="muted"
            />
          ) : null}
        </dl>
      </CardContent>
    </Card>
  );
}

function Row({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: string;
  tone?: 'default' | 'muted' | 'emphasis';
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt
        className={
          tone === 'muted'
            ? 'text-muted-foreground'
            : tone === 'emphasis'
              ? 'font-medium'
              : ''
        }
      >
        {label}
      </dt>
      <dd
        className={
          tone === 'emphasis'
            ? 'text-base font-semibold tabular-nums'
            : 'tabular-nums'
        }
      >
        {value}
      </dd>
    </div>
  );
}
