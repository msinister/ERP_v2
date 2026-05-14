'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
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

export type CashAccountOption = {
  id: string;
  code: string;
  name: string;
};

// Method values come from the PaymentMethod enum in
// prisma/tenant/schema.prisma. APPLIED_CREDIT is rejected by the
// service-level validator (vendor credits go through their own apply
// path), so it's intentionally not in the picker.
const METHODS: Array<{ value: string; label: string }> = [
  { value: 'CHECK', label: 'Check' },
  { value: 'ACH', label: 'ACH' },
  { value: 'WIRE', label: 'Wire' },
  { value: 'CREDIT_CARD', label: 'Credit card' },
  { value: 'CASH', label: 'Cash' },
  { value: 'MONEY_ORDER', label: 'Money order' },
];

const POSITIVE_DECIMAL_RE = /^\d+(\.\d+)?$/;

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

export function RecordPaymentDialog({
  billId,
  billNumber,
  remainingBalance,
  cashAccounts,
  open,
  onOpenChange,
}: {
  billId: string;
  billNumber: string;
  // String (Decimal-as-string) so we don't introduce a JS Number for
  // money in the plumbing. Used for the "default amount = balance"
  // pre-fill + the overpayment hint.
  remainingBalance: string;
  cashAccounts: CashAccountOption[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<string>('CHECK');
  const [cashAccountId, setCashAccountId] = useState<string>('');
  const [paymentDate, setPaymentDate] = useState<string>('');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [errors, setErrors] = useState<Partial<Record<string, string>>>({});

  // Re-seed when the dialog opens. Amount defaults to remaining balance
  // (the most common case); date defaults to today.
  useEffect(() => {
    if (!open) return;
    setErrors({});
    setAmount(remainingBalance);
    setMethod('CHECK');
    setCashAccountId(cashAccounts[0]?.id ?? '');
    setPaymentDate(new Date().toISOString().slice(0, 10));
    setReference('');
    setNotes('');
  }, [open, remainingBalance, cashAccounts]);

  function submit() {
    const next: Partial<Record<string, string>> = {};
    if (!POSITIVE_DECIMAL_RE.test(amount))
      next.amount = 'Must be a positive number';
    else if (Number(amount) <= 0) next.amount = 'Must be greater than 0';
    if (!cashAccountId) next.cashAccountId = 'Pick a cash account';
    if (Object.keys(next).length > 0) {
      setErrors(next);
      return;
    }
    setErrors({});
    const payload = {
      amount,
      method,
      cashAccountId,
      paymentDate: paymentDate || undefined,
      reference: reference.trim() || undefined,
      notes: notes.trim() || undefined,
    };
    startTransition(async () => {
      try {
        const res = await fetch(`/api/bills/${billId}/payments`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          toast.error(await readApiError(res));
          return;
        }
        const result = (await res.json()) as {
          billPayment: { number: string; amount: string };
          overpaymentCredit: { number: string; amount: string } | null;
        };
        // Q7 from discovery — surface the auto-created overpayment VC.
        // The service has already CONFIRMED the VC and posted its JE.
        if (result.overpaymentCredit) {
          toast.success(
            `Recorded ${result.billPayment.number} for ${formatCurrency(
              result.billPayment.amount,
            )}.`,
          );
          toast.info(
            `Overpayment of ${formatCurrency(
              result.overpaymentCredit.amount,
            )} created vendor credit ${result.overpaymentCredit.number}.`,
            { duration: 8000 },
          );
        } else {
          toast.success(
            `Recorded ${result.billPayment.number} for ${formatCurrency(
              result.billPayment.amount,
            )}.`,
          );
        }
        onOpenChange(false);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Network error');
      }
    });
  }

  // Inline overpayment warning so the operator sees it before submit.
  // Service still does the auto-VC handling regardless.
  const overpaying =
    POSITIVE_DECIMAL_RE.test(amount) &&
    POSITIVE_DECIMAL_RE.test(remainingBalance) &&
    Number(amount) > Number(remainingBalance);

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>Record payment</AlertDialogTitle>
          <AlertDialogDescription>
            Posts the cash-out JE (DR AP / CR cash) against{' '}
            <span className="font-mono">{billNumber}</span>. Overpayment
            auto-creates a confirmed vendor credit for the excess.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-3">
          <Field>
            <FieldLabel htmlFor="pay-amount">Amount</FieldLabel>
            <Input
              id="pay-amount"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              aria-invalid={!!errors.amount}
            />
            <FieldError
              errors={[errors.amount ? { message: errors.amount } : undefined]}
            />
            <p className="text-xs text-muted-foreground">
              Remaining balance: {formatCurrency(remainingBalance)}
            </p>
            {overpaying ? (
              <p className="text-xs text-amber-600">
                Overpaying by{' '}
                {formatCurrency((Number(amount) - Number(remainingBalance)).toFixed(2))}
                {' '}— a vendor credit will be auto-created for the excess.
              </p>
            ) : null}
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field>
              <FieldLabel htmlFor="pay-method">Method</FieldLabel>
              <Select value={method} onValueChange={(v) => setMethod(v ?? 'CHECK')}>
                <SelectTrigger id="pay-method" className="w-full">
                  <SelectValue />
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
              <FieldLabel htmlFor="pay-date">Date</FieldLabel>
              <Input
                id="pay-date"
                type="date"
                value={paymentDate}
                onChange={(e) => setPaymentDate(e.target.value)}
              />
            </Field>
          </div>

          <Field>
            <FieldLabel htmlFor="pay-cash-account">Cash account</FieldLabel>
            <Select
              value={cashAccountId}
              onValueChange={(v) => setCashAccountId(v ?? '')}
            >
              <SelectTrigger
                id="pay-cash-account"
                className="w-full"
                aria-invalid={!!errors.cashAccountId}
              >
                <SelectValue placeholder="Pick a bank / cash account" />
              </SelectTrigger>
              <SelectContent>
                {cashAccounts.length === 0 ? (
                  <div className="px-2 py-1.5 text-xs text-muted-foreground">
                    No ASSET-type accounts configured — set one up under
                    Admin → GL accounts first.
                  </div>
                ) : (
                  cashAccounts.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      <span className="font-mono text-xs text-muted-foreground">
                        {a.code}
                      </span>{' '}
                      {a.name}
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
            <FieldError
              errors={[errors.cashAccountId ? { message: errors.cashAccountId } : undefined]}
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="pay-reference">
              Reference (check #, wire ref, ACH trace…)
            </FieldLabel>
            <Input
              id="pay-reference"
              placeholder="optional"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="pay-notes">Notes</FieldLabel>
            <Textarea
              id="pay-notes"
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
