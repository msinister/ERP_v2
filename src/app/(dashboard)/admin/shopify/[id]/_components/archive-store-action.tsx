'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Trash2 } from 'lucide-react';
import { toast } from '@/lib/toast';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

// Soft-archive: flips deletedAt + active=false + syncEnabled=false +
// inventoryPushEnabled=false. The store row + its junction rows are
// preserved so historical syncs / pushes still resolve, but no new
// activity will run against it. Operators can un-archive via the API
// (PUT with active=true on the row) — not yet exposed in the UI.

export function ArchiveStoreAction({
  storeId,
  storeName,
}: {
  storeId: string;
  storeName: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  function onConfirm() {
    startTransition(async () => {
      try {
        const res = await fetch(`/api/admin/shopify/stores/${storeId}`, {
          method: 'DELETE',
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          toast.error(body.error ?? `Archive failed (${res.status})`);
          return;
        }
        toast.success(`Archived ${storeName}.`);
        setOpen(false);
        router.push('/admin/shopify');
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Network error');
      }
    });
  }

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <Trash2 />
        Archive store
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive {storeName}?</AlertDialogTitle>
            <AlertDialogDescription>
              Sync, inventory push, and active flags will be turned off. The
              store row + its product-junction rows are preserved (history
              stays intact); incoming webhooks for this store will be silently
              acknowledged but not processed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={onConfirm} disabled={pending}>
              {pending ? 'Archiving…' : 'Archive store'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
