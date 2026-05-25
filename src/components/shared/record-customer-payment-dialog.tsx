'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from '@/lib/toast';
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
import {
  CashAccountSelect,
  rememberCashAccount,
} from '@/components/shared/cash-account-select';
import { formatCurrency } from '@/lib/format';
import {
  isPositiveDecimalInput,
  normalizeDecimalForSubmit,
} from '@/lib/decimal-input';

// Method values come from the PaymentMethod enum in
// prisma/tenant/schema.prisma. APPLIED_CREDIT is rejected by the
// recordPayment validator when no applications are supplied — and
// even with applications it's a different workflow (consuming
// existing customer credit), so we exclude it from this picker.
// Operators apply credit via the future apply-credit flow.
const METHODS: Array<{ value: string; label: string }> = [
  { value: 'CHECK', label: 'Check' },
  { value: 'ACH', label: 'ACH' },
  { value: 'WIRE', label: 'Wire' },
  { value: 'CREDIT_CARD', label: 'Credit card' },
  { value: 'CASH', label: 'Cash' },
  { value: 'MONEY_ORDER', label: 'Money order' },
];

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

// Shared dialog for recording a customer payment. Two call-sites:
//
//   1. Bound to a specific invoice (SO detail page, Customer AR tab
//      per-row "Record payment" button). Pre-fills amount with the
//      invoice's remaining balance; posts with one application
//      against that invoiceId.
//
//   2. Customer-level / unapplied (Customer AR tab top-level button).
//      No targetInvoice → applications=[]. The full amount sits as
//      unapplied credit on the customer until the operator applies
//      it via the future apply-credit flow.
//
// The operator picks the deposit (cash/bank or credit-card) account;
// the service posts DR <that account> / CR AR (1210). The chosen
// account is stored on the Payment so a later reversal credits it back.
//
// Overpayment is supported via underapplication: if the operator
// types an amount greater than the invoice balance, we cap the
// application at the balance and surface the spillover as a hint.
// The excess stays as unapplied credit on the resulting payment.

export type TargetInvoice = {
  invoiceId: string;
  invoiceNumber: string;
  /** Decimal-as-string. Pre-fills the amount field and drives the
   * overpayment hint. */
  remainingBalance: string;
};

// Pre-invoice context for a customer-level deposit (no targetInvoice yet):
// a labelled figure (e.g. "Order Total" / "Balance Due") shown at the top
// and used to pre-fill the amount. Display + pre-fill only — the payment is
// still recorded as unapplied customer credit, never auto-applied.
export type PaymentPrefill = {
  label: string;
  /** Decimal-as-string. */
  amount: string;
};

export function RecordCustomerPaymentDialog({
  customerId,
  customerName,
  targetInvoice,
  prefill = null,
  open,
  onOpenChange,
}: {
  customerId: string;
  customerName: string;
  /** null = customer-level unapplied payment. */
  targetInvoice: TargetInvoice | null;
  /** Pre-invoice deposit context (ignored when targetInvoice is set). */
  prefill?: PaymentPrefill | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<string>('CHECK');
  const [cashAccountId, setCashAccountId] = useState('');
  const [receivedAt, setReceivedAt] = useState<string>('');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [errors, setErrors] = useState<Partial<Record<string, string>>>({});

  // Re-seed on open. Bound-to-invoice → default amount to remaining
  // balance; unapplied → leave blank for the operator to type.
  useEffect(() => {
    if (!open) return;
    setErrors({});
    // Pre-fill: invoice balance when bound, else the prefill amount (order
    // total / shipped balance) when it's positive, else blank.
    setAmount(
      targetInvoice?.remainingBalance ??
        (prefill && Number(prefill.amount) > 0 ? prefill.amount : ''),
    );
    setMethod('CHECK');
    setCashAccountId('');
    setReceivedAt(new Date().toISOString().slice(0, 10));
    setReference('');
    setNotes('');
  }, [open, targetInvoice?.remainingBalance, prefill]);

  function submit() {
    const next: Partial<Record<string, string>> = {};
    if (!isPositiveDecimalInput(amount)) {
      next.amount = 'Must be a positive number';
    }
    if (!cashAccountId) next.cashAccountId = 'Pick a cash account';
    if (Object.keys(next).length > 0) {
      setErrors(next);
      return;
    }
    setErrors({});
    const normalizedAmount = normalizeDecimalForSubmit(amount);

    // Build applications:
    //   - bound + amount <= balance → apply full amount to invoice
    //   - bound + amount > balance  → apply balance only; excess unapplied
    //   - unbound                   → no applications (customer-level credit)
    let applications:
      | Array<{ invoiceId: string; amount: string }>
      | undefined = undefined;
    if (targetInvoice) {
      const balanceN = Number(targetInvoice.remainingBalance);
      const amtN = Number(normalizedAmount);
      const applyAmt =
        Number.isFinite(balanceN) && Number.isFinite(amtN) && amtN > balanceN
          ? targetInvoice.remainingBalance
          : normalizedAmount;
      applications = [
        { invoiceId: targetInvoice.invoiceId, amount: applyAmt },
      ];
    }

    const payload = {
      customerId,
      method,
      cashAccountId,
      amount: normalizedAmount,
      receivedAt: receivedAt || undefined,
      reference: reference.trim() || undefined,
      notes: notes.trim() || undefined,
      applications,
    };

    startTransition(async () => {
      try {
        const res = await fetch('/api/payments', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          toast.error(await readApiError(res));
          return;
        }
        const result = (await res.json()) as {
          number: string;
          amount: string;
          appliedAmount: string;
        };
        const appliedN = Number(result.appliedAmount);
        const amtN = Number(result.amount);
        rememberCashAccount(cashAccountId);
        toast.success(
          `Recorded ${result.number} for ${formatCurrency(result.amount)}.`,
        );
        if (Number.isFinite(amtN) && Number.isFinite(appliedN) && amtN > appliedN) {
          const unapplied = (amtN - appliedN).toFixed(2);
          toast.info(
            `${formatCurrency(unapplied)} stays as unapplied credit on ${customerName}.`,
            { duration: 8000 },
          );
        }
        onOpenChange(false);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Network error');
      }
    });
  }

  // Display-only running figures (the service does the authoritative Decimal
  // math on submit). Base balance = invoice balance when bound, else the
  // pre-invoice deposit figure (order total / shipped balance).
  const baseBalanceN = targetInvoice
    ? Number(targetInvoice.remainingBalance)
    : prefill
      ? Number(prefill.amount)
      : null;
  const amtN = isPositiveDecimalInput(amount) ? Number(amount) : null;
  const afterBalance =
    baseBalanceN != null && amtN != null ? baseBalanceN - amtN : null;

  const overpaying =
    targetInvoice != null &&
    isPositiveDecimalInput(amount) &&
    Number.isFinite(Number(targetInvoice.remainingBalance)) &&
    Number(amount) > Number(targetInvoice.remainingBalance);

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>Record payment</AlertDialogTitle>
          <AlertDialogDescription>
            {targetInvoice ? (
              <>
                Posts DR Cash / CR AR against{' '}
                <span className="font-mono">{targetInvoice.invoiceNumber}</span>{' '}
                for {customerName}.
              </>
            ) : (
              <>
                Posts DR Cash / CR AR for {customerName}. The full amount
                stays as unapplied credit until you apply it to invoices.
              </>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-3">
          {targetInvoice ? (
            <div className="flex items-center justify-between rounded-md border border-border bg-muted/30 px-3 py-2">
              <span className="text-sm text-muted-foreground">
                Invoice Balance
              </span>
              <span className="text-base font-semibold tabular-nums">
                {formatCurrency(targetInvoice.remainingBalance)}
              </span>
            </div>
          ) : prefill ? (
            <div className="flex items-center justify-between rounded-md border border-border bg-muted/30 px-3 py-2">
              <span className="text-sm text-muted-foreground">
                {prefill.label}
              </span>
              <span className="text-base font-semibold tabular-nums">
                {formatCurrency(prefill.amount)}
              </span>
            </div>
          ) : null}

          <Field>
            <FieldLabel htmlFor="cust-pay-amount">Amount</FieldLabel>
            <Input
              id="cust-pay-amount"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              aria-invalid={!!errors.amount}
            />
            <FieldError
              errors={[errors.amount ? { message: errors.amount } : undefined]}
            />
            {afterBalance != null ? (
              <p className="text-xs text-muted-foreground">
                Balance after payment:{' '}
                <span className="tabular-nums">
                  {formatCurrency(afterBalance)}
                </span>
              </p>
            ) : null}
            {overpaying ? (
              <p className="text-xs text-amber-600">
                Overpaying by{' '}
                {formatCurrency(
                  (
                    Number(amount) - Number(targetInvoice!.remainingBalance)
                  ).toFixed(2),
                )}{' '}
                — excess will stay as unapplied credit on {customerName}.
              </p>
            ) : null}
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field>
              <FieldLabel htmlFor="cust-pay-method">Method</FieldLabel>
              <Select value={method} onValueChange={(v) => setMethod(v ?? 'CHECK')}>
                <SelectTrigger id="cust-pay-method" className="w-full">
                  <SelectValue>
                    {(v) => METHODS.find((m) => m.value === v)?.label ?? v}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {METHODS.map((m) => (
                    <SelectItem key={m.value} value={m.value}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="cust-pay-date">Date</FieldLabel>
              <Input
                id="cust-pay-date"
                type="date"
                value={receivedAt}
                onChange={(e) => setReceivedAt(e.target.value)}
              />
            </Field>
          </div>

          <Field>
            <FieldLabel htmlFor="cust-pay-cash-account">Deposit to</FieldLabel>
            <CashAccountSelect
              id="cust-pay-cash-account"
              value={cashAccountId}
              onValueChange={setCashAccountId}
              ariaInvalid={!!errors.cashAccountId}
            />
            <FieldError
              errors={[
                errors.cashAccountId
                  ? { message: errors.cashAccountId }
                  : undefined,
              ]}
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="cust-pay-reference">
              Reference (check #, wire ref, ACH trace…)
            </FieldLabel>
            <Input
              id="cust-pay-reference"
              placeholder="optional"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="cust-pay-notes">Notes</FieldLabel>
            <Textarea
              id="cust-pay-notes"
              rows={2}
              placeholder="optional"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </Field>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={submit} disabled={pending}>
            {pending ? 'Recording…' : 'Record payment'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
