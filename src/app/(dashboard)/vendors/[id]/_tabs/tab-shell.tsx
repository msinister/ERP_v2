import type { ReactNode } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

// Tiny consistency layer for the detail-page tab bodies. Mirrors the
// customer detail's tab-shell so tabs across modules feel the same.

export function TabShell({ children }: { children: ReactNode }) {
  return <div className="space-y-4 pt-4">{children}</div>;
}

export function TabEmpty({
  message,
  action,
}: {
  message: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
      <div>{message}</div>
      {action ? <div>{action}</div> : null}
    </div>
  );
}

export function TabSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <TabShell>
      <div className={cn('space-y-2')}>
        {Array.from({ length: rows }).map((_, i) => (
          <Skeleton key={i} className="h-12" />
        ))}
      </div>
    </TabShell>
  );
}
