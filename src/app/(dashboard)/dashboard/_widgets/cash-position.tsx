import { db } from '@/lib/db';
import { cashPositionWidget } from '@/server/services/reports/dashboard';
import { formatCurrency } from '@/lib/format';
import { WidgetCard } from './widget-card';

export async function CashPositionWidget() {
  const data = await cashPositionWidget(db);
  return (
    <WidgetCard title="Cash Position" subtitle={`GL acct ${data.cashAccountCode}`}>
      <div className="text-3xl font-semibold tabular-nums">
        {formatCurrency(data.glBalance)}
      </div>
    </WidgetCard>
  );
}
