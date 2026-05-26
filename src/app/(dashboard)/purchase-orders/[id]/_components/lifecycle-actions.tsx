'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  CheckCircle2,
  MoreVertical,
  PackageCheck,
  PackagePlus,
  Pencil,
  RotateCcw,
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
  purchaseOrderId: string;
  purchaseOrderNumber: string;
  status: string;
};

// Mirrors the SO lifecycle component but with PO state machine:
//   DRAFT → CONFIRMED (manual)
//   CONFIRMED ↔ PARTIALLY_RECEIVED (auto, driven by receipts)
//   PARTIALLY_RECEIVED → CLOSED (auto when every line is fully received)
//   CONFIRMED / PARTIALLY_RECEIVED → CLOSED (manual close-with-reason
//     when no further receipts are expected — short shipment, vendor
//     cancellation, damaged goods)
//   any non-CLOSED → CANCELLED (manual, blocked if active receipt lines)
//   DRAFT or CANCELLED → soft-deleted
//
// Receive button is rendered for CONFIRMED / PARTIALLY_RECEIVED and
// links to /purchase-orders/[id]/receive (the receive flow lands in
// 6G; until then the link 404s, same staged pattern as 6A → 6B).
export function LifecycleActions(props: Props) {
  const { status } = props;

  const canConfirm = status === 'DRAFT';
  // Edit reachable on DRAFT (full edit) + CONFIRMED (full edit, no
  // receipts can exist yet) + PARTIALLY_RECEIVED (header fields only;
  // the form locks the lines section read-only — see po-form's
  // linesLocked branch).
  const canEdit =
    status === 'DRAFT' ||
    status === 'CONFIRMED' ||
    status === 'PARTIALLY_RECEIVED';
  const canReceive =
    status === 'CONFIRMED' || status === 'PARTIALLY_RECEIVED';
  // Manual close: same status window as receive. After close, ordered
  // qtys stay unchanged for reporting (we don't trim line.qtyOrdered
  // down to qtyReceived — the gap is the story the report tells).
  const canClose =
    status === 'CONFIRMED' || status === 'PARTIALLY_RECEIVED';
  // Reverse of close: only meaningful when already CLOSED. Service
  // picks the target state (PARTIALLY_RECEIVED if anything received,
  // else CONFIRMED) from live line state.
  const canReopen = status === 'CLOSED';
  // Service rejects cancel on CLOSED + CANCELLED. DRAFT cancel is also
  // allowed (use Delete instead is more natural, but cancel works too).
  const canCancel =
    status === 'DRAFT' ||
    status === 'CONFIRMED' ||
    status === 'PARTIALLY_RECEIVED';
  const canDelete = status === 'DRAFT' || status === 'CANCELLED';

  // The Cancel/Delete confirm dialogs are controlled here and rendered as
  // siblings OUTSIDE the dropdown. A dialog nested inside
  // DropdownMenuContent gets unmounted the instant the menu closes on
  // item-press — Base UI emits the item's close unconditionally and
  // ignores preventDefault — so the dialog only flashes. See
  // admin/payment-terms/.../term-row-actions.tsx for the canonical shape.
  // (Confirm/Close/Reopen are primary buttons with their own dialog, not
  // dropdown items, so they're unaffected.)
  const [cancelOpen, setCancelOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  return (
    <div className="flex items-center gap-2">
      {canConfirm ? <ConfirmAction {...props} /> : null}
      {canReceive ? <ReceiveAction {...props} /> : null}
      {canClose ? <CloseAction {...props} /> : null}
      {canReopen ? <ReopenAction {...props} /> : null}
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
            {canCancel ? (
              <DropdownMenuItem
                onClick={() => setCancelOpen(true)}
                variant="destructive"
              >
                <XCircle className="size-4" />
                Cancel PO
              </DropdownMenuItem>
            ) : null}
            {canDelete ? (
              <DropdownMenuItem
                onClick={() => setDeleteOpen(true)}
                variant="destructive"
              >
                <Trash2 className="size-4" />
                Delete PO
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}

      {canCancel ? (
        <CancelDialog
          purchaseOrderId={props.purchaseOrderId}
          purchaseOrderNumber={props.purchaseOrderNumber}
          open={cancelOpen}
          onOpenChange={setCancelOpen}
        />
      ) : null}
      {canDelete ? (
        <DeleteDialog
          purchaseOrderId={props.purchaseOrderId}
          purchaseOrderNumber={props.purchaseOrderNumber}
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
        />
      ) : null}
    </div>
  );
}

type DialogProps = {
  purchaseOrderId: string;
  purchaseOrderNumber: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

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
// Close — manual close-with-reason. Reason field is required; service
// rejects empty strings. Status gate: CONFIRMED or PARTIALLY_RECEIVED.
// Mirrors the SO Close button pattern (regular Button + AlertDialog,
// not a dropdown menu item — it's a primary lifecycle action).
// =============================================================================

function CloseAction({ purchaseOrderId, purchaseOrderNumber }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  function onClose() {
    setError(null);
    if (reason.trim().length === 0) {
      setError('Reason is required');
      return;
    }
    startTransition(async () => {
      try {
        const res = await fetch(
          `/api/purchase-orders/${purchaseOrderId}/close`,
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
          toast.error(body.error ?? `Close failed (${res.status})`);
          return;
        }
        toast.success(`Closed ${purchaseOrderNumber}`);
        setOpen(false);
        setReason('');
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
      <Button size="sm" onClick={() => setOpen(true)}>
        <PackageCheck />
        Close
      </Button>
      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>Close this PO?</AlertDialogTitle>
          <AlertDialogDescription>
            No further receipts will be expected. Unreceived quantities will
            not be added to inventory. Ordered qtys stay on the lines for
            reporting — the gap between ordered and received is what tells
            the short-shipment story.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <Field>
          <FieldLabel htmlFor="close-reason">Reason</FieldLabel>
          <Textarea
            id="close-reason"
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. vendor short-shipped; remaining qty discontinued"
            aria-invalid={!!error}
          />
          {error ? <FieldError errors={[{ message: error }]} /> : null}
        </Field>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Keep open</AlertDialogCancel>
          <AlertDialogAction onClick={onClose} disabled={pending}>
            {pending ? 'Closing…' : 'Close PO'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// =============================================================================
// Reopen — manual reopen-with-reason. Reason field is required;
// service rejects empty strings. Status gate: CLOSED only. Service
// picks the target state (PARTIALLY_RECEIVED if any qty received,
// else CONFIRMED) — the UI doesn't expose a status picker because
// the inversion is deterministic from the existing receipt state.
// =============================================================================

function ReopenAction({ purchaseOrderId, purchaseOrderNumber }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  function onReopen() {
    setError(null);
    if (reason.trim().length === 0) {
      setError('Reason is required');
      return;
    }
    startTransition(async () => {
      try {
        const res = await fetch(
          `/api/purchase-orders/${purchaseOrderId}/reopen`,
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
          toast.error(body.error ?? `Reopen failed (${res.status})`);
          return;
        }
        toast.success(`Reopened ${purchaseOrderNumber}`);
        setOpen(false);
        setReason('');
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
      <Button size="sm" onClick={() => setOpen(true)}>
        <RotateCcw />
        Reopen
      </Button>
      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>Reopen this PO?</AlertDialogTitle>
          <AlertDialogDescription>
            It will return to its previous state and can receive further
            shipments. The close reason will be cleared.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <Field>
          <FieldLabel htmlFor="reopen-reason">Reason</FieldLabel>
          <Textarea
            id="reopen-reason"
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. vendor sending remaining units"
            aria-invalid={!!error}
          />
          {error ? <FieldError errors={[{ message: error }]} /> : null}
        </Field>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onReopen} disabled={pending}>
            {pending ? 'Reopening…' : 'Reopen PO'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// =============================================================================
// Cancel — required reason. Service rejects when there are active
// receipt lines linked to the PO. Dialog is rendered as a dropdown
// sibling, opened via the lifted `open` prop.
// =============================================================================

function CancelDialog({
  purchaseOrderId,
  purchaseOrderNumber,
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
// Delete — soft-delete, DRAFT or CANCELLED only. Dialog rendered as a
// dropdown sibling.
// =============================================================================

function DeleteDialog({
  purchaseOrderId,
  purchaseOrderNumber,
  open,
  onOpenChange,
}: DialogProps) {
  const router = useRouter();
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
