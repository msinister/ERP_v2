import Link from 'next/link';
import { db } from '@/lib/db';
import { openPosWidget } from '@/server/services/reports/dashboard';
import { formatCount, formatStatusLabel } from '@/lib/format';
import { WidgetCard } from './widget-card';

const CLICKABLE_STATUSES = new Set(['CONFIRMED', 'PARTIALLY_RECEIVED']);

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
        <ul className="mt-3 space-y-0.5 text-xs">
          {statuses.map(([status, count]) => {
            const label = formatStatusLabel(status);
            const isLinked = CLICKABLE_STATUSES.has(status);
            const inner = (
              <>
                <span className="text-muted-foreground">{label}</span>
                <span className="tabular-nums">{formatCount(count)}</span>
              </>
            );
            return (
              <li key={status}>
                {isLinked ? (
                  <Link
                    href={`/purchase-orders?status=${status}`}
                    className="flex items-center justify-between gap-2 rounded-sm px-1 py-1 hover:bg-muted/50 hover:text-foreground"
                  >
                    {inner}
                  </Link>
                ) : (
                  <div className="flex items-center justify-between gap-2 px-1 py-1">
                    {inner}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="mt-3 text-xs text-muted-foreground">No open POs.</p>
      )}
    </WidgetCard>
  );
}
