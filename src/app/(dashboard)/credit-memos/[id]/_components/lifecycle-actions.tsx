'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  CheckCircle2,
  MoreVertical,
  Pencil,
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
  creditMemoId: string;
  creditMemoNumber: string;
  status: string;
  // True when appliedAmount > 0 OR any non-reversed CreditApplication
  // exists. Service rejects void on CONFIRMED CM with manual
  // applications; auto-app on confirm is reversed automatically, so
  // this flag is informational guidance for the user.
  hasApplications: boolean;
  // RMA-sourced CMs share their state with the parent RMA; voiding
  // them out-of-band desyncs the RMA. Block from the UI; users should
  // void via the RMA flow when implemented.
  isFromRma: boolean;
};

// CreditMemo lifecycle:
//   DRAFT     → CONFIRMED (manual; posts DR Sales Returns / CR AR,
//                          restocking-fee chargeback when set, auto-
//                          applies to linked invoice)
//   DRAFT     → VOIDED    (manual w/ reason; status flip only, no GL)
//   CONFIRMED → VOIDED    (manual w/ reason; offsetting JE, auto-
//                          reverses the auto-apply, refuses on manual
//                          applications)

export function LifecycleActions(props: Props) {
  const { status } = props;
  const canConfirm = status === 'DRAFT';
  const canEdit = status === 'DRAFT';
  const canVoid = status === 'DRAFT' || status === 'CONFIRMED';

  // RMA-sourced CMs can't be voided here — void via the RMA flow.
  const voidDisabledReason = props.isFromRma
    ? 'CM was created from an RMA — void via the RMA flow'
    : null;

  // Void confirm dialog is controlled here and rendered as a sibling
  // OUTSIDE the dropdown — a dialog nested inside DropdownMenuContent
  // unmounts (only flashes) when the menu closes on item-press, since
  // Base UI ignores preventDefault for the item close. See
  // admin/payment-terms/.../term-row-actions.tsx for the canonical shape.
  const [voidOpen, setVoidOpen] = useState(false);

  return (
    <div className="flex items-center gap-2">
      {canConfirm ? <ConfirmAction {...props} /> : null}
      {canEdit && !props.isFromRma ? (
        <Button
          variant="outline"
          size="sm"
          render={
            <Link href={`/credit-memos/${props.creditMemoId}/edit`} />
          }
        >
          <Pencil />
          Edit
        </Button>
      ) : null}
      {canVoid ? (
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
            <DropdownMenuItem
              disabled={!!voidDisabledReason}
              title={voidDisabledReason ?? undefined}
              onClick={() => setVoidOpen(true)}
              variant="destructive"
            >
              <XCircle className="size-4" />
              Void credit memo
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}

      {canVoid ? (
        <VoidDialog {...props} open={voidOpen} onOpenChange={setVoidOpen} />
      ) : null}
    </div>
  );
}

function ConfirmAction({ creditMemoId, creditMemoNumber }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  function onConfirm() {
    startTransition(async () => {
      try {
        const res = await fetch(
          `/api/credit-memos/${creditMemoId}/confirm`,
          { method: 'POST' },
        );
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          toast.error(body.error ?? `Confirm failed (${res.status})`);
          return;
        }
        toast.success(`Confirmed ${creditMemoNumber}`);
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
          <AlertDialogTitle>Confirm this credit memo?</AlertDialogTitle>
          <AlertDialogDescription>
            Posts the GL legs (DR 4500 Sales Returns / CR 1210 AR; plus
            the restocking-fee chargeback when set). If a linked invoice
            is present, the net credit auto-applies to it.
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
// Void — required reason. Service offsetting-JE on CONFIRMED, status flip
// on DRAFT; rejects when manual applications exist. Dialog rendered as a
// dropdown sibling.
// =============================================================================

function VoidDialog({
  creditMemoId,
  creditMemoNumber,
  status,
  hasApplications,
  open,
  onOpenChange,
}: Props & { open: boolean; onOpenChange: (open: boolean) => void }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  function onVoid() {
    setError(null);
    if (reason.trim().length === 0) {
      setError('Reason is required');
      return;
    }
    startTransition(async () => {
      try {
        const res = await fetch(`/api/credit-memos/${creditMemoId}/void`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason: reason.trim() }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          toast.error(body.error ?? `Void failed (${res.status})`);
          return;
        }
        toast.success(`Voided ${creditMemoNumber}`);
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
          <AlertDialogTitle>Void this credit memo?</AlertDialogTitle>
          <AlertDialogDescription>
            {status === 'CONFIRMED' ? (
              <>
                Posts an offsetting JE to reverse the Sales Returns / AR
                legs (and the restocking-fee pair when present). The
                auto-application to the linked invoice is reversed
                automatically; manual applications must be reversed
                first or the void will be rejected.
              </>
            ) : (
              'Flips the status; no GL effect (the credit never posted).'
            )}{' '}
            A short reason is required for the audit trail.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <Field>
          <FieldLabel htmlFor="cm-void-reason">Reason</FieldLabel>
          <Textarea
            id="cm-void-reason"
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. issued in error, duplicate of CM-2026-0042"
            aria-invalid={!!error}
          />
          {error ? <FieldError errors={[{ message: error }]} /> : null}
        </Field>
        {hasApplications && status === 'CONFIRMED' ? (
          <p className="text-xs text-muted-foreground">
            This credit has been applied. Auto-application from confirm
            unwinds automatically; if any manual applications exist,
            reverse them first.
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Keep credit</AlertDialogCancel>
          <AlertDialogAction
            onClick={onVoid}
            disabled={pending}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {pending ? 'Voiding…' : 'Void credit'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
