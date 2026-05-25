'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Archive } from 'lucide-react';
import { toast } from '@/lib/toast';
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
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';

// Soft-archives a product (sets active=false + deletedAt). There's no
// unarchive path in the backend today — deferred per Phase 4 design
// decisions. Routes through DELETE /api/products/[id] which the
// existing route maps to archiveProduct.

export function ArchiveProductAction({
  productId,
  productName,
}: {
  productId: string;
  productName: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  function onConfirm() {
    startTransition(async () => {
      try {
        const res = await fetch(`/api/products/${productId}`, {
          method: 'DELETE',
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          toast.error(body.error ?? `Archive failed (${res.status})`);
          return;
        }
        toast.success(`Archived ${productName}`);
        setOpen(false);
        router.push('/products');
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Network error');
      }
    });
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <DropdownMenuItem
        onClick={(e) => {
          e.preventDefault();
          setOpen(true);
        }}
        variant="destructive"
      >
        <Archive className="size-4" />
        Archive product
      </DropdownMenuItem>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Archive this product?</AlertDialogTitle>
          <AlertDialogDescription>
            <span className="font-medium text-foreground">{productName}</span>{' '}
            will be hidden from lists and the SO entry SKU picker. Existing
            orders and history are unaffected. Unarchive isn&apos;t available
            yet — archive is one-way for now.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            disabled={pending}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {pending ? 'Archiving…' : 'Archive'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
