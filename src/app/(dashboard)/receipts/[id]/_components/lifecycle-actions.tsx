'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  CheckCircle2,
  MoreVertical,
  Trash2,
  Undo2,
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
import { ReverseReceiptDialog } from '@/components/shared/reverse-receipt-dialog';

type Props = {
  receiptId: string;
  receiptNumber: string;
  status: string;
};

// Receipt lifecycle:
//   DRAFT → POSTED (manual; consumes inventory, FIFO layer, GL leg,
//                    auto-drafts a vendor bill)
//   POSTED → CANCELLED ("Reverse receipt"; backs out inventory, blocked
//                       if a CONFIRMED bill linked or if any layer from
//                       this receipt has been consumed)
//   DRAFT or CANCELLED → soft-deleted

export function ReceiptLifecycleActions(props: Props) {
  const { status } = props;
  const canPost = status === 'DRAFT';
  const canReverse = status === 'POSTED';
  const canDelete = status === 'DRAFT' || status === 'CANCELLED';

  // Reverse/Delete dialogs are controlled here and rendered as siblings
  // OUTSIDE the dropdown — a dialog nested inside DropdownMenuContent
  // unmounts (only flashes) when the menu closes on item-press, since
  // Base UI ignores preventDefault for the item close.
  const [reverseOpen, setReverseOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  return (
    <div className="flex items-center gap-2">
      {canPost ? <PostAction {...props} /> : null}
      {canReverse || canDelete ? (
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
            {canReverse ? (
              <DropdownMenuItem
                onClick={() => setReverseOpen(true)}
                variant="destructive"
              >
                <Undo2 className="size-4" />
                Reverse receipt
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

      {canReverse ? (
        <ReverseReceiptDialog
          receiptId={props.receiptId}
          receiptNumber={props.receiptNumber}
          open={reverseOpen}
          onOpenChange={setReverseOpen}
        />
      ) : null}
      {canDelete ? (
        <DeleteDialog {...props} open={deleteOpen} onOpenChange={setDeleteOpen} />
      ) : null}
    </div>
  );
}

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
// Delete — soft-delete, DRAFT or CANCELLED only. Dialog rendered as a
// dropdown sibling.
// =============================================================================

function DeleteDialog({
  receiptId,
  receiptNumber,
  open,
  onOpenChange,
}: Props & { open: boolean; onOpenChange: (open: boolean) => void }) {
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
