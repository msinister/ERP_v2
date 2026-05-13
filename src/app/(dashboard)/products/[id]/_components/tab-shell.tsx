import type { ReactNode } from 'react';

// Vertical-rhythm wrapper + empty-state helper. Mirrors the customer
// detail-page tabs so both modules feel the same.

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
