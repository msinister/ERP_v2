import { Prisma } from '@/generated/tenant';
import type { SalesOrderLine } from '@/generated/tenant';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { formatCurrency } from '@/lib/format';

// Re-derives subtotal + order-discount-applied so the breakdown
// matches what computeSalesOrderTotal does internally — we want
// every row of the totals card to be visible to the operator.
export function SalesOrderTotalsCard({
  lines,
  orderDiscountAmount,
  orderDiscountPercent,
  shippingAmount,
  handlingAmount,
  total,
}: {
  lines: SalesOrderLine[];
  orderDiscountAmount: Prisma.Decimal | null;
  orderDiscountPercent: Prisma.Decimal | null;
  shippingAmount: Prisma.Decimal | null;
  handlingAmount: Prisma.Decimal | null;
  total: Prisma.Decimal;
}) {
  const subtotal = lines.reduce((acc, l) => {
    let lineTotal = l.qtyOrdered.times(l.unitPrice);
    if (l.discountAmount != null) {
      lineTotal = lineTotal.minus(l.discountAmount);
    } else if (l.discountPercent != null) {
      lineTotal = lineTotal.minus(
        lineTotal.times(l.discountPercent).dividedBy(100),
      );
    }
    if (lineTotal.lessThan(0)) lineTotal = new Prisma.Decimal(0);
    return acc.plus(lineTotal);
  }, new Prisma.Decimal(0));

  const orderDiscount =
    orderDiscountAmount ??
    (orderDiscountPercent != null
      ? subtotal.times(orderDiscountPercent).dividedBy(100)
      : new Prisma.Decimal(0));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Totals</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="space-y-2 text-sm">
          <Row label="Subtotal" value={formatCurrency(subtotal)} />
          {orderDiscount.greaterThan(0) ? (
            <Row
              label={orderDiscountLabel(orderDiscountPercent)}
              value={`−${formatCurrency(orderDiscount)}`}
              tone="muted"
            />
          ) : null}
          <Row
            label="Shipping"
            value={
              shippingAmount != null
                ? formatCurrency(shippingAmount)
                : '—'
            }
            tone="muted"
          />
          <Row
            label="Handling"
            value={
              handlingAmount != null
                ? formatCurrency(handlingAmount)
                : '—'
            }
            tone="muted"
          />
          <div className="my-2 border-t" />
          <Row
            label="Grand total"
            value={formatCurrency(total)}
            tone="emphasis"
          />
        </dl>
      </CardContent>
    </Card>
  );
}

function orderDiscountLabel(pct: Prisma.Decimal | null): string {
  if (pct == null) return 'Order discount';
  const n = Number(pct.toString());
  return `Order discount (${n}%)`;
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
