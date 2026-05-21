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
  status,
  invoiceAmounts,
  availableCredit,
}: {
  lines: SalesOrderLine[];
  orderDiscountAmount: Prisma.Decimal | null;
  orderDiscountPercent: Prisma.Decimal | null;
  shippingAmount: Prisma.Decimal | null;
  handlingAmount: Prisma.Decimal | null;
  total: Prisma.Decimal;
  status: string;
  /** Only set on CLOSED orders with a live invoice. Drives the
   * Paid / Credited / Balance rows below the grand total. Null
   * pre-CLOSED (no invoice yet) and on orders whose invoice has
   * been voided + unlinked. */
  invoiceAmounts: {
    amountPaid: Prisma.Decimal;
    amountCredited: Prisma.Decimal;
    balance: Prisma.Decimal;
  } | null;
  /** Customer-level unapplied payments + available credit memos — an
   * at-a-glance "money to apply" indicator. Null when not loaded. */
  availableCredit: Prisma.Decimal | null;
}) {
  // CLOSED orders bill on qtyShipped (matches the invoice). Pre-CLOSED
  // shows the order commitment basis (qtyOrdered). Same switch as
  // lines-table — keeping the breakdown in sync with the row totals.
  const isClosed = status === 'CLOSED';
  const subtotal = lines.reduce((acc, l) => {
    const qty = isClosed ? l.qtyShipped : l.qtyOrdered;
    let lineTotal = qty.times(l.unitPrice);
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
          {invoiceAmounts ? (
            <>
              <div className="my-2 border-t" />
              {invoiceAmounts.amountPaid.greaterThan(0) ? (
                <Row
                  label="Paid"
                  value={`−${formatCurrency(invoiceAmounts.amountPaid)}`}
                  tone="muted"
                />
              ) : (
                <Row label="Paid" value="—" tone="muted" />
              )}
              {invoiceAmounts.amountCredited.greaterThan(0) ? (
                <Row
                  label="Credited"
                  value={`−${formatCurrency(invoiceAmounts.amountCredited)}`}
                  tone="muted"
                />
              ) : null}
              <Row
                label="Balance due"
                value={formatCurrency(invoiceAmounts.balance)}
                tone={
                  invoiceAmounts.balance.lessThanOrEqualTo(0)
                    ? 'muted'
                    : 'emphasis'
                }
              />
            </>
          ) : null}
          {availableCredit != null && availableCredit.greaterThan(0) ? (
            <div className="flex items-center justify-between gap-3 text-emerald-600 dark:text-emerald-400">
              <dt>Available credit</dt>
              <dd className="tabular-nums font-medium">
                {formatCurrency(availableCredit)}
              </dd>
            </div>
          ) : null}
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
