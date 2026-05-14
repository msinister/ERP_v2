import type { ReactNode } from 'react';
import Link from 'next/link';
import { ChevronLeft, Printer } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PrintButton } from './print-button';

// Wrapper for every printable document. On screen it shows a paper-ish
// card with Back + Print buttons in a top bar; on print, the chrome
// hides (via .no-print in print.css) and only the document content
// reaches the printer.
//
// `backHref` should point at the source record (SO detail, PO detail,
// etc.) so the operator can navigate away after printing without
// re-typing URLs. The user typically opens the document in a new tab
// from a button in the app — the Back link is the manual escape.

export function DocumentShell({
  backHref,
  backLabel,
  children,
}: {
  backHref: string;
  backLabel: string;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto max-w-[8.5in] py-6">
      <div className="no-print mb-3 flex items-center justify-between gap-3">
        <Button
          variant="outline"
          size="sm"
          render={<Link href={backHref} />}
        >
          <ChevronLeft />
          {backLabel}
        </Button>
        <PrintButton>
          <Printer />
          Print / Save PDF
        </PrintButton>
      </div>
      <div className="document-paper rounded-md border border-border bg-white p-8 text-sm text-foreground shadow-sm">
        {children}
      </div>
    </div>
  );
}
