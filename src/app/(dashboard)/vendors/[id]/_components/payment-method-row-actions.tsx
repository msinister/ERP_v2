'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Eye, MoreVertical, Star, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { PaymentMethodRevealDialog } from './payment-method-reveal-dialog';

export type PaymentMethodRowData = {
  id: string;
  displayHint: string;
  isPreferred: boolean;
};

export function PaymentMethodRowActions({
  vendorId,
  paymentMethod,
}: {
  vendorId: string;
  paymentMethod: PaymentMethodRowData;
}) {
  const router = useRouter();
  const [revealOpen, setRevealOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  function onSetPreferred() {
    if (paymentMethod.isPreferred) return;
    startTransition(async () => {
      try {
        const res = await fetch(
          `/api/vendors/${vendorId}/payment-methods/${paymentMethod.id}/set-preferred`,
          { method: 'POST' },
        );
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          toast.error(body.error ?? `Failed (${res.status})`);
          return;
        }
        toast.success('Set as preferred');
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Network error');
      }
    });
  }

  function onDelete() {
    startTransition(async () => {
      try {
        const res = await fetch(
          `/api/vendors/${vendorId}/payment-methods/${paymentMethod.id}`,
          { method: 'DELETE' },
        );
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          toast.error(body.error ?? `Delete failed (${res.status})`);
          return;
        }
        toast.success('Deleted payment method');
        setDeleteOpen(false);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Network error');
      }
    });
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Payment method actions"
            />
          }
        >
          <MoreVertical />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => setRevealOpen(true)}>
            <Eye className="size-4" />
            Reveal details
          </DropdownMenuItem>
          {!paymentMethod.isPreferred ? (
            <DropdownMenuItem onClick={onSetPreferred} disabled={pending}>
              <Star className="size-4" />
              Set as preferred
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem
            variant="destructive"
            onClick={() => setDeleteOpen(true)}
          >
            <Trash2 className="size-4" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <PaymentMethodRevealDialog
        vendorId={vendorId}
        paymentMethodId={paymentMethod.id}
        label={paymentMethod.displayHint}
        open={revealOpen}
        onOpenChange={setRevealOpen}
      />

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this payment method?</AlertDialogTitle>
            <AlertDialogDescription>
              <span className="font-medium text-foreground">
                {paymentMethod.displayHint}
              </span>{' '}
              will be hidden from the vendor but remain in the audit log.
              Historical bill payments referencing the method are unaffected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={onDelete}
              disabled={pending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {pending ? 'Deleting…' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
