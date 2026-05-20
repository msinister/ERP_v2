import Link from 'next/link';
import { db } from '@/lib/db';
import { recentActivityWidget } from '@/server/services/reports/dashboard';
import { WidgetCard } from './widget-card';

// Quick pulse-check of the audit log — last 10 sensitive actions
// system-wide. Full filtering lives on /admin/audit-log; the widget's
// "View all" sends operators there.

export async function RecentActivityWidget() {
  const data = await recentActivityWidget(db);
  return (
    <WidgetCard title="Recent Activity" subtitle="Last 10 audit entries">
      {data.rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No activity yet.</p>
      ) : (
        <>
          <ul className="-mx-1 space-y-0.5">
            {data.rows.map((row) => (
              <li
                key={row.id}
                className="flex items-baseline justify-between gap-3 rounded-sm px-1 py-1 text-xs hover:bg-muted/40"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate">
                    <span className="font-medium">
                      {row.userName ?? row.userEmail ?? 'System'}
                    </span>{' '}
                    <span className="text-muted-foreground">
                      {formatAction(row.action)}
                    </span>{' '}
                    <span className="font-mono text-[11px] text-muted-foreground">
                      {row.entityType}
                    </span>
                  </div>
                  {row.reason ? (
                    <div
                      className="truncate text-[11px] text-muted-foreground"
                      title={row.reason}
                    >
                      {row.reason}
                    </div>
                  ) : null}
                </div>
                <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                  {formatRelative(row.createdAt)}
                </span>
              </li>
            ))}
          </ul>
          <div className="mt-3 text-right text-xs">
            <Link
              href="/admin/audit-log"
              className="font-medium hover:underline"
            >
              View all →
            </Link>
          </div>
        </>
      )}
    </WidgetCard>
  );
}

function formatAction(action: string): string {
  return action
    .split('_')
    .map((p) => p.charAt(0) + p.slice(1).toLowerCase())
    .join(' ');
}

// Compact "5m ago" / "2h ago" / "Mar 4" relative timestamp — fits in
// the right gutter without wrapping. Falls back to a date label after
// 7 days so old entries stay legible without a clock-precision tail.
function formatRelative(d: Date): string {
  const diffMs = Date.now() - d.getTime();
  if (diffMs < 60_000) return 'just now';
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
