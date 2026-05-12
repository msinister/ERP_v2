import type { ReactNode } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

// Tiny consistency layer for the detail-page tab bodies. Each tab
// ultimately renders inside a TabsContent, so the wrapper just adds
// vertical rhythm. Empty-state helper lives here too so every tab
// agrees on what "no rows" looks like.

export function TabShell({ children }: { children: ReactNode }) {
  return <div className="space-y-4 pt-4">{children}</div>;
}

export function TabEmpty({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
      {message}
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
