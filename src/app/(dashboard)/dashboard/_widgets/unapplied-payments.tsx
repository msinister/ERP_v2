import { db } from '@/lib/db';
import { unappliedPaymentsWidget } from '@/server/services/reports/dashboard';
import { formatCount, formatCurrency } from '@/lib/format';
import { WidgetCard } from './widget-card';

// Count-only card for the pilot — there's no payments-list page yet
// (deferred slice). Surfaces customer cash sitting on account that
// hasn't been matched to an invoice.

export async function UnappliedPaymentsWidget() {
  const data = await unappliedPaymentsWidget(db);
  return (
    <WidgetCard
      title="Unapplied Payments"
      subtitle="Customer cash not yet matched to an invoice"
    >
      <div className="text-3xl font-semibold tabular-nums">
        {formatCurrency(data.totalUnapplied)}
      </div>
      <div className="mt-3 text-xs text-muted-foreground">
        {formatCount(data.count)}{' '}
        {data.count === 1 ? 'payment' : 'payments'} with open balance
      </div>
    </WidgetCard>
  );
}
