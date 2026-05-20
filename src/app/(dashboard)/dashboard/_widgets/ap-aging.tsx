import Link from 'next/link';
import { db } from '@/lib/db';
import { apAgingWidget } from '@/server/services/reports/dashboard';
import { formatCount, formatCurrency } from '@/lib/format';
import { WidgetCard } from './widget-card';
import { AgingStrip } from './aging-strip';

export async function ApAgingWidget() {
  const data = await apAgingWidget(db);
  return (
    <Link
      href="/reports"
      className="group block focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:rounded-lg"
    >
      <WidgetCard
        title="AP Aging"
        subtitle={`${formatCount(data.vendorCount)} ${data.vendorCount === 1 ? 'vendor' : 'vendors'} with balances`}
        className="transition-colors group-hover:bg-muted/40"
      >
        <div className="text-3xl font-semibold tabular-nums">
          {formatCurrency(data.total)}
        </div>
        <AgingStrip buckets={data} />
      </WidgetCard>
    </Link>
  );
}
