import Link from 'next/link';
import { cn } from '@/lib/utils';

type Status = 'PENDING' | 'RESOLVED_EXISTING' | 'RESOLVED_NEW' | 'DISMISSED';

const TABS: Array<{ value: Status; label: string }> = [
  { value: 'PENDING', label: 'Pending' },
  { value: 'RESOLVED_EXISTING', label: 'Resolved (existing)' },
  { value: 'RESOLVED_NEW', label: 'Resolved (new)' },
  { value: 'DISMISSED', label: 'Dismissed' },
];

export function StatusTabs({
  current,
  counts,
}: {
  current: Status;
  counts: Partial<Record<Status, number>>;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1 border-b">
      {TABS.map((t) => {
        const isCurrent = current === t.value;
        const count = counts[t.value] ?? 0;
        return (
          <Link
            key={t.value}
            href={`/admin/pending-orders?status=${t.value}`}
            className={cn(
              'flex items-center gap-2 border-b-2 px-3 py-2 text-sm transition-colors',
              isCurrent
                ? 'border-foreground font-medium'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {t.label}
            <span
              className={cn(
                'rounded px-1.5 py-0.5 text-xs tabular-nums',
                isCurrent
                  ? 'bg-foreground text-background'
                  : 'bg-muted text-muted-foreground',
              )}
            >
              {count}
            </span>
          </Link>
        );
      })}
    </div>
  );
}
