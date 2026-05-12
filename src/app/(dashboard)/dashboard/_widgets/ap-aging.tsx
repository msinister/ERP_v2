import { db } from '@/lib/db';
import { apAgingWidget } from '@/server/services/reports/dashboard';
import { formatCount, formatCurrency } from '@/lib/format';
import { WidgetCard } from './widget-card';
import { AgingStrip } from './aging-strip';

export async function ApAgingWidget() {
  const data = await apAgingWidget(db);
  return (
    <WidgetCard
      title="AP Aging"
      subtitle={`${formatCount(data.vendorCount)} ${data.vendorCount === 1 ? 'vendor' : 'vendors'} with balances`}
    >
      <div className="text-3xl font-semibold tabular-nums">
        {formatCurrency(data.total)}
      </div>
      <AgingStrip buckets={data} />
    </WidgetCard>
  );
}
