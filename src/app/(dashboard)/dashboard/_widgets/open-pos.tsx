import { db } from '@/lib/db';
import { openPosWidget } from '@/server/services/reports/dashboard';
import { formatCount, formatStatusLabel } from '@/lib/format';
import { WidgetCard } from './widget-card';

export async function OpenPosWidget() {
  const data = await openPosWidget(db);
  const statuses = Object.entries(data.byStatus);
  return (
    <WidgetCard
      title="Open Purchase Orders"
      subtitle="DRAFT, CONFIRMED, PARTIALLY_RECEIVED"
    >
      <div className="text-3xl font-semibold tabular-nums">
        {formatCount(data.totalCount)}
      </div>
      {statuses.length > 0 ? (
        <ul className="mt-3 space-y-1 text-xs">
          {statuses.map(([status, count]) => (
            <li
              key={status}
              className="flex items-center justify-between gap-2"
            >
              <span className="text-muted-foreground">
                {formatStatusLabel(status)}
              </span>
              <span className="tabular-nums">{formatCount(count)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-xs text-muted-foreground">No open POs.</p>
      )}
    </WidgetCard>
  );
}
