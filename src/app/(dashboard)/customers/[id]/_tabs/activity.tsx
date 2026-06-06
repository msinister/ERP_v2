import Link from 'next/link';
import { db } from '@/lib/db';
import { Badge } from '@/components/ui/badge';
import { getCustomerTimeline } from '@/server/services/customerTimeline';
import { TabShell, TabEmpty } from './tab-shell';
import { AddNoteForm } from '../_components/add-note-form';

// Dashboard always reflects live data — revalidate=0 is set on the parent
// page; the tab inherits it. No separate cache directive needed here.

const PAGE_SIZE = 100;

export async function ActivityTab({
  customerId,
  searchParams,
}: {
  customerId: string;
  searchParams?: Record<string, string | string[] | undefined>;
}) {
  const skip = Math.max(0, Number(searchParams?.activitySkip ?? 0) || 0);
  const { entries, hasMore } = await getCustomerTimeline(db, customerId, {
    skip,
    take: PAGE_SIZE,
  });

  return (
    <TabShell>
      {/* Manual note entry — renders as a client component */}
      <AddNoteForm customerId={customerId} />

      {entries.length === 0 && skip === 0 ? (
        <TabEmpty message="No activity yet." />
      ) : (
        <ol className="space-y-2">
          {entries.map((e) => (
            <li
              key={e.id}
              className="flex gap-3 rounded-lg border border-border p-3 text-sm"
            >
              {/* Timestamp column */}
              <div className="w-32 shrink-0 text-xs text-muted-foreground tabular-nums">
                {formatTimestamp(e.ts)}
              </div>

              {/* Content column */}
              <div className="flex min-w-0 flex-1 items-start justify-between gap-3">
                <div className="min-w-0 space-y-0.5">
                  {/* Actor badge */}
                  <div className="flex items-center gap-1.5">
                    {e.actorName ? (
                      <span className="text-xs font-medium">{e.actorName}</span>
                    ) : (
                      <Badge variant="outline" className="text-[10px] uppercase">
                        AUTO
                      </Badge>
                    )}
                  </div>
                  {/* Label — optionally linked */}
                  {e.href ? (
                    <Link
                      href={e.href}
                      className="block truncate font-medium hover:underline"
                    >
                      {e.label}
                    </Link>
                  ) : (
                    <p className="truncate font-medium">{e.label}</p>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}

      {/* Pagination */}
      <div className="flex items-center justify-between pt-1">
        {skip > 0 ? (
          <Link
            href={`?activitySkip=${Math.max(0, skip - PAGE_SIZE)}`}
            className="text-xs text-muted-foreground hover:text-foreground hover:underline"
          >
            ← Newer
          </Link>
        ) : (
          <span />
        )}
        {hasMore ? (
          <Link
            href={`?activitySkip=${skip + PAGE_SIZE}`}
            className="text-xs text-muted-foreground hover:text-foreground hover:underline"
          >
            Show more →
          </Link>
        ) : null}
      </div>
    </TabShell>
  );
}

function formatTimestamp(d: Date): string {
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
