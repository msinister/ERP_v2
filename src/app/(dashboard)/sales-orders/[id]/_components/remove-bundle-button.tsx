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

// Trash icon on the synthetic bundle-header row. The header itself
// isn't a real SalesOrderLine, so removal targets any one component
// line in the group with `?bundle=true`, which the service expands
// to the full group via bundleGroupId. Wording is single-action
// (the operator already chose the bundle by clicking the header),
// distinct from the per-component-line dialog where both
// "Remove line" and "Remove bundle" are surfaced.
//
// Variant `inline-card` is for the mobile BundleHeaderCard where the
// hover-only opacity transition is unreliable on touch devices.

export function RemoveBundleButton({
  salesOrderId,
  representativeLineId,
  bundleSku,
  lineCount,
  variant = 'hover',
}: {
  salesOrderId: string;
  representativeLineId: string;
  bundleSku: string | null;
  lineCount: number;
  variant?: 'hover' | 'inline-card';
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  function doRemove() {
    startTransition(async () => {
      try {
        const res = await fetch(
          `/api/sales-orders/${salesOrderId}/lines/${representativeLineId}?bundle=true`,
          { method: 'DELETE' },
        );
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          toast.error(body.error ?? `Remove failed (${res.status})`);
          return;
        }
        toast.success(`Removed bundle ${bundleSku ?? ''}`.trim());
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
        aria-label={`Remove bundle ${bundleSku ?? ''}`.trim()}
        className={cn(
          'text-amber-700/70 hover:text-destructive dark:text-amber-300/70',
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
            <AlertDialogTitle>Remove entire bundle?</AlertDialogTitle>
            <AlertDialogDescription>
              All {lineCount} item{lineCount === 1 ? '' : 's'} in{' '}
              <span className="font-mono font-medium">
                {bundleSku ?? '—'}
              </span>{' '}
              will be removed from this order.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            <Button
              type="button"
              onClick={doRemove}
              disabled={pending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {pending ? 'Removing…' : 'Remove bundle'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
