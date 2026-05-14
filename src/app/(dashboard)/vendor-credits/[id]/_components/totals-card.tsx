import type { Prisma } from '@/generated/tenant';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { formatCurrency } from '@/lib/format';

export function VendorCreditTotalsCard({
  status,
  amount,
  appliedAmount,
  currency,
}: {
  status: string;
  amount: Prisma.Decimal;
  appliedAmount: Prisma.Decimal;
  currency: string;
}) {
  const available = amount.minus(appliedAmount);
  const isConfirmed = status === 'CONFIRMED';

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Totals</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="space-y-2 text-sm">
          <Row label="Currency" value={currency} tone="muted" />
          <div className="my-2 border-t" />
          <Row
            label="Credit amount"
            value={formatCurrency(amount)}
            tone="emphasis"
          />
          {/* Applied + available only meaningful on CONFIRMED.
              DRAFT has no GL effect; CANCELLED unwinds the AP/VCA pair. */}
          {isConfirmed ? (
            <>
              {appliedAmount.greaterThan(0) ? (
                <Row
                  label="Applied"
                  value={`−${formatCurrency(appliedAmount)}`}
                  tone="muted"
                />
              ) : null}
              <div className="my-2 border-t" />
              <Row
                label="Available"
                value={formatCurrency(available)}
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
