import Link from 'next/link';
import { Button } from '@/components/ui/button';

// App-level 404. Renders outside the (dashboard) shell on purpose —
// an unauthenticated user hitting a bad URL shouldn't see chrome
// implying they're signed in.

export default function NotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/30 p-4">
      <div className="space-y-4 text-center">
        <p className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
          404
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">
          Page not found
        </h1>
        <p className="text-sm text-muted-foreground">
          The URL you opened doesn&apos;t match any route in this ERP.
        </p>
        <Button render={<Link href="/" />} size="sm">
          Back to start
        </Button>
      </div>
    </main>
  );
}
