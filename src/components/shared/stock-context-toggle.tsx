'use client';

import { Eye, EyeOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useStockContextToggle } from '@/lib/hooks/useStockContextToggle';

// Show/hide the internal-only stock + cost reference rows in line-item
// tables (QOH, Available, WAC, Last). Mirrors ProductImageToggle: click
// toggles a global class on <html> via the hook; matching CSS-conditional
// cells respond via `[.hide-stock-context_&]:hidden`.
//
// Preference persists across reloads (localStorage). These fields never
// render on customer-facing documents regardless of this toggle.

export function StockContextToggle({ className }: { className?: string }) {
  const { show, toggle } = useStockContextToggle();
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={toggle}
      aria-pressed={show}
      title={show ? 'Hide stock info' : 'Show stock info'}
      className={className}
    >
      {show ? (
        <Eye className="size-3.5" aria-hidden />
      ) : (
        <EyeOff className="size-3.5" aria-hidden />
      )}
      {show ? 'Stock info' : 'Stock info off'}
    </Button>
  );
}
