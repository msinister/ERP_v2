import type { Prisma } from '@/generated/tenant';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { formatCurrency } from '@/lib/format';

export function BillTotalsCard({
  status,
  subtotal,
  freight,
  tax,
  total,
  amountPaid,
  amountCredited,
}: {
  status: string;
  subtotal: Prisma.Decimal;
  freight: Prisma.Decimal;
  tax: Prisma.Decimal;
  total: Prisma.Decimal;
  amountPaid: Prisma.Decimal;
  amountCredited: Prisma.Decimal;
}) {
  const balance = total.minus(amountPaid).minus(amountCredited);
  const isConfirmed = status === 'CONFIRMED';

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Totals</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="space-y-2 text-sm">
          <Row label="Subtotal" value={formatCurrency(subtotal)} />
          {freight.greaterThan(0) ? (
            <Row label="Freight" value={formatCurrency(freight)} tone="muted" />
          ) : null}
          {tax.greaterThan(0) ? (
            <Row label="Tax" value={formatCurrency(tax)} tone="muted" />
          ) : null}
          <div className="my-2 border-t" />
          <Row
            label="Bill total"
            value={formatCurrency(total)}
            tone="emphasis"
          />
          {/* Paid + credited + balance only meaningful on CONFIRMED.
              CANCELLED collapses to zero anyway (offsetting JE
              reverses the AP entry). */}
          {isConfirmed ? (
            <>
              {amountPaid.greaterThan(0) ? (
                <Row
                  label="Paid"
                  value={`−${formatCurrency(amountPaid)}`}
                  tone="muted"
                />
              ) : null}
              {amountCredited.greaterThan(0) ? (
                <Row
                  label="Credited"
                  value={`−${formatCurrency(amountCredited)}`}
                  tone="muted"
                />
              ) : null}
              <div className="my-2 border-t" />
              <Row
                label="Balance"
                value={formatCurrency(balance)}
                tone="emphasis"
              />
            </>
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
