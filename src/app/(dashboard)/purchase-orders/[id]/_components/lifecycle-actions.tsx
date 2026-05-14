'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  CheckCircle2,
  MoreVertical,
  PackagePlus,
  Pencil,
  Trash2,
  XCircle,
} from 'lucide-react';
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
import { Field, FieldError, FieldLabel } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';

type Props = {
  purchaseOrderId: string;
  purchaseOrderNumber: string;
  status: string;
};

// Mirrors the SO lifecycle component but with PO state machine:
//   DRAFT → CONFIRMED (manual)
//   CONFIRMED ↔ PARTIALLY_RECEIVED (auto, driven by receipts)
//   PARTIALLY_RECEIVED → CLOSED (auto when every line is fully received)
//   any non-CLOSED → CANCELLED (manual, blocked if active receipt lines)
//   DRAFT or CANCELLED → soft-deleted
//
// Receive button is rendered for CONFIRMED / PARTIALLY_RECEIVED and
// links to /purchase-orders/[id]/receive (the receive flow lands in
// 6G; until then the link 404s, same staged pattern as 6A → 6B).
export function LifecycleActions(props: Props) {
  const { status } = props;

  const canConfirm = status === 'DRAFT';
  const canEdit = status === 'DRAFT';
  const canReceive =
    status === 'CONFIRMED' || status === 'PARTIALLY_RECEIVED';
  // Service rejects cancel on CLOSED + CANCELLED. DRAFT cancel is also
  // allowed (use Delete instead is more natural, but cancel works too).
  const canCancel =
    status === 'DRAFT' ||
    status === 'CONFIRMED' ||
    status === 'PARTIALLY_RECEIVED';
  const canDelete = status === 'DRAFT' || status === 'CANCELLED';

  return (
    <div className="flex items-center gap-2">
      {canConfirm ? <ConfirmAction {...props} /> : null}
      {canReceive ? <ReceiveAction {...props} /> : null}
      {canEdit ? (
        <Button
          variant="outline"
          size="sm"
          render={
            <Link href={`/purchase-orders/${props.purchaseOrderId}/edit`} />
          }
        >
          <Pencil />
          Edit
        </Button>
      ) : null}
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
            {canCancel ? <CancelMenuItem {...props} /> : null}
            {canDelete ? <DeleteMenuItem {...props} /> : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
}

// =============================================================================
// Confirm — simple POST, no payload. Service flips DRAFT → CONFIRMED.
// =============================================================================

function ConfirmAction({ purchaseOrderId, purchaseOrderNumber }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  function onConfirm() {
    startTransition(async () => {
      try {
        const res = await fetch(
          `/api/purchase-orders/${purchaseOrderId}/confirm`,
          { method: 'POST' },
        );
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          toast.error(body.error ?? `Confirm failed (${res.status})`);
          return;
        }
        toast.success(`Confirmed ${purchaseOrderNumber}`);
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
        Confirm
      </Button>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Confirm this PO?</AlertDialogTitle>
          <AlertDialogDescription>
            Locks the lines and signals the vendor. The PO moves to{' '}
            <strong>Confirmed</strong> and becomes receivable.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm} disabled={pending}>
            {pending ? 'Confirming…' : 'Confirm'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// =============================================================================
// Receive — link-only button. The receive flow lands in 6G.
// =============================================================================

function ReceiveAction({ purchaseOrderId }: Props) {
  return (
    <Button
      size="sm"
      render={<Link href={`/purchase-orders/${purchaseOrderId}/receive`} />}
    >
      <PackagePlus />
      Receive
    </Button>
  );
}

// =============================================================================
// Cancel — required reason. Service rejects when there are active
// receipt lines linked to the PO.
// =============================================================================

function CancelMenuItem({ purchaseOrderId, purchaseOrderNumber }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
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
        const res = await fetch(
          `/api/purchase-orders/${purchaseOrderId}/cancel`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason: reason.trim() }),
          },
        );
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          toast.error(body.error ?? `Cancel failed (${res.status})`);
          return;
        }
        toast.success(`Cancelled ${purchaseOrderNumber}`);
        setOpen(false);
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
        setOpen(o);
        if (!o) {
          setReason('');
          setError(null);
        }
      }}
    >
      <DropdownMenuItem
        onClick={(e) => {
          e.preventDefault();
          setOpen(true);
        }}
        variant="destructive"
      >
        <XCircle className="size-4" />
        Cancel PO
      </DropdownMenuItem>
      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>Cancel this PO?</AlertDialogTitle>
          <AlertDialogDescription>
            Cancellation is blocked if any line has been received against —
            cancel or reverse those receipts first. A short reason is
            required for the audit trail.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <Field>
          <FieldLabel htmlFor="cancel-reason">Reason</FieldLabel>
          <Textarea
            id="cancel-reason"
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. vendor no longer carries this SKU"
            aria-invalid={!!error}
          />
          {error ? <FieldError errors={[{ message: error }]} /> : null}
        </Field>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Keep PO</AlertDialogCancel>
          <AlertDialogAction
            onClick={onCancel}
            disabled={pending}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {pending ? 'Cancelling…' : 'Cancel PO'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// =============================================================================
// Delete — soft-delete, DRAFT or CANCELLED only.
// =============================================================================

function DeleteMenuItem({ purchaseOrderId, purchaseOrderNumber }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  function onDelete() {
    startTransition(async () => {
      try {
        const res = await fetch(
          `/api/purchase-orders/${purchaseOrderId}`,
          { method: 'DELETE' },
        );
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          toast.error(body.error ?? `Delete failed (${res.status})`);
          return;
        }
        toast.success(`Deleted ${purchaseOrderNumber}`);
        setOpen(false);
        router.push('/purchase-orders');
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
        <Trash2 className="size-4" />
        Delete PO
      </DropdownMenuItem>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this PO?</AlertDialogTitle>
          <AlertDialogDescription>
            <span className="font-mono font-medium text-foreground">
              {purchaseOrderNumber}
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
