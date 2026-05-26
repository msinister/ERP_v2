'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  CheckCircle2,
  MoreVertical,
  Pencil,
  PackageCheck,
  RotateCcw,
  Send,
  Trash2,
  Undo2,
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
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { formatCurrency } from '@/lib/format';
import {
  isNonNegativeDecimalInput,
  normalizeDecimalForSubmit,
} from '@/lib/decimal-input';

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
  // Edit reachable on DRAFT (full edit) or CONFIRMED (add-only — see
  // addSalesOrderLines + the edit page's conditional gate). DISPATCHED
  // and beyond stay locked.
  const canEdit = status === 'DRAFT' || status === 'CONFIRMED';
  const canDispatch = status === 'CONFIRMED';
  // closeSalesOrder accepts CONFIRMED or DISPATCHED (pickup orders
  // skip dispatched per docs/05-sales-orders.md).
  const canClose = status === 'CONFIRMED' || status === 'DISPATCHED';
  const canUndispatch = status === 'DISPATCHED';
  const canReopen = status === 'CLOSED';
  const canCancel =
    status === 'DRAFT' || status === 'CONFIRMED' || status === 'DISPATCHED';
  const canDelete = status === 'DRAFT' || status === 'CANCELLED';

  const hasMenu = canCancel || canDelete || canUndispatch || canReopen;

  // Dialog-open state is lifted up here, NOT inside the DropdownMenuItem
  // components. Reason: base-ui's DropdownMenu uses a portal; rendering
  // an AlertDialog inside a DropdownMenuItem means the dialog mounts
  // inside the menu's portal. When the menu auto-dismisses (the
  // operator's click on the dialog action lands outside the menu's
  // popup boundary), the menu portal unmounts and takes the dialog
  // state with it — the dialog disappears mid-flight, no toast, no
  // visible error. By keeping the dialogs OUTSIDE the menu in the
  // React tree we sidestep that portal lifetime coupling entirely.
  const [openDialog, setOpenDialog] = useState<
    'undispatch' | 'reopen' | 'cancel' | 'delete' | null
  >(null);

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
      {hasMenu ? (
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
            {canUndispatch ? (
              <DropdownMenuItem
                onClick={(e) => {
                  e.preventDefault();
                  setOpenDialog('undispatch');
                }}
              >
                <Undo2 className="size-4" />
                Un-dispatch
              </DropdownMenuItem>
            ) : null}
            {canReopen ? (
              <DropdownMenuItem
                onClick={(e) => {
                  e.preventDefault();
                  setOpenDialog('reopen');
                }}
              >
                <RotateCcw className="size-4" />
                Reopen order
              </DropdownMenuItem>
            ) : null}
            {canCancel ? (
              <DropdownMenuItem
                onClick={() => setOpenDialog('cancel')}
                variant="destructive"
              >
                <XCircle className="size-4" />
                Cancel order
              </DropdownMenuItem>
            ) : null}
            {canDelete ? (
              <DropdownMenuItem
                onClick={() => setOpenDialog('delete')}
                variant="destructive"
              >
                <Trash2 className="size-4" />
                Delete order
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}

      {/* Dialogs are mounted here as siblings of the DropdownMenu so
          they outlive the menu's portal lifecycle. */}
      <UndispatchDialog
        {...props}
        open={openDialog === 'undispatch'}
        onClose={() => setOpenDialog(null)}
      />
      <ReopenDialog
        {...props}
        open={openDialog === 'reopen'}
        onClose={() => setOpenDialog(null)}
      />
      <CancelDialog
        {...props}
        open={openDialog === 'cancel'}
        onClose={() => setOpenDialog(null)}
      />
      <DeleteDialog
        {...props}
        open={openDialog === 'delete'}
        onClose={() => setOpenDialog(null)}
      />
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

  function onClose() {
    setError(null);
    // Loose client-side validation so the operator sees obvious typos
    // before hitting the server. The server is the source of truth.
    // Accepts the leading-dot shorthand (".93") via the shared helper.
    if (shipping && !isNonNegativeDecimalInput(shipping)) {
      setError('Shipping must be a non-negative number');
      return;
    }
    if (handling && !isNonNegativeDecimalInput(handling)) {
      setError('Handling must be a non-negative number');
      return;
    }
    startTransition(async () => {
      try {
        const body: Record<string, string> = {};
        if (shipping) body.shippingAmount = normalizeDecimalForSubmit(shipping);
        if (handling) body.handlingAmount = normalizeDecimalForSubmit(handling);
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

// =============================================================================
// Un-dispatch — DISPATCHED → CONFIRMED, no inventory effects.
// =============================================================================

function UndispatchDialog({
  salesOrderId,
  salesOrderNumber,
  open,
  onClose,
}: Props & { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onUndispatch() {
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch(
          `/api/sales-orders/${salesOrderId}/undispatch`,
          { method: 'POST' },
        );
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          const message =
            body.error ?? `Un-dispatch failed (${res.status})`;
          // Stay in the dialog with an inline error. Toast for
          // belt-and-braces in case the dialog ever dismisses
          // unexpectedly. router.refresh is NOT called on the error
          // path — refresh would cause the parent SO detail page to
          // re-render and could unmount the dialog mid-read.
          setError(message);
          toast.error(message);
          return;
        }
        toast.success(`Un-dispatched ${salesOrderNumber}`);
        onClose();
        router.refresh();
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Network error';
        setError(message);
        toast.error(message);
      }
    });
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(o) => {
        // Only allow base-ui to close us via Escape / outside-press
        // when no request is in-flight. The error case keeps the
        // dialog open until the operator clicks Cancel.
        if (!o && !pending) {
          setError(null);
          onClose();
        }
      }}
    >
      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>Un-dispatch this order?</AlertDialogTitle>
          <AlertDialogDescription>
            Moves the order back to Confirmed. Inventory reservations stay as
            they are — Dispatched is a shipping-intent marker, not an inventory
            state.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
            {error}
          </div>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Keep dispatched</AlertDialogCancel>
          <AlertDialogAction onClick={onUndispatch} disabled={pending}>
            {pending ? 'Un-dispatching…' : 'Un-dispatch'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// =============================================================================
// Reopen — CLOSED → CONFIRMED | DISPATCHED | CANCELLED.
// Two-phase flow:
//   - First attempt POSTs paymentDecision='none'. If the invoice has applied
//     payments, the server returns 409 with the payment details. The dialog
//     updates to show the payment summary + an "Unapply and reopen?" prompt.
//   - Operator clicks Unapply → POST again with paymentDecision='unapply'.
// =============================================================================

type ReopenTarget = 'CONFIRMED' | 'DISPATCHED' | 'CANCELLED';

type ReopenBlockedBody = {
  code: 'SO_REOPEN_BLOCKED_BY_PAYMENT';
  error: string;
  invoiceId: string;
  invoiceNumber: string;
  payments: Array<{
    paymentId: string;
    paymentNumber: string;
    receivedAt: string;
    amount: string;
    amountAppliedToThisInvoice: string;
  }>;
};

function ReopenDialog({
  salesOrderId,
  salesOrderNumber,
  open,
  onClose,
}: Props & { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [target, setTarget] = useState<ReopenTarget>('CONFIRMED');
  const [paymentBlock, setPaymentBlock] = useState<ReopenBlockedBody | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setTarget('CONFIRMED');
    setPaymentBlock(null);
    setError(null);
  }

  function submit(decision: 'none' | 'unapply') {
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch(
          `/api/sales-orders/${salesOrderId}/reopen`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              targetStatus: target,
              paymentDecision: decision,
            }),
          },
        );
        if (res.status === 409) {
          const body = (await res.json().catch(() => ({}))) as
            | ReopenBlockedBody
            | { error?: string };
          if (
            'code' in body &&
            body.code === 'SO_REOPEN_BLOCKED_BY_PAYMENT'
          ) {
            setPaymentBlock(body as ReopenBlockedBody);
            return;
          }
          const message = ('error' in body && body.error) || 'Reopen blocked';
          setError(message);
          toast.error(message);
          return;
        }
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          const message = body.error ?? `Reopen failed (${res.status})`;
          setError(message);
          toast.error(message);
          return;
        }
        const labels: Record<ReopenTarget, string> = {
          CONFIRMED: 'Confirmed',
          DISPATCHED: 'Dispatched',
          CANCELLED: 'Cancelled',
        };
        toast.success(
          `${salesOrderNumber} reopened to ${labels[target]}` +
            (decision === 'unapply' ? ' — payments unapplied' : ''),
        );
        reset();
        onClose();
        router.refresh();
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Network error';
        setError(message);
        toast.error(message);
      }
    });
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(o) => {
        if (!o && !pending) {
          reset();
          onClose();
        }
      }}
    >
      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {paymentBlock ? 'Unapply payment and reopen?' : 'Reopen this order?'}
          </AlertDialogTitle>
          <AlertDialogDescription>
            Reverses inventory deduction (stock back to Reserved) and unlinks
            the invoice from this order. The invoice stays as a standalone
            record — you&apos;ll need to void it or apply a credit memo
            separately if the customer shouldn&apos;t be billed.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {paymentBlock ? (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs">
            <div className="mb-1 font-medium text-amber-700 dark:text-amber-400">
              Applied payment on invoice {paymentBlock.invoiceNumber}
            </div>
            <ul className="space-y-1 text-muted-foreground">
              {paymentBlock.payments.map((p) => (
                <li key={p.paymentId}>
                  <span className="font-mono text-foreground">
                    {p.paymentNumber}
                  </span>{' '}
                  — {formatCurrency(p.amountAppliedToThisInvoice)} applied
                  {Number(p.amount) !==
                  Number(p.amountAppliedToThisInvoice) ? (
                    <span className="text-amber-700 dark:text-amber-400">
                      {' '}
                      (payment total {formatCurrency(p.amount)} — reversal
                      will unapply from every invoice it touches)
                    </span>
                  ) : null}{' '}
                  on{' '}
                  {new Date(p.receivedAt).toLocaleDateString('en-US', {
                    month: 'short',
                    day: 'numeric',
                    year: 'numeric',
                    timeZone: 'UTC',
                  })}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-muted-foreground">
              Unapply the payment{paymentBlock.payments.length === 1 ? '' : 's'}{' '}
              and reopen the order?
            </p>
          </div>
        ) : (
          <div className="space-y-2 rounded-md border border-border bg-muted/30 p-3 text-xs">
            <div className="text-muted-foreground">Reopen to:</div>
            <div className="space-y-1.5">
              {(['CONFIRMED', 'DISPATCHED', 'CANCELLED'] as const).map((t) => (
                <label
                  key={t}
                  className="flex cursor-pointer items-center gap-2"
                >
                  <input
                    type="radio"
                    name="reopen-target"
                    value={t}
                    checked={target === t}
                    onChange={() => setTarget(t)}
                    className="size-3.5"
                  />
                  <span className="font-medium">
                    {t === 'CONFIRMED'
                      ? 'Confirmed'
                      : t === 'DISPATCHED'
                        ? 'Dispatched'
                        : 'Cancelled'}
                  </span>
                  <span className="text-muted-foreground">
                    {t === 'CONFIRMED'
                      ? '— restore reservation, ready to re-close'
                      : t === 'DISPATCHED'
                        ? '— restore reservation, ready to ship'
                        : '— release reservation, mark cancelled'}
                  </span>
                </label>
              ))}
            </div>
          </div>
        )}
        {error ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
            {error}
          </div>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Keep closed</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => submit(paymentBlock ? 'unapply' : 'none')}
            disabled={pending}
          >
            {pending
              ? 'Working…'
              : paymentBlock
                ? 'Unapply & reopen'
                : 'Reopen'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function CancelDialog({
  salesOrderId,
  salesOrderNumber,
  open,
  onClose,
}: Props & { open: boolean; onClose: () => void }) {
  const router = useRouter();
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
        onClose();
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
        if (!o && !pending) {
          setReason('');
          setError(null);
          setPaymentBlock(null);
          onClose();
        }
      }}
    >
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

function DeleteDialog({
  salesOrderId,
  salesOrderNumber,
  open,
  onClose,
}: Props & { open: boolean; onClose: () => void }) {
  const router = useRouter();
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
        onClose();
        router.push('/sales-orders');
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
        if (!o && !pending) onClose();
      }}
    >
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
