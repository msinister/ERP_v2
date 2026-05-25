'use client';

import { useState, useTransition } from 'react';
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
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Field, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatCurrency } from '@/lib/format';
import {
  isPositiveDecimalInput,
  normalizeDecimalForSubmit,
} from '@/lib/decimal-input';

// "Available on account" — unapplied customer payments + confirmed credit
// memos with a remaining balance, each applyable to THIS order's invoice.
// Decimals arrive as on-disk strings; formatCurrency handles them.

export type AvailablePaymentRow = {
  id: string;
  number: string;
  date: string; // ISO
  method: string;
  total: string;
  unapplied: string;
};

export type AvailableCreditMemoRow = {
  id: string;
  number: string;
  date: string; // ISO
  categoryLabel: string;
  total: string;
  available: string;
};

type ApplyTarget = {
  kind: 'PAYMENT' | 'CREDIT_MEMO';
  id: string;
  number: string;
  available: string;
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

export function AvailableFundsCard({
  invoiceId,
  invoiceNumber,
  invoiceBalance,
  payments,
  creditMemos,
}: {
  invoiceId: string;
  invoiceNumber: string;
  invoiceBalance: string;
  payments: AvailablePaymentRow[];
  creditMemos: AvailableCreditMemoRow[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [target, setTarget] = useState<ApplyTarget | null>(null);
  const [amount, setAmount] = useState('');
  const [amountError, setAmountError] = useState<string | null>(null);

  function openApply(t: ApplyTarget) {
    // Pre-fill the lesser of (available, invoice balance).
    const cap = Math.min(Number(t.available) || 0, Number(invoiceBalance) || 0);
    setAmount(cap > 0 ? cap.toFixed(2) : '');
    setAmountError(null);
    setTarget(t);
  }

  function submit() {
    if (!target) return;
    if (!isPositiveDecimalInput(amount)) {
      setAmountError('Must be a positive number');
      return;
    }
    setAmountError(null);
    const url =
      target.kind === 'PAYMENT'
        ? `/api/payments/${target.id}/apply`
        : `/api/credit-memos/${target.id}/apply`;
    startTransition(async () => {
      try {
        const res = await fetch(url, {
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
        toast.success(
          `Applied ${formatCurrency(amount)} from ${target.number} to ${invoiceNumber}.`,
        );
        setTarget(null);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Network error');
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Available on account</CardTitle>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Unapplied payments and credit memos you can apply to invoice{' '}
          <span className="font-mono">{invoiceNumber}</span>.
        </p>
      </CardHeader>
      <CardContent className="space-y-4 px-0">
        {payments.length > 0 ? (
          <div>
            <div className="px-6 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Unapplied payments
            </div>
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/30 hover:bg-muted/30">
                  <TableHead className="pl-6">Payment</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Method</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead className="text-right">Unapplied</TableHead>
                  <TableHead className="pr-6 text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {payments.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="pl-6 font-mono text-xs">
                      {p.number}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDate(p.date)}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatMethod(p.method)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {formatCurrency(p.total)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums font-medium">
                      {formatCurrency(p.unapplied)}
                    </TableCell>
                    <TableCell className="pr-6 text-right">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          openApply({
                            kind: 'PAYMENT',
                            id: p.id,
                            number: p.number,
                            available: p.unapplied,
                          })
                        }
                      >
                        Apply
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : null}

        {creditMemos.length > 0 ? (
          <div>
            <div className="px-6 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Available credit memos
            </div>
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/30 hover:bg-muted/30">
                  <TableHead className="pl-6">Credit memo</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead className="text-right">Available</TableHead>
                  <TableHead className="pr-6 text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {creditMemos.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell className="pl-6 font-mono text-xs">
                      {c.number}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDate(c.date)}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {c.categoryLabel}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {formatCurrency(c.total)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums font-medium">
                      {formatCurrency(c.available)}
                    </TableCell>
                    <TableCell className="pr-6 text-right">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          openApply({
                            kind: 'CREDIT_MEMO',
                            id: c.id,
                            number: c.number,
                            available: c.available,
                          })
                        }
                      >
                        Apply
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : null}
      </CardContent>

      <AlertDialog
        open={target != null}
        onOpenChange={(o) => {
          if (!o) setTarget(null);
        }}
      >
        <AlertDialogContent className="sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>
              Apply {target?.kind === 'CREDIT_MEMO' ? 'credit memo' : 'payment'}{' '}
              {target?.number}
            </AlertDialogTitle>
            <AlertDialogDescription>
              Applies to invoice{' '}
              <span className="font-mono">{invoiceNumber}</span> (balance{' '}
              {formatCurrency(invoiceBalance)}).
              {target?.kind === 'CREDIT_MEMO'
                ? ' No GL post — the JE happened when the credit was confirmed.'
                : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Field>
            <FieldLabel htmlFor="apply-funds-amount">Amount</FieldLabel>
            <Input
              id="apply-funds-amount"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              aria-invalid={!!amountError}
            />
            <FieldError
              errors={[amountError ? { message: amountError } : undefined]}
            />
            {target ? (
              <p className="text-xs text-muted-foreground">
                Available: {formatCurrency(target.available)} · Invoice balance:{' '}
                {formatCurrency(invoiceBalance)}
              </p>
            ) : null}
          </Field>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={submit} disabled={pending}>
              {pending ? 'Applying…' : 'Apply'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

function formatMethod(value: string): string {
  if (value === 'CREDIT_CARD') return 'Credit card';
  if (value === 'MONEY_ORDER') return 'Money order';
  if (value === 'APPLIED_CREDIT') return 'Applied credit';
  return value.charAt(0) + value.slice(1).toLowerCase();
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}
