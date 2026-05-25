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
  vendorCreditId: string;
  vendorCreditNumber: string;
  status: string;
  // True when appliedAmount > 0. Service rejects cancel on CONFIRMED
  // VC with any application; we mirror that as a disabled menu item
  // with a hover hint (same pattern as bills lifecycle actions).
  hasApplications: boolean;
};

// VendorCredit lifecycle:
//   DRAFT → CONFIRMED (manual; posts DR AP / CR Vendor Credits Available)
//   DRAFT → CANCELLED (manual w/ reason; status flip only, no GL)
//   CONFIRMED → CANCELLED (manual w/ reason; rejected when appliedAmount > 0
//                          — operator must reverse applications first)
//   DRAFT → soft-deleted

export function LifecycleActions(props: Props) {
  const { status } = props;
  const canConfirm = status === 'DRAFT';
  const canEdit = status === 'DRAFT';
  const canCancel = status === 'DRAFT' || status === 'CONFIRMED';
  const canDelete = status === 'DRAFT';

  // Disable cancel when the service would reject it: CONFIRMED + an
  // application needs reversal first. DRAFT cancels are always allowed.
  const cancelDisabledReason =
    status === 'CONFIRMED' && props.hasApplications
      ? 'Reverse applications first'
      : null;

  // Cancel/Delete confirm dialogs are controlled here and rendered as
  // siblings OUTSIDE the dropdown — a dialog nested inside
  // DropdownMenuContent unmounts (only flashes) when the menu closes on
  // item-press, since Base UI ignores preventDefault for the item close.
  // See admin/payment-terms/.../term-row-actions.tsx for the canonical shape.
  const [cancelOpen, setCancelOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  return (
    <div className="flex items-center gap-2">
      {canConfirm ? <ConfirmAction {...props} /> : null}
      {canEdit ? (
        <Button
          variant="outline"
          size="sm"
          render={
            <Link href={`/vendor-credits/${props.vendorCreditId}/edit`} />
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
                disabled={!!cancelDisabledReason}
                title={cancelDisabledReason ?? undefined}
                onClick={() => setCancelOpen(true)}
                variant="destructive"
              >
                <XCircle className="size-4" />
                Cancel credit
              </DropdownMenuItem>
            ) : null}
            {canDelete ? (
              <DropdownMenuItem
                onClick={() => setDeleteOpen(true)}
                variant="destructive"
              >
                <Trash2 className="size-4" />
                Delete credit
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}

      {canCancel ? (
        <CancelDialog
          vendorCreditId={props.vendorCreditId}
          vendorCreditNumber={props.vendorCreditNumber}
          status={status}
          open={cancelOpen}
          onOpenChange={setCancelOpen}
        />
      ) : null}
      {canDelete ? (
        <DeleteDialog
          vendorCreditId={props.vendorCreditId}
          vendorCreditNumber={props.vendorCreditNumber}
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
        />
      ) : null}
    </div>
  );
}

type DialogProps = {
  vendorCreditId: string;
  vendorCreditNumber: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

function ConfirmAction({ vendorCreditId, vendorCreditNumber }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  function onConfirm() {
    startTransition(async () => {
      try {
        const res = await fetch(
          `/api/vendor-credits/${vendorCreditId}/confirm`,
          { method: 'POST' },
        );
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          toast.error(body.error ?? `Confirm failed (${res.status})`);
          return;
        }
        toast.success(`Confirmed ${vendorCreditNumber}`);
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
          <AlertDialogTitle>Confirm this vendor credit?</AlertDialogTitle>
          <AlertDialogDescription>
            Posts the GL leg (DR 2010 AP / CR 2030 Vendor Credits
            Available) and unlocks the credit for application to
            confirmed bills.
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

function CancelDialog({
  vendorCreditId,
  vendorCreditNumber,
  status,
  open,
  onOpenChange,
}: DialogProps & { status: string }) {
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
          `/api/vendor-credits/${vendorCreditId}/cancel`,
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
        toast.success(`Cancelled ${vendorCreditNumber}`);
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
          <AlertDialogTitle>Cancel this vendor credit?</AlertDialogTitle>
          <AlertDialogDescription>
            {status === 'CONFIRMED'
              ? 'Posts an offsetting JE to reverse the AP/VCA pair. Rejected if any portion has been applied — reverse those first.'
              : 'Flips the status; no GL effect (the credit never posted).'}
            {' '}A short reason is required for the audit trail.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <Field>
          <FieldLabel htmlFor="vc-cancel-reason">Reason</FieldLabel>
          <Textarea
            id="vc-cancel-reason"
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. issued in error"
            aria-invalid={!!error}
          />
          {error ? <FieldError errors={[{ message: error }]} /> : null}
        </Field>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Keep credit</AlertDialogCancel>
          <AlertDialogAction
            onClick={onCancel}
            disabled={pending}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {pending ? 'Cancelling…' : 'Cancel credit'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function DeleteDialog({
  vendorCreditId,
  vendorCreditNumber,
  open,
  onOpenChange,
}: DialogProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function onDelete() {
    startTransition(async () => {
      try {
        const res = await fetch(`/api/vendor-credits/${vendorCreditId}`, {
          method: 'DELETE',
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          toast.error(body.error ?? `Delete failed (${res.status})`);
          return;
        }
        toast.success(`Deleted ${vendorCreditNumber}`);
        onOpenChange(false);
        router.push('/vendor-credits');
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
          <AlertDialogTitle>Delete this vendor credit?</AlertDialogTitle>
          <AlertDialogDescription>
            <span className="font-mono font-medium text-foreground">
              {vendorCreditNumber}
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
