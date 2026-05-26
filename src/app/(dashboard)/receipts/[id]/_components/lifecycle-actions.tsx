'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  CheckCircle2,
  MoreVertical,
  Trash2,
  XCircle,
} from 'lucide-react';
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Field, FieldError, FieldLabel } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';

type Props = {
  receiptId: string;
  receiptNumber: string;
  status: string;
};

// Receipt lifecycle:
//   DRAFT → POSTED (manual; consumes inventory, FIFO layer, GL leg,
//                    auto-drafts a vendor bill)
//   POSTED → CANCELLED (manual, blocked if a CONFIRMED bill linked
//                       or if any layer from this receipt has been
//                       consumed)
//   DRAFT or CANCELLED → soft-deleted

export function ReceiptLifecycleActions(props: Props) {
  const { status } = props;
  const canPost = status === 'DRAFT';
  const canCancel = status === 'POSTED';
  const canDelete = status === 'DRAFT' || status === 'CANCELLED';

  // Cancel/Delete confirm dialogs are controlled here and rendered as
  // siblings OUTSIDE the dropdown — a dialog nested inside
  // DropdownMenuContent unmounts (only flashes) when the menu closes on
  // item-press, since Base UI ignores preventDefault for the item close.
  // See admin/payment-terms/.../term-row-actions.tsx for the canonical shape.
  const [cancelOpen, setCancelOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  return (
    <div className="flex items-center gap-2">
      {canPost ? <PostAction {...props} /> : null}
      {canCancel || canDelete ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="outline"
                size="icon-sm"
                aria-label="More actions"
              />
            }
          >
            <MoreVertical />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {canCancel ? (
              <DropdownMenuItem
                onClick={() => setCancelOpen(true)}
                variant="destructive"
              >
                <XCircle className="size-4" />
                Cancel receipt
              </DropdownMenuItem>
            ) : null}
            {canDelete ? (
              <DropdownMenuItem
                onClick={() => setDeleteOpen(true)}
                variant="destructive"
              >
                <Trash2 className="size-4" />
                Delete receipt
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}

      {canCancel ? (
        <CancelDialog {...props} open={cancelOpen} onOpenChange={setCancelOpen} />
      ) : null}
      {canDelete ? (
        <DeleteDialog {...props} open={deleteOpen} onOpenChange={setDeleteOpen} />
      ) : null}
    </div>
  );
}

type DialogProps = Props & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

// =============================================================================
// Post — simple POST. Service auto-drafts a vendor bill on success.
// =============================================================================

function PostAction({ receiptId, receiptNumber }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  function onPost() {
    startTransition(async () => {
      try {
        const res = await fetch(`/api/receipts/${receiptId}/post`, {
          method: 'POST',
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          toast.error(body.error ?? `Post failed (${res.status})`);
          return;
        }
        const posted = (await res.json()) as {
          number: string;
          wasOverReceived?: boolean;
        };
        if (posted.wasOverReceived) {
          toast.warning(
            `Posted ${posted.number} — note: over-received vs ordered.`,
          );
        } else {
          toast.success(`Posted ${receiptNumber}`);
        }
        setOpen(false);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Network error');
      }
    });
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <Button size="sm" onClick={() => setOpen(true)}>
        <CheckCircle2 />
        Post
      </Button>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Post this receipt?</AlertDialogTitle>
          <AlertDialogDescription>
            Consumes inventory at the receiving warehouse, writes the FIFO
            cost layer, posts the GL leg (DR Inventory / CR Accrued
            Receipts), and auto-drafts a vendor bill for AP to confirm.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onPost} disabled={pending}>
            {pending ? 'Posting…' : 'Post'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// =============================================================================
// Cancel — required reason. Service rejects when a CONFIRMED bill links
// to the receipt or when any FIFO layer from this receipt has been
// consumed. Dialog rendered as a dropdown sibling.
// =============================================================================

function CancelDialog({
  receiptId,
  receiptNumber,
  open,
  onOpenChange,
}: DialogProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  function onCancel() {
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
          toast.error(body.error ?? `Cancel failed (${res.status})`);
          return;
        }
        toast.success(`Cancelled ${receiptNumber}`);
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
        onOpenChange(o);
        if (!o) {
          setReason('');
          setError(null);
        }
      }}
    >
      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>Cancel this receipt?</AlertDialogTitle>
          <AlertDialogDescription>
            Reverses the inventory movement, soft-deletes the FIFO layers,
            posts a sign-mirror GL leg, and cancels any auto-drafted bill.
            Blocked when a CONFIRMED bill links to this receipt or when
            any layer from it has been consumed by a sale.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <Field>
          <FieldLabel htmlFor="receipt-cancel-reason">Reason</FieldLabel>
          <Textarea
            id="receipt-cancel-reason"
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
            onClick={onCancel}
            disabled={pending}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {pending ? 'Cancelling…' : 'Cancel receipt'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// =============================================================================
// Delete — soft-delete, DRAFT or CANCELLED only. Dialog rendered as a
// dropdown sibling.
// =============================================================================

function DeleteDialog({
  receiptId,
  receiptNumber,
  open,
  onOpenChange,
}: DialogProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function onDelete() {
    startTransition(async () => {
      try {
        const res = await fetch(`/api/receipts/${receiptId}`, {
          method: 'DELETE',
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          toast.error(body.error ?? `Delete failed (${res.status})`);
          return;
        }
        toast.success(`Deleted ${receiptNumber}`);
        onOpenChange(false);
        router.push('/purchase-orders');
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Network error');
      }
    });
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this receipt?</AlertDialogTitle>
          <AlertDialogDescription>
            <span className="font-mono font-medium text-foreground">
              {receiptNumber}
            </span>{' '}
            will be hidden from lists but remain in the audit log.
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
  );
}
