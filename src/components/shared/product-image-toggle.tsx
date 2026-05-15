'use client';

import { ImageOff, Image as ImageIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useProductImageToggle } from '@/lib/hooks/useProductImageToggle';

// Show/hide product image columns in line-item tables. Click toggles a
// global class on <html> via the hook; the LinesTables' image cells
// have the matching `.hide-product-images_…:hidden` Tailwind selector
// that responds.
//
// Place this near a table header to give operators a visible control
// over the feature. Preference persists across reloads (localStorage).

export function ProductImageToggle({
  className,
}: {
  className?: string;
}) {
  const { show, toggle } = useProductImageToggle();
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={toggle}
      aria-pressed={show}
      title={show ? 'Hide product images' : 'Show product images'}
      className={className}
    >
      {show ? (
        <ImageIcon className="size-3.5" aria-hidden />
      ) : (
        <ImageOff className="size-3.5" aria-hidden />
      )}
      {show ? 'Images' : 'Images off'}
    </Button>
  );
}
