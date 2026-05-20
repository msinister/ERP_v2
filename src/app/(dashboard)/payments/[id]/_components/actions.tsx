'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { DollarSign, Undo2 } from 'lucide-react';
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { formatCurrency } from '@/lib/format';
import {
  isPositiveDecimalInput,
  normalizeDecimalForSubmit,
} from '@/lib/decimal-input';

export type OpenInvoiceOption = {
  invoiceId: string;
  number: string;
  balance: string;
};

type ApiErrorBody = {
  error?: string;
  issues?: Array<{ path?: Array<string | number>; message?: string }>;
};

async function readApiError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as ApiErrorBody;
    if (body.issues?.length) {
      const issue = body.issues[0];
      const path = issue.path?.length ? issue.path.join('.') + ': ' : '';
      return `${path}${issue.message ?? 'validation error'}`;
    }
    return body.error ?? `Request failed (${res.status})`;
  } catch {
    return `Request failed (${res.status})`;
  }
}

export function PaymentActions({
  paymentId,
  paymentNumber,
  status,
  method,
  unapplied,
  openInvoices,
}: {
  paymentId: string;
  paymentNumber: string;
  status: string;
  method: string;
  /** Decimal-as-string. */
  unapplied: string;
  openInvoices: OpenInvoiceOption[];
}) {
  const [applyOpen, setApplyOpen] = useState(false);
  const [reverseOpen, setReverseOpen] = useState(false);

  const unappliedN = Number(unapplied);
  // APPLIED_CREDIT payments are credit-funded — applying their "amount"
  // as cash would invent money, so the apply action is gated out.
  const canApply =
    status === 'RECORDED' &&
    method !== 'APPLIED_CREDIT' &&
    Number.isFinite(unappliedN) &&
    unappliedN > 0;
  const canReverse = status === 'RECORDED';

  if (!canApply && !canReverse) return null;

  return (
    <div className="flex items-center gap-2">
      {canApply ? (
        <>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setApplyOpen(true)}
          >
            <DollarSign />
            Apply to invoice
          </Button>
          <ApplyDialog
            paymentId={paymentId}
            unapplied={unapplied}
            openInvoices={openInvoices}
            open={applyOpen}
            onOpenChange={setApplyOpen}
          />
        </>
      ) : null}
      {canReverse ? (
        <>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setReverseOpen(true)}
          >
            <Undo2 />
            Reverse payment
          </Button>
          <ReverseDialog
            paymentId={paymentId}
            paymentNumber={paymentNumber}
            open={reverseOpen}
            onOpenChange={setReverseOpen}
          />
        </>
      ) : null}
    </div>
  );
}

const NO_INVOICE = '';

function ApplyDialog({
  paymentId,
  unapplied,
  openInvoices,
  open,
  onOpenChange,
}: {
  paymentId: string;
  unapplied: string;
  openInvoices: OpenInvoiceOption[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [invoiceId, setInvoiceId] = useState(NO_INVOICE);
  const [amount, setAmount] = useState('');
  const [errors, setErrors] = useState<Partial<Record<string, string>>>({});

  useEffect(() => {
    if (!open) return;
    setErrors({});
    setInvoiceId(NO_INVOICE);
    setAmount('');
  }, [open]);

  const selected = openInvoices.find((i) => i.invoiceId === invoiceId) ?? null;

  // Default the amount to whichever is smaller: the unapplied balance or
  // the selected invoice's balance.
  useEffect(() => {
    if (!selected) return;
    const balN = Number(selected.balance);
    const unN = Number(unapplied);
    const seed =
      Number.isFinite(balN) && Number.isFinite(unN)
        ? Math.min(balN, unN).toFixed(2)
        : selected.balance;
    setAmount(seed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoiceId]);

  function submit() {
    const next: Partial<Record<string, string>> = {};
    if (!invoiceId) next.invoiceId = 'Pick an invoice';
    if (!isPositiveDecimalInput(amount)) {
      next.amount = 'Must be a positive number';
    } else if (Number(amount) > Number(unapplied) + 1e-9) {
      next.amount = `Cannot exceed unapplied balance (${formatCurrency(unapplied)})`;
    }
    if (Object.keys(next).length > 0) {
      setErrors(next);
      return;
    }
    setErrors({});
    startTransition(async () => {
      try {
        const res = await fetch(`/api/payments/${paymentId}/apply`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            invoiceId,
            amount: normalizeDecimalForSubmit(amount),
          }),
        });
        if (!res.ok) {
          toast.error(await readApiError(res));
          return;
        }
        toast.success('Applied to invoice.');
        onOpenChange(false);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Network error');
      }
    });
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>Apply to invoice</AlertDialogTitle>
          <AlertDialogDescription>
            Apply remaining unapplied balance of{' '}
            {formatCurrency(unapplied)} to an open invoice.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-3">
          <Field>
            <FieldLabel htmlFor="apply-invoice">Invoice</FieldLabel>
            <Select
              value={invoiceId}
              onValueChange={(v) => setInvoiceId(v ?? NO_INVOICE)}
            >
              <SelectTrigger
                id="apply-invoice"
                className="w-full"
                aria-invalid={!!errors.invoiceId}
              >
                <SelectValue placeholder="Select an open invoice">
                  {(v) => {
                    const inv = openInvoices.find((i) => i.invoiceId === v);
                    return inv
                      ? `${inv.number} · ${formatCurrency(inv.balance)}`
                      : 'Select an open invoice';
                  }}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {openInvoices.map((i) => (
                  <SelectItem key={i.invoiceId} value={i.invoiceId}>
                    {i.number} · balance {formatCurrency(i.balance)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldError
              errors={[
                errors.invoiceId ? { message: errors.invoiceId } : undefined,
              ]}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="apply-amount">Amount</FieldLabel>
            <Input
              id="apply-amount"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              aria-invalid={!!errors.amount}
            />
            <FieldError
              errors={[errors.amount ? { message: errors.amount } : undefined]}
            />
            <p className="text-xs text-muted-foreground">
              Unapplied balance: {formatCurrency(unapplied)}
            </p>
          </Field>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={submit} disabled={pending}>
            {pending ? 'Applying…' : 'Apply'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function ReverseDialog({
  paymentId,
  paymentNumber,
  open,
  onOpenChange,
}: {
  paymentId: string;
  paymentNumber: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setReason('');
    setError(null);
  }, [open]);

  function submit() {
    if (reason.trim().length === 0) {
      setError('Reason is required');
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch(`/api/payments/${paymentId}/reverse`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason: reason.trim() }),
        });
        if (!res.ok) {
          toast.error(await readApiError(res));
          return;
        }
        toast.success(`Reversed ${paymentNumber}.`);
        onOpenChange(false);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Network error');
      }
    });
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>Reverse payment {paymentNumber}?</AlertDialogTitle>
          <AlertDialogDescription>
            Marks the payment REVERSED, unwinds every application, and posts
            a reversing JE (DR AR / CR Cash). This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <Field>
          <FieldLabel htmlFor="reverse-reason">Reason</FieldLabel>
          <Textarea
            id="reverse-reason"
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. bounced check, applied to wrong customer…"
            aria-invalid={!!error}
          />
          <FieldError errors={[error ? { message: error } : undefined]} />
        </Field>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={submit}
            disabled={pending}
            className="bg-destructive text-white hover:bg-destructive/90"
          >
            {pending ? 'Reversing…' : 'Reverse payment'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
