'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  Lock,
  LockKeyhole,
  MoreVertical,
  Unlock,
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

export function PeriodRowActions({
  periodId,
  periodCode,
  status,
}: {
  periodId: string;
  periodCode: string;
  status: string;
}) {
  const canSoftClose = status === 'OPEN';
  const canHardClose = status === 'OPEN' || status === 'SOFT_CLOSED';
  const canReopen = status === 'SOFT_CLOSED' || status === 'HARD_CLOSED';

  return (
    <div className="flex items-center gap-2">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Actions for ${periodCode}`}
            />
          }
        >
          <MoreVertical />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {canSoftClose ? (
            <SoftCloseItem periodId={periodId} periodCode={periodCode} />
          ) : null}
          {canHardClose ? (
            <HardCloseItem periodId={periodId} periodCode={periodCode} />
          ) : null}
          {canReopen ? (
            <ReopenItem periodId={periodId} periodCode={periodCode} />
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

// =============================================================================
// Soft close — OPEN → SOFT_CLOSED. No JE block; informational only.
// =============================================================================

function SoftCloseItem({
  periodId,
  periodCode,
}: {
  periodId: string;
  periodCode: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  function onConfirm() {
    startTransition(async () => {
      try {
        const res = await fetch(
          `/api/admin/periods/${periodId}/soft-close`,
          { method: 'POST' },
        );
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          toast.error(body.error ?? `Soft close failed (${res.status})`);
          return;
        }
        toast.success(`Soft-closed ${periodCode}`);
        setOpen(false);
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
      >
        <Lock className="size-4" />
        Soft close
      </DropdownMenuItem>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Soft-close {periodCode}?</AlertDialogTitle>
          <AlertDialogDescription>
            Marks the month as closed for normal users. JEs can still
            post — the permissions slice will gate that later. This is
            reversible via Reopen.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm} disabled={pending}>
            {pending ? 'Closing…' : 'Soft close'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// =============================================================================
// Hard close — OPEN | SOFT_CLOSED → HARD_CLOSED. Posts after this date
// require explicit override with reason. Service runs reconciliation
// checks; we surface the rejection verbatim if any fail. Force-close
// (with reason) overrides discrepancies — separate dialog state.
// =============================================================================

function HardCloseItem({
  periodId,
  periodCode,
}: {
  periodId: string;
  periodCode: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  // Two-step flow: bare hard-close attempt first; on rejection the
  // operator can supply a force-with-reason. The pending discrepancy
  // detail comes back verbatim from the service.
  const [forceMode, setForceMode] = useState(false);
  const [discrepancyMsg, setDiscrepancyMsg] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setForceMode(false);
    setDiscrepancyMsg(null);
    setReason('');
    setError(null);
  }

  function onConfirm() {
    setError(null);
    if (forceMode && reason.trim().length === 0) {
      setError('Reason is required when overriding discrepancies');
      return;
    }
    startTransition(async () => {
      try {
        const body = forceMode
          ? { forceCloseWithDiscrepancies: { reason: reason.trim() } }
          : undefined;
        const res = await fetch(
          `/api/admin/periods/${periodId}/hard-close`,
          {
            method: 'POST',
            ...(body
              ? {
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(body),
                }
              : {}),
          },
        );
        if (!res.ok) {
          const errBody = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          const msg = errBody.error ?? `Hard close failed (${res.status})`;
          // Treat any non-auth rejection as a reconciliation failure
          // and offer the force path. The bare hard-close response has
          // no structured code today; the service message is the only
          // signal we have.
          if (!forceMode && /reconciliation|discrepan|recon /i.test(msg)) {
            setDiscrepancyMsg(msg);
            setForceMode(true);
            return;
          }
          toast.error(msg);
          return;
        }
        toast.success(`Hard-closed ${periodCode}`);
        setOpen(false);
        reset();
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
        if (!o) reset();
      }}
    >
      <DropdownMenuItem
        onClick={(e) => {
          e.preventDefault();
          setOpen(true);
        }}
        variant="destructive"
      >
        <LockKeyhole className="size-4" />
        Hard close
      </DropdownMenuItem>
      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {forceMode ? `Override and hard-close ${periodCode}?` : `Hard-close ${periodCode}?`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {forceMode
              ? 'Reconciliation flagged discrepancies. Providing a reason posts the close anyway and writes a MANUAL_JE_POSTED audit row tied to the period for future post overrides.'
              : 'Locks the period — posts after this date require explicit override with reason. Service runs reconciliation checks (cash, AR, AP, inventory, retained earnings) first.'}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {discrepancyMsg ? (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-muted-foreground">
            <div className="mb-1 font-medium text-foreground">
              Reconciliation rejected
            </div>
            <p className="whitespace-pre-line">{discrepancyMsg}</p>
          </div>
        ) : null}

        {forceMode ? (
          <Field>
            <FieldLabel htmlFor="hc-reason">Override reason</FieldLabel>
            <Textarea
              id="hc-reason"
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. inventory variance to be corrected next period — see ticket #..."
              aria-invalid={!!error}
            />
            {error ? <FieldError errors={[{ message: error }]} /> : null}
          </Field>
        ) : null}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            disabled={pending}
            className={
              forceMode
                ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
                : undefined
            }
          >
            {pending
              ? 'Closing…'
              : forceMode
                ? 'Override and close'
                : 'Hard close'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// =============================================================================
// Reopen — SOFT_CLOSED | HARD_CLOSED → OPEN with reason. Sensitive
// action: writes a PERIOD_REOPENED audit row.
// =============================================================================

function ReopenItem({
  periodId,
  periodCode,
}: {
  periodId: string;
  periodCode: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  function onConfirm() {
    setError(null);
    if (reason.trim().length === 0) {
      setError('Reason is required');
      return;
    }
    startTransition(async () => {
      try {
        const res = await fetch(
          `/api/admin/periods/${periodId}/reopen`,
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
        toast.success(`Reopened ${periodCode}`);
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
      >
        <Unlock className="size-4" />
        Reopen
      </DropdownMenuItem>
      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>Reopen {periodCode}?</AlertDialogTitle>
          <AlertDialogDescription>
            Flips the period back to OPEN. Sensitive — writes a
            PERIOD_REOPENED audit row with the supplied reason.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <Field>
          <FieldLabel htmlFor="reopen-reason">Reason</FieldLabel>
          <Textarea
            id="reopen-reason"
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. late vendor bill posting against this period"
            aria-invalid={!!error}
          />
          {error ? <FieldError errors={[{ message: error }]} /> : null}
        </Field>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm} disabled={pending}>
            {pending ? 'Reopening…' : 'Reopen'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
