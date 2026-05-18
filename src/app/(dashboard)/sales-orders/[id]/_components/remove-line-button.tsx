'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Trash2 } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

// Hover-only remove-line button. Stays opacity-0 at rest so non-bundle
// rows look unchanged; reveals on row hover via the parent's `group`
// class. When the targeted line belongs to a bundle group, the dialog
// offers two destructive choices — "Remove line" (single) or
// "Remove bundle" (whole group) — wired to the same DELETE endpoint
// with the `?bundle=true` query flag.
//
// Lifecycle: DRAFT + CONFIRMED only. Caller (lines-table) hides the
// button entirely on other statuses, so this component assumes it
// should always be interactable when rendered.
//
// Variant `inline-card` is for the mobile card layout where hover
// affordances are awkward — there the button stays always visible at
// reduced contrast so a tap target is consistently available.

export function RemoveLineButton({
  salesOrderId,
  lineId,
  sku,
  qty,
  bundleSku,
  variant = 'hover',
}: {
  salesOrderId: string;
  lineId: string;
  sku: string;
  qty: string;
  bundleSku: string | null;
  variant?: 'hover' | 'inline-card';
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const inBundle = bundleSku != null;

  function doRemove(removeBundleGroup: boolean) {
    startTransition(async () => {
      try {
        const qs = removeBundleGroup ? '?bundle=true' : '';
        const res = await fetch(
          `/api/sales-orders/${salesOrderId}/lines/${lineId}${qs}`,
          { method: 'DELETE' },
        );
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          toast.error(body.error ?? `Remove failed (${res.status})`);
          return;
        }
        toast.success(
          removeBundleGroup
            ? `Removed bundle ${bundleSku ?? ''}`.trim()
            : `Removed ${sku}`,
        );
        setOpen(false);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Network error');
      }
    });
  }

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={() => setOpen(true)}
        aria-label={`Remove line ${sku}`}
        className={cn(
          'text-muted-foreground hover:text-destructive',
          variant === 'hover'
            ? 'opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100'
            : '',
        )}
      >
        <Trash2 className="size-4" aria-hidden />
      </Button>

      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {inBundle ? 'Remove this line?' : 'Remove this line?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {inBundle ? (
                <>
                  This item is part of bundle{' '}
                  <span className="font-mono font-medium">{bundleSku}</span>.
                  Remove just this line ({sku} × {qty}), or the entire bundle?
                </>
              ) : (
                <>
                  <span className="font-mono font-medium">{sku}</span> × {qty}{' '}
                  will be removed from the order.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            {inBundle ? (
              <>
                {/* Two destructive buttons side-by-side — explicit
                    choice so the operator can't misclick a default. */}
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => doRemove(false)}
                  disabled={pending}
                >
                  Remove line
                </Button>
                <Button
                  type="button"
                  onClick={() => doRemove(true)}
                  disabled={pending}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  {pending ? 'Removing…' : 'Remove bundle'}
                </Button>
              </>
            ) : (
              <Button
                type="button"
                onClick={() => doRemove(false)}
                disabled={pending}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                {pending ? 'Removing…' : 'Remove line'}
              </Button>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
