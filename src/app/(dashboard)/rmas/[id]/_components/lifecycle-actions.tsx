'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  CheckCircle2,
  CircleDollarSign,
  Package,
  PackageCheck,
  Search,
  Truck,
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
import { Field, FieldError, FieldLabel } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import {
  IssueCreditDialog,
  type CategoryOption,
  type CreditLineInput,
} from './issue-credit-dialog';

// RMA lifecycle:
//   PENDING    → APPROVED | REJECTED
//   APPROVED   → IN_TRANSIT (standard only) | RECEIVED | REJECTED
//   IN_TRANSIT → RECEIVED | REJECTED
//   RECEIVED   → INSPECTED | REJECTED
//   INSPECTED  → CREDITED (via creditFromRma) | REJECTED
//   CREDITED / REJECTED — terminal

type Props = {
  rmaId: string;
  rmaNumber: string;
  status: string;
  returnless: boolean;
  creditMemoId: string | null;
  lines: CreditLineInput[];
  categories: CategoryOption[];
};

export function LifecycleActions(props: Props) {
  const { status, returnless } = props;
  const isTerminal = status === 'CREDITED' || status === 'REJECTED';

  if (isTerminal) {
    return (
      <div className="rounded-lg border border-border bg-muted/30 p-4">
        {status === 'CREDITED' ? (
          <div className="flex items-center justify-between gap-3 text-sm">
            <span className="text-muted-foreground">
              This RMA is closed — a credit memo was issued.
            </span>
            {props.creditMemoId ? (
              <Button
                variant="outline"
                size="sm"
                render={
                  <Link href={`/credit-memos/${props.creditMemoId}`} />
                }
              >
                <CircleDollarSign />
                View credit memo
              </Button>
            ) : null}
          </div>
        ) : (
          <div className="text-sm text-muted-foreground">
            This RMA was rejected — no credit issued, no inventory effect.
          </div>
        )}
      </div>
    );
  }

  // Next-step button + a uniform Reject affordance at every non-terminal
  // status. The reject reason is required by the service.
  return (
    <div className="rounded-lg border border-border p-4">
      <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Next steps
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {status === 'PENDING' ? (
          <TransitionButton
            {...props}
            target="APPROVED"
            label="Approve"
            icon={<CheckCircle2 />}
            variant="primary"
            confirmTitle="Approve this RMA?"
            confirmBody="Moves the RMA to Approved. No GL effect yet — credit posts at the Inspected → Credited step."
          />
        ) : null}

        {status === 'APPROVED' && !returnless ? (
          <TransitionButton
            {...props}
            target="IN_TRANSIT"
            label="Mark In Transit"
            icon={<Truck />}
            variant="primary"
            confirmTitle="Mark as In Transit?"
            confirmBody="Records that the customer has shipped the goods back. Move to Received once they arrive."
          />
        ) : null}

        {status === 'APPROVED' || status === 'IN_TRANSIT' ? (
          <TransitionButton
            {...props}
            target="RECEIVED"
            label="Mark Received"
            icon={<Package />}
            variant={status === 'IN_TRANSIT' ? 'primary' : 'secondary'}
            confirmTitle="Mark goods as received?"
            confirmBody={
              returnless
                ? 'Returnless RMA — proceed directly to Received, then Inspected.'
                : 'Records arrival of the returned goods. Move to Inspected once you have verified condition and counts.'
            }
          />
        ) : null}

        {status === 'RECEIVED' ? (
          <TransitionButton
            {...props}
            target="INSPECTED"
            label="Complete Inspection"
            icon={<Search />}
            variant="primary"
            confirmTitle="Mark inspection complete?"
            confirmBody="Confirms you have verified the returned goods. The next step is Issue Credit, which creates the credit memo."
          />
        ) : null}

        {status === 'INSPECTED' ? (
          <IssueCreditAction {...props} />
        ) : null}

        <RejectAction {...props} />
      </div>
      {status === 'INSPECTED' ? (
        <p className="mt-2 text-[11px] text-muted-foreground">
          Issuing credit drafts and confirms a CreditMemo linked to the
          original invoice in one atomic step, then bumps the invoice
          line&apos;s qtyReturned counters.
        </p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Transition button — same shape across Approve / Mark In Transit / Mark
// Received / Complete Inspection. Posts to /api/rmas/[id]/transition.
// ---------------------------------------------------------------------------

function TransitionButton({
  rmaId,
  rmaNumber,
  target,
  label,
  icon,
  variant,
  confirmTitle,
  confirmBody,
}: {
  rmaId: string;
  rmaNumber: string;
  target: 'APPROVED' | 'IN_TRANSIT' | 'RECEIVED' | 'INSPECTED';
  label: string;
  icon: React.ReactNode;
  variant: 'primary' | 'secondary';
  confirmTitle: string;
  confirmBody: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  function onConfirm() {
    startTransition(async () => {
      try {
        const res = await fetch(`/api/rmas/${rmaId}/transition`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ to: target }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          toast.error(body.error ?? `Transition failed (${res.status})`);
          return;
        }
        toast.success(`${rmaNumber} → ${labelForTarget(target)}`);
        setOpen(false);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Network error');
      }
    });
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <Button
        size="sm"
        variant={variant === 'primary' ? undefined : 'outline'}
        onClick={() => setOpen(true)}
      >
        {icon}
        {label}
      </Button>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{confirmTitle}</AlertDialogTitle>
          <AlertDialogDescription>{confirmBody}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm} disabled={pending}>
            {pending ? 'Saving…' : label}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function labelForTarget(t: string): string {
  switch (t) {
    case 'APPROVED':
      return 'Approved';
    case 'IN_TRANSIT':
      return 'In Transit';
    case 'RECEIVED':
      return 'Received';
    case 'INSPECTED':
      return 'Inspected';
    default:
      return t;
  }
}

// ---------------------------------------------------------------------------
// Reject — available at every non-terminal status. Requires a reason.
// ---------------------------------------------------------------------------

function RejectAction({ rmaId, rmaNumber }: Props) {
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
        const res = await fetch(`/api/rmas/${rmaId}/transition`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ to: 'REJECTED', reason: reason.trim() }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          toast.error(body.error ?? `Reject failed (${res.status})`);
          return;
        }
        toast.success(`Rejected ${rmaNumber}`);
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
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        className="ml-auto"
      >
        <XCircle />
        Reject
      </Button>
      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>Reject this RMA?</AlertDialogTitle>
          <AlertDialogDescription>
            Terminal — no credit, no inventory effect. A reason is required
            for the audit trail.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <Field>
          <FieldLabel htmlFor="rma-reject-reason">Reason</FieldLabel>
          <Textarea
            id="rma-reject-reason"
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. RMA window expired, items show evidence of misuse"
            aria-invalid={!!error}
          />
          {error ? <FieldError errors={[{ message: error }]} /> : null}
        </Field>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Keep RMA</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            disabled={pending}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {pending ? 'Rejecting…' : 'Reject RMA'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ---------------------------------------------------------------------------
// Issue Credit — wraps the IssueCreditDialog (per-line qty + category +
// reason). The dialog calls /api/rmas/[id]/credit which atomically:
//   - drafts the CreditMemo
//   - confirms it (posts GL JE, auto-applies to the original invoice)
//   - runs reverseCogsForCreditMemoTx (inventory routing by category)
//   - bumps InvoiceLine.qtyReturned for each line
//   - links cm.id back to the RMA, stamps creditedAt, status=CREDITED
// ---------------------------------------------------------------------------

function IssueCreditAction({ rmaId, rmaNumber, lines, categories }: Props) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <PackageCheck />
        Issue Credit
      </Button>
      <IssueCreditDialog
        rmaId={rmaId}
        rmaNumber={rmaNumber}
        lines={lines}
        categories={categories}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}
