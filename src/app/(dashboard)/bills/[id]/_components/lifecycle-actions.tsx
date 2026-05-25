'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  CheckCircle2,
  MoreVertical,
  Pencil,
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
  billId: string;
  billNumber: string;
  status: string;
  // True when amountPaid > 0 OR amountCredited > 0. The service rejects
  // cancelBill on a CONFIRMED bill with any applied money — we disable
  // the action up front so the operator isn't surprised, matching Q2
  // from discovery.
  hasAppliedMoney: boolean;
};

// Bill lifecycle:
//   DRAFT → CONFIRMED (manual; posts AP JE, sets dueDate from vendor
//                       payment term)
//   CONFIRMED → CANCELLED (manual w/ reason; posts mirror JE; rejected
//                           when amountPaid + amountCredited > 0)
//   DRAFT → soft-deleted (DRAFT only)
//
// Edit is DRAFT-only and lives on the /edit page.

export function LifecycleActions(props: Props) {
  const { status } = props;

  const canConfirm = status === 'DRAFT';
  const canEdit = status === 'DRAFT';
  const canCancel = status === 'CONFIRMED';
  const canDelete = status === 'DRAFT';

  // The Cancel/Delete confirm dialogs are controlled here and rendered as
  // siblings OUTSIDE the dropdown. A dialog nested inside
  // DropdownMenuContent gets unmounted the instant the menu closes on
  // item-press — Base UI emits the item's close unconditionally and
  // ignores preventDefault — so the dialog only flashes. See
  // admin/payment-terms/.../term-row-actions.tsx for the canonical shape.
  const [cancelOpen, setCancelOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  return (
    <div className="flex items-center gap-2">
      {canConfirm ? <ConfirmAction {...props} /> : null}
      {canEdit ? (
        <Button
          variant="outline"
          size="sm"
          render={<Link href={`/bills/${props.billId}/edit`} />}
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
                disabled={props.hasAppliedMoney}
                title={
                  props.hasAppliedMoney
                    ? 'Reverse payments / applied credits first'
                    : undefined
                }
                onClick={() => setCancelOpen(true)}
                variant="destructive"
              >
                <XCircle className="size-4" />
                Cancel bill
              </DropdownMenuItem>
            ) : null}
            {canDelete ? (
              <DropdownMenuItem
                onClick={() => setDeleteOpen(true)}
                variant="destructive"
              >
                <Trash2 className="size-4" />
                Delete bill
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}

      {canCancel ? (
        <CancelDialog
          billId={props.billId}
          billNumber={props.billNumber}
          open={cancelOpen}
          onOpenChange={setCancelOpen}
        />
      ) : null}
      {canDelete ? (
        <DeleteDialog
          billId={props.billId}
          billNumber={props.billNumber}
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
        />
      ) : null}
    </div>
  );
}

type DialogProps = {
  billId: string;
  billNumber: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

// =============================================================================
// Confirm — DRAFT → CONFIRMED. Service posts AP JE + sets due date.
// =============================================================================

function ConfirmAction({ billId, billNumber }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  function onConfirm() {
    startTransition(async () => {
      try {
        const res = await fetch(`/api/bills/${billId}/confirm`, {
          method: 'POST',
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          toast.error(body.error ?? `Confirm failed (${res.status})`);
          return;
        }
        toast.success(`Confirmed ${billNumber}`);
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
          <AlertDialogTitle>Confirm this bill?</AlertDialogTitle>
          <AlertDialogDescription>
            Posts the AP JE (DR Accrued Receipts / Expense, CR AP) and
            sets the due date from the vendor&apos;s payment term. Lines
            and totals become immutable.
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
// Cancel — CONFIRMED → CANCELLED with reason. Service rejects when
// amountPaid > 0 or amountCredited > 0 — the menu item is disabled in
// that case (see LifecycleActions). Dialog is rendered as a dropdown
// sibling, opened via the lifted `open` prop.
// =============================================================================

function CancelDialog({ billId, billNumber, open, onOpenChange }: DialogProps) {
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
        const res = await fetch(`/api/bills/${billId}/cancel`, {
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
        toast.success(`Cancelled ${billNumber}`);
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
          <AlertDialogTitle>Cancel this bill?</AlertDialogTitle>
          <AlertDialogDescription>
            Posts an offsetting JE to reverse the AP entry. A short
            reason is required for the audit trail. Cancellation is
            blocked if any payment or credit has been applied — reverse
            those first.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <Field>
          <FieldLabel htmlFor="bill-cancel-reason">Reason</FieldLabel>
          <Textarea
            id="bill-cancel-reason"
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. duplicate of bill BILL-2026-00045"
            aria-invalid={!!error}
          />
          {error ? <FieldError errors={[{ message: error }]} /> : null}
        </Field>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Keep bill</AlertDialogCancel>
          <AlertDialogAction
            onClick={onCancel}
            disabled={pending}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {pending ? 'Cancelling…' : 'Cancel bill'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// =============================================================================
// Delete — soft-delete, DRAFT only. Dialog rendered as a dropdown sibling.
// =============================================================================

function DeleteDialog({ billId, billNumber, open, onOpenChange }: DialogProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function onDelete() {
    startTransition(async () => {
      try {
        const res = await fetch(`/api/bills/${billId}`, {
          method: 'DELETE',
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          toast.error(body.error ?? `Delete failed (${res.status})`);
          return;
        }
        toast.success(`Deleted ${billNumber}`);
        onOpenChange(false);
        router.push('/bills');
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
          <AlertDialogTitle>Delete this bill?</AlertDialogTitle>
          <AlertDialogDescription>
            <span className="font-mono font-medium text-foreground">
              {billNumber}
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
