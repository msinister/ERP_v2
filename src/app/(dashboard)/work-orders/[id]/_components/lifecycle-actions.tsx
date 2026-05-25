'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { PackageCheck, Play, XCircle } from 'lucide-react';
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
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  isPositiveDecimalInput,
  normalizeDecimalForSubmit,
} from '@/lib/decimal-input';

type Props = {
  workOrderId: string;
  number: string;
  status: string;
  qtyToBuild: string;
  qtyCompleted: string;
  remaining: string;
  anyShortage: boolean;
};

// Lifecycle actions strip on the WO detail page.
//   DRAFT       → Start Build + Cancel
//   IN_PROGRESS → Complete Build (full or partial) + Cancel
//   COMPLETED   → (nothing — terminal)
//   CANCELLED   → (nothing — terminal)
//
// Complete + Cancel both open dialogs; Start fires immediately.
export function WorkOrderLifecycleActions(props: Props) {
  const { status } = props;
  const canStart = status === 'DRAFT';
  const canComplete = status === 'IN_PROGRESS';
  const canCancel = status === 'DRAFT' || status === 'IN_PROGRESS';

  if (!canStart && !canComplete && !canCancel) return null;

  return (
    <div className="flex items-center gap-2">
      {canStart ? <StartAction {...props} /> : null}
      {canComplete ? <CompleteAction {...props} /> : null}
      {canCancel ? <CancelAction {...props} /> : null}
    </div>
  );
}

function StartAction({ workOrderId, number }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  function onClick() {
    startTransition(async () => {
      try {
        const res = await fetch(`/api/work-orders/${workOrderId}/start`, {
          method: 'POST',
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          toast.error(body.error ?? `Start failed (${res.status})`);
          return;
        }
        toast.success(`Started ${number}`);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Network error');
      }
    });
  }
  return (
    <Button size="sm" onClick={onClick} disabled={pending}>
      <Play />
      {pending ? 'Starting…' : 'Start build'}
    </Button>
  );
}

function CompleteAction({
  workOrderId,
  number,
  qtyToBuild,
  qtyCompleted,
  remaining,
  anyShortage,
}: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [qty, setQty] = useState(remaining);
  const [error, setError] = useState<string | null>(null);

  function onComplete() {
    setError(null);
    const trimmed = qty.trim();
    if (!isPositiveDecimalInput(trimmed)) {
      setError('Must be > 0');
      return;
    }
    if (Number(trimmed) > Number(remaining)) {
      setError(`Must be <= remaining (${remaining})`);
      return;
    }
    startTransition(async () => {
      try {
        const res = await fetch(`/api/work-orders/${workOrderId}/complete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            qtyToComplete: normalizeDecimalForSubmit(trimmed),
          }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          toast.error(body.error ?? `Complete failed (${res.status})`);
          return;
        }
        const body = (await res.json().catch(() => ({}))) as {
          warnings?: Array<{ componentVariantId: string; shortage: string }>;
        };
        toast.success(
          `Built ${trimmed} of ${number} (${qtyCompleted} → ${
            Number(qtyCompleted) + Number(trimmed)
          } of ${qtyToBuild})`,
        );
        // Negative-allocation warning — fired when the global setting
        // allowed the build to proceed against insufficient stock. The
        // operator should know so they can reconcile costs later.
        if (body.warnings && body.warnings.length > 0) {
          const total = body.warnings.length;
          toast.warning(
            `Built with negative inventory on ${total} component${
              total === 1 ? '' : 's'
            } — see Inventory > Movements for the negative-allocation rows`,
          );
        }
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
          setQty(remaining);
          setError(null);
        }
      }}
    >
      <Button size="sm" onClick={() => setOpen(true)}>
        <PackageCheck />
        Complete build
      </Button>
      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>Complete this build?</AlertDialogTitle>
          <AlertDialogDescription>
            Components will be deducted at FIFO cost; the finished good lands
            in inventory at the rolled-up cost (components + labor). A
            balanced journal entry posts automatically.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <Field>
          <FieldLabel htmlFor="complete-qty">Qty to complete now</FieldLabel>
          <Input
            id="complete-qty"
            inputMode="decimal"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            aria-invalid={!!error}
            className="max-w-[12rem]"
          />
          {error ? <FieldError errors={[{ message: error }]} /> : null}
          <p className="text-xs text-muted-foreground">
            Remaining: {remaining} of {qtyToBuild}.{' '}
            {anyShortage
              ? 'One or more components are short — reduce qty or receive more stock first.'
              : 'All components are in stock for the remaining qty.'}
          </p>
        </Field>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onComplete} disabled={pending}>
            {pending ? 'Completing…' : 'Complete build'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function CancelAction({ workOrderId, number }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  function onCancel() {
    setError(null);
    if (reason.trim() === '') {
      setError('Reason is required');
      return;
    }
    startTransition(async () => {
      try {
        const res = await fetch(`/api/work-orders/${workOrderId}/cancel`, {
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
        toast.success(`Cancelled ${number}`);
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
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <XCircle />
        Cancel WO
      </Button>
      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>Cancel this work order?</AlertDialogTitle>
          <AlertDialogDescription>
            Any units already completed stay in inventory. Remaining
            qty is abandoned.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <Field>
          <FieldLabel htmlFor="cancel-reason">Reason</FieldLabel>
          <Textarea
            id="cancel-reason"
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. customer cancelled order"
            aria-invalid={!!error}
          />
          {error ? <FieldError errors={[{ message: error }]} /> : null}
        </Field>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Keep open</AlertDialogCancel>
          <AlertDialogAction onClick={onCancel} disabled={pending}>
            {pending ? 'Cancelling…' : 'Cancel work order'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
