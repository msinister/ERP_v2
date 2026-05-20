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
import {
  isPositiveDecimalInput,
  normalizeDecimalForSubmit,
} from '@/lib/decimal-input';

// List-page Record Payment dialog: customer-first. The operator picks a
// customer, then (optionally) one of that customer's open invoices to
// apply the payment to. Leaving the invoice unselected records the
// payment as unapplied credit on the customer. Posts DR Cash / CR AR
// via /api/payments (the service hardcodes accounts 1110 / 1210).

const METHODS: Array<{ value: string; label: string }> = [
  { value: 'CHECK', label: 'Check' },
  { value: 'ACH', label: 'ACH' },
  { value: 'WIRE', label: 'Wire' },
  { value: 'CREDIT_CARD', label: 'Credit card' },
  { value: 'CASH', label: 'Cash' },
  { value: 'MONEY_ORDER', label: 'Money order' },
];

const NO_INVOICE = '__none__';

export type CustomerOption = { id: string; code: string; name: string };

type OpenInvoice = {
  invoiceId: string;
  number: string;
  balance: string;
};

type AgingResponse = {
  invoices: Array<{ invoiceId: string; number: string; balance: string }>;
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

export function RecordPaymentDialog({
  customers,
  open,
  onOpenChange,
}: {
  customers: CustomerOption[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [customerId, setCustomerId] = useState('');
  const [openInvoices, setOpenInvoices] = useState<OpenInvoice[]>([]);
  const [loadingInvoices, setLoadingInvoices] = useState(false);
  const [invoiceId, setInvoiceId] = useState(NO_INVOICE);
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('CHECK');
  const [receivedAt, setReceivedAt] = useState('');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [errors, setErrors] = useState<Partial<Record<string, string>>>({});

  // Reset on open.
  useEffect(() => {
    if (!open) return;
    setErrors({});
    setCustomerId('');
    setOpenInvoices([]);
    setInvoiceId(NO_INVOICE);
    setAmount('');
    setMethod('CHECK');
    setReceivedAt(new Date().toISOString().slice(0, 10));
    setReference('');
    setNotes('');
  }, [open]);

  // When the customer changes, load their open invoices for the
  // (optional) apply-to picker.
  useEffect(() => {
    if (!customerId) {
      setOpenInvoices([]);
      setInvoiceId(NO_INVOICE);
      return;
    }
    let cancelled = false;
    setLoadingInvoices(true);
    setInvoiceId(NO_INVOICE);
    fetch(`/api/customers/${customerId}/aging`)
      .then((res) => (res.ok ? (res.json() as Promise<AgingResponse>) : null))
      .then((data) => {
        if (cancelled || !data) return;
        setOpenInvoices(
          data.invoices.map((i) => ({
            invoiceId: i.invoiceId,
            number: i.number,
            balance: i.balance,
          })),
        );
      })
      .catch(() => {
        if (!cancelled) setOpenInvoices([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingInvoices(false);
      });
    return () => {
      cancelled = true;
    };
  }, [customerId]);

  const selectedInvoice =
    invoiceId === NO_INVOICE
      ? null
      : (openInvoices.find((i) => i.invoiceId === invoiceId) ?? null);

  // Prefill amount with the selected invoice's balance.
  useEffect(() => {
    if (selectedInvoice) setAmount(selectedInvoice.balance);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoiceId]);

  const customer = customers.find((c) => c.id === customerId) ?? null;

  const overpaying =
    selectedInvoice != null &&
    isPositiveDecimalInput(amount) &&
    Number.isFinite(Number(selectedInvoice.balance)) &&
    Number(amount) > Number(selectedInvoice.balance);

  function submit() {
    const next: Partial<Record<string, string>> = {};
    if (!customerId) next.customerId = 'Pick a customer';
    if (!isPositiveDecimalInput(amount)) next.amount = 'Must be a positive number';
    if (Object.keys(next).length > 0) {
      setErrors(next);
      return;
    }
    setErrors({});
    const normalizedAmount = normalizeDecimalForSubmit(amount);

    // Build the application when an invoice is selected. Cap at the
    // invoice balance; spillover stays as unapplied credit.
    let applications:
      | Array<{ invoiceId: string; amount: string }>
      | undefined = undefined;
    if (selectedInvoice) {
      const balanceN = Number(selectedInvoice.balance);
      const amtN = Number(normalizedAmount);
      const applyAmt =
        Number.isFinite(balanceN) && Number.isFinite(amtN) && amtN > balanceN
          ? selectedInvoice.balance
          : normalizedAmount;
      applications = [
        { invoiceId: selectedInvoice.invoiceId, amount: applyAmt },
      ];
    }

    const payload = {
      customerId,
      method,
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
          id: string;
          number: string;
          amount: string;
          appliedAmount: string;
        };
        toast.success(
          `Recorded ${result.number} for ${formatCurrency(result.amount)}.`,
        );
        onOpenChange(false);
        router.push(`/payments/${result.id}`);
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
          <AlertDialogTitle>Record payment</AlertDialogTitle>
          <AlertDialogDescription>
            Pick a customer, then optionally apply the payment to one of
            their open invoices. Posts DR Cash / CR AR.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-3">
          <Field>
            <FieldLabel htmlFor="rp-customer">Customer</FieldLabel>
            <Select
              value={customerId}
              onValueChange={(v) => setCustomerId(v ?? '')}
            >
              <SelectTrigger
                id="rp-customer"
                className="w-full"
                aria-invalid={!!errors.customerId}
              >
                <SelectValue placeholder="Select a customer">
                  {(v) => {
                    const c = customers.find((x) => x.id === v);
                    return c ? `${c.name} (${c.code})` : 'Select a customer';
                  }}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {customers.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name} ({c.code})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldError
              errors={[
                errors.customerId ? { message: errors.customerId } : undefined,
              ]}
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="rp-invoice">Apply to invoice</FieldLabel>
            <Select
              value={invoiceId}
              onValueChange={(v) => setInvoiceId(v ?? NO_INVOICE)}
              disabled={!customerId || loadingInvoices}
            >
              <SelectTrigger id="rp-invoice" className="w-full">
                <SelectValue>
                  {(v) => {
                    if (v === NO_INVOICE)
                      return loadingInvoices
                        ? 'Loading invoices…'
                        : 'Leave unapplied';
                    const inv = openInvoices.find((i) => i.invoiceId === v);
                    return inv
                      ? `${inv.number} · ${formatCurrency(inv.balance)}`
                      : 'Leave unapplied';
                  }}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_INVOICE}>
                  Leave unapplied (credit on account)
                </SelectItem>
                {openInvoices.map((i) => (
                  <SelectItem key={i.invoiceId} value={i.invoiceId}>
                    {i.number} · balance {formatCurrency(i.balance)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {customerId && !loadingInvoices && openInvoices.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No open invoices — the payment records as unapplied credit.
              </p>
            ) : null}
          </Field>

          <Field>
            <FieldLabel htmlFor="rp-amount">Amount</FieldLabel>
            <Input
              id="rp-amount"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              aria-invalid={!!errors.amount}
            />
            <FieldError
              errors={[errors.amount ? { message: errors.amount } : undefined]}
            />
            {overpaying ? (
              <p className="text-xs text-amber-600">
                Overpaying by{' '}
                {formatCurrency(
                  (
                    Number(amount) - Number(selectedInvoice!.balance)
                  ).toFixed(2),
                )}{' '}
                — excess stays as unapplied credit
                {customer ? ` on ${customer.name}` : ''}.
              </p>
            ) : null}
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field>
              <FieldLabel htmlFor="rp-method">Method</FieldLabel>
              <Select value={method} onValueChange={(v) => setMethod(v ?? 'CHECK')}>
                <SelectTrigger id="rp-method" className="w-full">
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
              <FieldLabel htmlFor="rp-date">Date</FieldLabel>
              <Input
                id="rp-date"
                type="date"
                value={receivedAt}
                onChange={(e) => setReceivedAt(e.target.value)}
              />
            </Field>
          </div>

          <Field>
            <FieldLabel htmlFor="rp-reference">
              Reference (check #, wire ref…)
            </FieldLabel>
            <Input
              id="rp-reference"
              placeholder="optional"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="rp-notes">Notes</FieldLabel>
            <Textarea
              id="rp-notes"
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
