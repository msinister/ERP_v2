'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  CheckCircle2,
  MoreVertical,
  Pencil,
  PackageCheck,
  Send,
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
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { formatCurrency } from '@/lib/format';

type Props = {
  salesOrderId: string;
  salesOrderNumber: string;
  status: string;
  shippingAmount: string | null;
  handlingAmount: string | null;
};

// Status → which dialogs are reachable. Edit + Delete are gated by
// the same backend rules (Edit only DRAFT; soft-delete only DRAFT or
// CANCELLED) — we mirror them in the UI so disallowed actions don't
// even appear.
export function LifecycleActions(props: Props) {
  const { status } = props;

  const canConfirm = status === 'DRAFT';
  const canEdit = status === 'DRAFT';
  const canDispatch = status === 'CONFIRMED';
  // closeSalesOrder accepts CONFIRMED or DISPATCHED (pickup orders
  // skip dispatched per docs/05-sales-orders.md).
  const canClose = status === 'CONFIRMED' || status === 'DISPATCHED';
  const canCancel =
    status === 'DRAFT' || status === 'CONFIRMED' || status === 'DISPATCHED';
  const canDelete = status === 'DRAFT' || status === 'CANCELLED';

  return (
    <div className="flex items-center gap-2">
      {canConfirm ? <ConfirmAction {...props} /> : null}
      {canDispatch ? <DispatchAction {...props} /> : null}
      {canClose ? <CloseAction {...props} /> : null}
      {canEdit ? (
        <Button
          variant="outline"
          size="sm"
          render={<Link href={`/sales-orders/${props.salesOrderId}/edit`} />}
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
// Confirm — opens a dialog. On 409 with a typed code (CREDIT_LIMIT_EXCEEDED /
// AR_HOLD_EXCEEDED) renders an inline breakdown inside the dialog instead
// of dismissing.
// =============================================================================

type CreditErrorBody = {
  code: 'CREDIT_LIMIT_EXCEEDED';
  error: string;
  creditLimit: string;
  arBalance: string;
  openSosTotal: string;
  thisOrderTotal: string;
  projectedExposure: string;
};

type ArHoldErrorBody = {
  code: 'AR_HOLD_EXCEEDED';
  error: string;
  arHoldDays: number;
  worstInvoiceNumber: string;
  worstInvoiceDaysPastDue: number;
};

type ConfirmBlock = CreditErrorBody | ArHoldErrorBody | null;

function ConfirmAction({ salesOrderId, salesOrderNumber }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [block, setBlock] = useState<ConfirmBlock>(null);

  function reset() {
    setBlock(null);
  }

  function onConfirm() {
    startTransition(async () => {
      try {
        const res = await fetch(
          `/api/sales-orders/${salesOrderId}/confirm`,
          { method: 'POST' },
        );
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            code?: string;
            error?: string;
          } & Record<string, unknown>;
          if (
            body.code === 'CREDIT_LIMIT_EXCEEDED' ||
            body.code === 'AR_HOLD_EXCEEDED'
          ) {
            setBlock(body as unknown as ConfirmBlock);
            return;
          }
          toast.error(body.error ?? `Confirm failed (${res.status})`);
          return;
        }
        toast.success(`Confirmed ${salesOrderNumber}`);
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
      <Button size="sm" onClick={() => setOpen(true)}>
        <CheckCircle2 />
        Confirm
      </Button>
      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>Confirm this order?</AlertDialogTitle>
          <AlertDialogDescription>
            Reserves inventory for every line and runs credit-limit + AR-hold
            checks. The order moves to <strong>Confirmed</strong>.
          </AlertDialogDescription>
        </AlertDialogHeader>

        {block?.code === 'CREDIT_LIMIT_EXCEEDED' ? (
          <CreditLimitBlockPanel block={block} />
        ) : null}
        {block?.code === 'AR_HOLD_EXCEEDED' ? (
          <ArHoldBlockPanel block={block} />
        ) : null}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          {block ? (
            <span
              aria-disabled="true"
              className="inline-flex h-8 cursor-not-allowed items-center rounded-md border border-border bg-muted px-3 text-xs text-muted-foreground"
              title="Manager override not available yet"
            >
              Override (not available)
            </span>
          ) : (
            <AlertDialogAction onClick={onConfirm} disabled={pending}>
              {pending ? 'Confirming…' : 'Confirm'}
            </AlertDialogAction>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function CreditLimitBlockPanel({ block }: { block: CreditErrorBody }) {
  return (
    <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs">
      <div className="mb-2 font-medium text-destructive">
        Credit limit exceeded
      </div>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-muted-foreground tabular-nums">
        <dt>Limit</dt>
        <dd className="text-right text-foreground">
          {formatCurrency(block.creditLimit)}
        </dd>
        <dt>Current AR balance</dt>
        <dd className="text-right text-foreground">
          {formatCurrency(block.arBalance)}
        </dd>
        <dt>Open SOs (not invoiced)</dt>
        <dd className="text-right text-foreground">
          {formatCurrency(block.openSosTotal)}
        </dd>
        <dt>This order</dt>
        <dd className="text-right text-foreground">
          {formatCurrency(block.thisOrderTotal)}
        </dd>
        <dt className="border-t pt-1 text-destructive">Projected exposure</dt>
        <dd className="border-t pt-1 text-right font-semibold text-destructive">
          {formatCurrency(block.projectedExposure)}
        </dd>
      </dl>
    </div>
  );
}

function ArHoldBlockPanel({ block }: { block: ArHoldErrorBody }) {
  return (
    <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs">
      <div className="mb-2 font-medium text-destructive">AR hold triggered</div>
      <p className="text-muted-foreground">
        Invoice{' '}
        <span className="font-mono text-foreground">
          {block.worstInvoiceNumber}
        </span>{' '}
        is{' '}
        <span className="font-semibold text-foreground">
          {block.worstInvoiceDaysPastDue} days
        </span>{' '}
        past due (hold threshold is {block.arHoldDays} days).
      </p>
    </div>
  );
}

// =============================================================================
// Dispatch — simple POST, no payload.
// =============================================================================

function DispatchAction({ salesOrderId, salesOrderNumber }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  function onDispatch() {
    startTransition(async () => {
      try {
        const res = await fetch(
          `/api/sales-orders/${salesOrderId}/dispatch`,
          { method: 'POST' },
        );
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          toast.error(body.error ?? `Dispatch failed (${res.status})`);
          return;
        }
        toast.success(`Dispatched ${salesOrderNumber}`);
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
        <Send />
        Dispatch
      </Button>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Dispatch this order?</AlertDialogTitle>
          <AlertDialogDescription>
            Marks the order as shipped/handed off. The reservation stays in
            place; inventory is not yet consumed.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onDispatch} disabled={pending}>
            {pending ? 'Dispatching…' : 'Dispatch'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// =============================================================================
// Close — collects shipping + handling (pre-filled from current SO),
// auto-generates an invoice on the server, consumes inventory.
// =============================================================================

function CloseAction({
  salesOrderId,
  salesOrderNumber,
  shippingAmount,
  handlingAmount,
}: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [shipping, setShipping] = useState(shippingAmount ?? '');
  const [handling, setHandling] = useState(handlingAmount ?? '');
  const [error, setError] = useState<string | null>(null);

  const DECIMAL_RE = /^\d+(\.\d+)?$/;

  function onClose() {
    setError(null);
    // Loose client-side validation so the operator sees obvious typos
    // before hitting the server. The server is the source of truth.
    if (shipping && !DECIMAL_RE.test(shipping)) {
      setError('Shipping must be a non-negative number');
      return;
    }
    if (handling && !DECIMAL_RE.test(handling)) {
      setError('Handling must be a non-negative number');
      return;
    }
    startTransition(async () => {
      try {
        const body: Record<string, string> = {};
        if (shipping) body.shippingAmount = shipping;
        if (handling) body.handlingAmount = handling;
        // qtyShipped per line is captured inline on the SO detail
        // page's Qty shipped column while the SO is CONFIRMED /
        // DISPATCHED; closeSalesOrder picks up the saved values
        // automatically. The Close dialog only collects header-level
        // money fields.
        const res = await fetch(
          `/api/sales-orders/${salesOrderId}/close`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          },
        );
        if (!res.ok) {
          const errBody = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          toast.error(errBody.error ?? `Close failed (${res.status})`);
          return;
        }
        toast.success(`Closed ${salesOrderNumber} — invoice generated`);
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
        <PackageCheck />
        Close
      </Button>
      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>Close this order?</AlertDialogTitle>
          <AlertDialogDescription>
            Consumes reserved inventory, generates an invoice (billed on
            qty shipped from the lines table), and posts COGS. Leave
            shipping or handling blank to keep the current value.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <Field>
            <FieldLabel htmlFor="close-shipping">Shipping</FieldLabel>
            <Input
              id="close-shipping"
              inputMode="decimal"
              placeholder="0.00"
              value={shipping}
              onChange={(e) => setShipping(e.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="close-handling">Handling</FieldLabel>
            <Input
              id="close-handling"
              inputMode="decimal"
              placeholder="0.00"
              value={handling}
              onChange={(e) => setHandling(e.target.value)}
            />
          </Field>
        </div>
        {error ? (
          <p className="text-xs text-destructive">{error}</p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onClose} disabled={pending}>
            {pending ? 'Closing…' : 'Close & invoice'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// =============================================================================
// Cancel — required reason. Surfaces SO_CANCEL_BLOCKED_BY_PAYMENT with
// the offending payment numbers.
// =============================================================================

function CancelMenuItem({ salesOrderId, salesOrderNumber }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [paymentBlock, setPaymentBlock] = useState<string[] | null>(null);

  function onCancel() {
    setError(null);
    if (reason.trim().length === 0) {
      setError('Reason is required');
      return;
    }
    startTransition(async () => {
      try {
        const res = await fetch(
          `/api/sales-orders/${salesOrderId}/cancel`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason: reason.trim() }),
          },
        );
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            code?: string;
            error?: string;
            paymentNumbers?: string[];
          };
          if (body.code === 'SO_CANCEL_BLOCKED_BY_PAYMENT') {
            setPaymentBlock(body.paymentNumbers ?? []);
            return;
          }
          toast.error(body.error ?? `Cancel failed (${res.status})`);
          return;
        }
        toast.success(`Cancelled ${salesOrderNumber}`);
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
          setPaymentBlock(null);
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
        Cancel order
      </DropdownMenuItem>
      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>Cancel this order?</AlertDialogTitle>
          <AlertDialogDescription>
            Reverses any inventory reservation. A short reason is required for
            the audit trail.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <Field>
          <FieldLabel htmlFor="cancel-reason">Reason</FieldLabel>
          <Textarea
            id="cancel-reason"
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. customer no longer needs the order"
            aria-invalid={!!error}
          />
          {error ? <FieldError errors={[{ message: error }]} /> : null}
        </Field>
        {paymentBlock ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs">
            <div className="mb-1 font-medium text-destructive">
              Cancel blocked — payment(s) applied
            </div>
            <p className="text-muted-foreground">
              Reverse payment{paymentBlock.length === 1 ? '' : 's'}{' '}
              <span className="font-mono text-foreground">
                {paymentBlock.join(', ')}
              </span>{' '}
              first, then try again.
            </p>
          </div>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Keep order</AlertDialogCancel>
          <AlertDialogAction
            onClick={onCancel}
            disabled={pending}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {pending ? 'Cancelling…' : 'Cancel order'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// =============================================================================
// Delete — soft-delete, DRAFT or CANCELLED only.
// =============================================================================

function DeleteMenuItem({ salesOrderId, salesOrderNumber }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  function onDelete() {
    startTransition(async () => {
      try {
        const res = await fetch(`/api/sales-orders/${salesOrderId}`, {
          method: 'DELETE',
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          toast.error(body.error ?? `Delete failed (${res.status})`);
          return;
        }
        toast.success(`Deleted ${salesOrderNumber}`);
        setOpen(false);
        router.push('/sales-orders');
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
        Delete order
      </DropdownMenuItem>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this order?</AlertDialogTitle>
          <AlertDialogDescription>
            <span className="font-mono font-medium text-foreground">
              {salesOrderNumber}
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
