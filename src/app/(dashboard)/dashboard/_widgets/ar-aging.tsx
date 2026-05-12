import { db } from '@/lib/db';
import { arAgingWidget } from '@/server/services/reports/dashboard';
import { formatCount, formatCurrency } from '@/lib/format';
import { WidgetCard } from './widget-card';
import { AgingStrip } from './aging-strip';

export async function ArAgingWidget() {
  const data = await arAgingWidget(db);
  return (
    <WidgetCard
      title="AR Aging"
      subtitle={`${formatCount(data.customerCount)} ${data.customerCount === 1 ? 'customer' : 'customers'} with balances`}
    >
      <div className="text-3xl font-semibold tabular-nums">
        {formatCurrency(data.total)}
      </div>
      <AgingStrip buckets={data} />
    </WidgetCard>
  );
}
