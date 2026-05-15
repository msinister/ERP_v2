'use client';

import { useState } from 'react';
import { PreviewCard } from '@base-ui/react/preview-card';
import { Package } from 'lucide-react';

import { cn } from '@/lib/utils';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from '@/components/ui/dialog';

// =============================================================================
// ProductThumbnail
//
// 40x40 image cell used in line-item tables (and the mobile card view).
// Three behaviors:
//   1. Image present → renders <img> with object-cover + lazy loading.
//      Hover (200ms delay) shows a 200x200 preview popover. Click opens
//      a Dialog lightbox with the image at natural size, capped at 600px.
//   2. No image → renders a Package icon in the same 40x40 container.
//      No hover, no click.
//   3. Touch devices → hover preview is suppressed by the
//      (hover: hover) media gate on the PreviewCard.Trigger render path.
//      Tap-to-enlarge still works via the underlying button click.
//
// `alt` defaults to productName when omitted, falling back to a generic
// label so screen readers always get something useful.
// =============================================================================

export function ProductThumbnail({
  src,
  alt,
  productName,
  className,
}: {
  src?: string | null;
  alt?: string | null;
  productName?: string | null;
  className?: string;
}) {
  const [openLightbox, setOpenLightbox] = useState(false);
  const resolvedAlt =
    (alt && alt.trim() !== '' && alt) ||
    (productName && productName.trim() !== '' && productName) ||
    'Product image';

  // No image: render a muted placeholder. Not clickable, no hover.
  if (!src) {
    return (
      <div
        aria-label="No image"
        className={cn(
          'flex size-10 shrink-0 items-center justify-center rounded-md bg-muted/40 text-muted-foreground',
          className,
        )}
      >
        <Package className="size-5" aria-hidden />
      </div>
    );
  }

  return (
    <>
      <PreviewCard.Root>
        <PreviewCard.Trigger
          // 200ms open delay per spec — enough to avoid accidental
          // popovers when the cursor crosses the thumbnail in transit,
          // short enough to feel responsive on deliberate hover.
          delay={200}
          // Render as a plain <button> so a click opens the lightbox
          // instead of toggling the preview card. PreviewCard's hover
          // semantics still attach.
          render={
            <button
              type="button"
              aria-label={`Open ${resolvedAlt} at full size`}
              onClick={() => setOpenLightbox(true)}
              className={cn(
                'block size-10 shrink-0 overflow-hidden rounded-md bg-muted/30 outline-none transition-shadow hover:ring-2 hover:ring-ring focus-visible:ring-2 focus-visible:ring-ring',
                className,
              )}
            />
          }
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={src}
            alt={resolvedAlt}
            loading="lazy"
            className="size-full object-cover"
          />
        </PreviewCard.Trigger>
        <PreviewCard.Portal>
          <PreviewCard.Positioner sideOffset={8} className="z-50">
            <PreviewCard.Popup
              // Suppress on touch-only devices: (hover: hover) is true
              // only for environments with a hovering input. base-ui
              // doesn't auto-disable on touch, so we gate the popup's
              // visibility via the media query.
              className="hidden rounded-lg bg-popover p-1 shadow-lg ring-1 ring-foreground/10 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 [@media(hover:hover)]:block"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={src}
                alt={resolvedAlt}
                loading="lazy"
                className="block size-[200px] rounded-md object-cover"
              />
            </PreviewCard.Popup>
          </PreviewCard.Positioner>
        </PreviewCard.Portal>
      </PreviewCard.Root>

      <Dialog open={openLightbox} onOpenChange={setOpenLightbox}>
        <DialogContent
          className="w-auto max-w-[min(calc(100vw-2rem),600px)] bg-popover p-2"
          showCloseButton
        >
          {/* DialogTitle for a11y; visually hidden since the image alt
              carries the description. */}
          <DialogTitle className="sr-only">{resolvedAlt}</DialogTitle>
          <DialogClose
            // Whole-image click also closes — matches lightbox UX
            // people expect (click outside / Escape / X / click image).
            className="block w-full"
            render={
              <button type="button" aria-label="Close image preview" />
            }
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={src}
              alt={resolvedAlt}
              className="block max-h-[calc(100vh-8rem)] max-w-full rounded-md object-contain"
            />
          </DialogClose>
        </DialogContent>
      </Dialog>
    </>
  );
}
