import type { Prisma } from '@/generated/tenant';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { formatCurrency } from '@/lib/format';

export function RmaTotalsCard({
  grossTotal,
  restockingFeeAmount,
  netCredit,
}: {
  grossTotal: Prisma.Decimal;
  restockingFeeAmount: Prisma.Decimal;
  netCredit: Prisma.Decimal;
}) {
  const hasFee = restockingFeeAmount.greaterThan(0);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Anticipated credit</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="space-y-2 text-sm">
          <Row label="Gross return value" value={formatCurrency(grossTotal)} />
          {hasFee ? (
            <Row
              label="Restocking fee"
              value={`−${formatCurrency(restockingFeeAmount)}`}
              tone="muted"
            />
          ) : null}
          <div className="my-2 border-t" />
          <Row
            label="Net credit"
            value={formatCurrency(netCredit)}
            tone="emphasis"
          />
        </dl>
        <p className="mt-3 text-[10px] text-muted-foreground">
          Estimate based on current line qtys and the effective restocking
          fee policy. The actual credit posts when you reach Inspected →
          Credited.
        </p>
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
