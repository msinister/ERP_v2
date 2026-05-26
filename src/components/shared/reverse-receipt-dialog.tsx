'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Undo2 } from 'lucide-react';
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
import { Field, FieldError, FieldLabel } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';

// Reverse (undo) a POSTED receipt. POST /api/receipts/[id]/cancel backs
// out the inventory movement (RECEIVE_REVERSE), soft-deletes the FIFO
// layers + receipt lines — which frees the parent PO to be cancelled —
// posts the offsetting GL leg, and cancels any auto-drafted DRAFT bill.
//
// Shared by the receipt detail page (⋮ menu) and the PO detail Receipts
// table (per-row button). Always render the dialog as a sibling, never
// nested inside DropdownMenuContent (it would unmount when the menu
// closes — see term-row-actions / the b254f83 fix).

type ReverseReceiptDialogProps = {
  receiptId: string;
  receiptNumber: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function ReverseReceiptDialog({
  receiptId,
  receiptNumber,
  open,
  onOpenChange,
}: ReverseReceiptDialogProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  function onReverse() {
    setError(null);
    if (reason.trim().length === 0) {
      setError('Reason is required');
      return;
    }
    startTransition(async () => {
      try {
        const res = await fetch(`/api/receipts/${receiptId}/cancel`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason: reason.trim() }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          toast.error(body.error ?? `Reverse failed (${res.status})`);
          return;
        }
        toast.success(`Reversed ${receiptNumber}`);
        onOpenChange(false);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Network error');
      }
    });
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(o) => {
        if (!o && pending) return; // don't close mid-request
        if (!o) {
          setReason('');
          setError(null);
        }
        onOpenChange(o);
      }}
    >
      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>Reverse this receipt?</AlertDialogTitle>
          <AlertDialogDescription>
            Backs out the inventory received, soft-deletes the FIFO layers,
            posts a sign-mirror GL leg, and cancels any auto-drafted bill.
            This frees the linked PO to be cancelled. Blocked when a
            CONFIRMED bill links to this receipt or when any layer from it
            has already been consumed by a sale.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <Field>
          <FieldLabel htmlFor={`reverse-receipt-reason-${receiptId}`}>
            Reason
          </FieldLabel>
          <Textarea
            id={`reverse-receipt-reason-${receiptId}`}
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. wrong vendor shipped, damaged in transit, etc."
            aria-invalid={!!error}
          />
          {error ? <FieldError errors={[{ message: error }]} /> : null}
        </Field>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Keep receipt</AlertDialogCancel>
          <AlertDialogAction
            onClick={onReverse}
            disabled={pending}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {pending ? 'Reversing…' : 'Reverse receipt'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// Self-contained button + dialog, for use inside a table row. `relative
// z-10` keeps the button clickable above a row-level stretched link.
export function ReverseReceiptButton({
  receiptId,
  receiptNumber,
}: {
  receiptId: string;
  receiptNumber: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative z-10 flex justify-end">
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Undo2 />
        Reverse
      </Button>
      <ReverseReceiptDialog
        receiptId={receiptId}
        receiptNumber={receiptNumber}
        open={open}
        onOpenChange={setOpen}
      />
    </div>
  );
}
