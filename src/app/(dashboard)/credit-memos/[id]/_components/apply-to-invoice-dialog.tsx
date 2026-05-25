'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
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

// CM-side apply dialog. Operator picks one of the customer's open
// invoices (remaining = total − amountPaid − amountCredited > 0) and an
// amount up to min(cm.available, invoice.remaining). Application
// posts no GL — the JE happened at CM confirm; this just consumes the
// credit and reduces the invoice balance.

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

type OpenInvoice = {
  id: string;
  number: string;
  total: string;
  amountPaid: string;
  amountCredited: string;
  remaining: number;
  invoiceDate: string;
};

export function ApplyToInvoiceDialog({
  creditMemoId,
  creditMemoNumber,
  customerId,
  available,
  open,
  onOpenChange,
}: {
  creditMemoId: string;
  creditMemoNumber: string;
  customerId: string;
  available: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [loadingInvoices, setLoadingInvoices] = useState(false);
  const [invoices, setInvoices] = useState<OpenInvoice[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [invoiceId, setInvoiceId] = useState('');
  const [amount, setAmount] = useState('');
  const [errors, setErrors] = useState<Partial<Record<string, string>>>({});

  // Fetch the customer's OPEN invoices on dialog open. Filter to
  // remaining > 0 client-side.
  useEffect(() => {
    if (!open) return;
    setErrors({});
    setInvoiceId('');
    setAmount('');
    setLoadError(null);
    setInvoices([]);
    setLoadingInvoices(true);
    const params = new URLSearchParams({
      customerId,
      status: 'OPEN',
      take: '500',
    });
    fetch(`/api/invoices?${params.toString()}`)
      .then(async (res) => {
        if (!res.ok) {
          setLoadError(await readApiError(res));
          return;
        }
        const body = (await res.json()) as Array<{
          id: string;
          number: string;
          total: string;
          amountPaid: string;
          amountCredited: string;
          invoiceDate: string;
        }>;
        const opn = body
          .map((inv) => {
            const remaining =
              Number(inv.total) -
              Number(inv.amountPaid) -
              Number(inv.amountCredited);
            return {
              id: inv.id,
              number: inv.number,
              total: inv.total,
              amountPaid: inv.amountPaid,
              amountCredited: inv.amountCredited,
              remaining,
              invoiceDate: inv.invoiceDate,
            };
          })
          .filter((inv) => inv.remaining > 0)
          // Oldest first — standard AR application convention.
          .sort((a, b) => a.invoiceDate.localeCompare(b.invoiceDate));
        setInvoices(opn);
      })
      .catch((err) => {
        setLoadError(err instanceof Error ? err.message : 'Network error');
      })
      .finally(() => setLoadingInvoices(false));
  }, [open, customerId]);

  const selectedInvoice = useMemo(
    () => invoices.find((inv) => inv.id === invoiceId) ?? null,
    [invoices, invoiceId],
  );
  useEffect(() => {
    if (!selectedInvoice) {
      setAmount('');
      return;
    }
    const cap = Math.min(selectedInvoice.remaining, Number(available) || 0);
    if (cap > 0) setAmount(cap.toFixed(2));
  }, [selectedInvoice, available]);

  function submit() {
    const next: Partial<Record<string, string>> = {};
    if (!invoiceId) next.invoiceId = 'Pick an invoice';
    if (!isPositiveDecimalInput(amount))
      next.amount = 'Must be a positive number';
    if (Object.keys(next).length > 0) {
      setErrors(next);
      return;
    }
    setErrors({});
    startTransition(async () => {
      try {
        const res = await fetch(
          `/api/credit-memos/${creditMemoId}/apply`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              invoiceId,
              amount: normalizeDecimalForSubmit(amount),
            }),
          },
        );
        if (!res.ok) {
          toast.error(await readApiError(res));
          return;
        }
        toast.success(
          `Applied ${formatCurrency(amount)} from ${creditMemoNumber} to ${selectedInvoice?.number}.`,
        );
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
            Picks from this customer&apos;s open invoices (remaining
            balance &gt; 0). Application reduces both this credit&apos;s
            available and the invoice&apos;s remaining balance — no GL
            post (the JE happened when the credit was confirmed).
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-3">
          <Field>
            <FieldLabel htmlFor="apply-invoice">Invoice</FieldLabel>
            {loadingInvoices ? (
              <p className="text-sm text-muted-foreground">
                Loading invoices…
              </p>
            ) : loadError ? (
              <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
                {loadError}
              </div>
            ) : invoices.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No open invoices for this customer.
              </p>
            ) : (
              <Select
                value={invoiceId}
                onValueChange={(v) => setInvoiceId(v ?? '')}
              >
                <SelectTrigger
                  id="apply-invoice"
                  className="w-full"
                  aria-invalid={!!errors.invoiceId}
                >
                  <SelectValue placeholder="Pick an invoice">
                    {(v) => {
                      if (!v) return null;
                      const inv = invoices.find((x) => x.id === v);
                      if (!inv) return v;
                      return (
                        <>
                          <span className="font-mono text-xs text-muted-foreground">
                            {inv.number}
                          </span>{' '}
                          · remaining {formatCurrency(inv.remaining.toFixed(2))}
                        </>
                      );
                    }}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {invoices.map((inv) => (
                    <SelectItem key={inv.id} value={inv.id}>
                      <span className="font-mono text-xs text-muted-foreground">
                        {inv.number}
                      </span>{' '}
                      · remaining {formatCurrency(inv.remaining.toFixed(2))}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
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
              errors={[
                errors.amount ? { message: errors.amount } : undefined,
              ]}
            />
            {selectedInvoice ? (
              <p className="text-xs text-muted-foreground">
                Invoice remaining:{' '}
                {formatCurrency(selectedInvoice.remaining.toFixed(2))}
                {' · '}Credit available: {formatCurrency(available)}
              </p>
            ) : null}
          </Field>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={submit}
            disabled={pending || loadingInvoices || invoices.length === 0}
          >
            {pending ? 'Applying…' : 'Apply'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
