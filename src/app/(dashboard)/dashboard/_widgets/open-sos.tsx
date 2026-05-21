import Link from 'next/link';
import { db } from '@/lib/db';
import { openSosWidget } from '@/server/services/reports/dashboard';
import { formatCount, formatStatusLabel } from '@/lib/format';
import { WidgetCard } from './widget-card';

// Each per-status row links to the SO list page with the matching
// status filter applied. The big total is unlinked — the per-status
// rows are the actionable drill-down.
const CLICKABLE_STATUSES = new Set(['CONFIRMED', 'DISPATCHED']);

export async function OpenSosWidget({
  customerSalesRepId,
}: {
  customerSalesRepId?: string | null;
} = {}) {
  const data = await openSosWidget(db, { customerSalesRepId });
  const statuses = Object.entries(data.byStatus);
  return (
    <WidgetCard title="Open Sales Orders" subtitle="DRAFT, CONFIRMED, DISPATCHED">
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
                    href={`/sales-orders?status=${status}`}
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
        <p className="mt-3 text-xs text-muted-foreground">No open orders.</p>
      )}
    </WidgetCard>
  );
}
