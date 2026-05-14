'use client';

import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';

// Tiny client wrapper so the rest of the document shell stays a
// server component. window.print() is the entire interactivity here.
export function PrintButton({ children }: { children: ReactNode }) {
  return (
    <Button
      size="sm"
      onClick={() => {
        window.print();
      }}
    >
      {children}
    </Button>
  );
}
