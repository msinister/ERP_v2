import { db } from '@/lib/db';
import { todaysSalesWidget } from '@/server/services/reports/dashboard';
import { formatCount, formatCurrency } from '@/lib/format';
import { WidgetCard } from './widget-card';

export async function TodaysSalesWidget() {
  const data = await todaysSalesWidget(db);
  // Day boundary is UTC, matching the GL convention. Render the date
  // as a UTC-formatted string so the label can't drift by tz.
  const dateLabel = data.date.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
  return (
    <WidgetCard title="Today's Sales" subtitle={`${dateLabel} (UTC)`}>
      <div className="text-3xl font-semibold tabular-nums">
        {formatCurrency(data.grossSales)}
      </div>
      <div className="mt-3 text-xs text-muted-foreground">
        {formatCount(data.invoiceCount)}{' '}
        {data.invoiceCount === 1 ? 'invoice' : 'invoices'}
      </div>
    </WidgetCard>
  );
}
