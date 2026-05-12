'use client';

import { useEffect } from 'react';
import { AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

// Per-segment error boundary for any (dashboard) route. Next requires
// this to be a client component with a `reset` prop. Renders inside
// AppShell, so the sidebar + top bar remain navigable when one page
// throws.

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Surface the error to the browser console so devtools shows it.
    // Server-side stack lands in the server logs via Next's own
    // reporter; we don't dual-report here.
    console.error(error);
  }, [error]);

  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <AlertCircle className="size-4 text-destructive" />
            Something went wrong
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {error.message || 'An unexpected error occurred.'}
          </p>
          {error.digest ? (
            <p className="font-mono text-xs text-muted-foreground">
              ref: {error.digest}
            </p>
          ) : null}
          <Button onClick={reset} size="sm">
            Try again
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
