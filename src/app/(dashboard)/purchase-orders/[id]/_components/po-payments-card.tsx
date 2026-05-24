'use client';

import { useEffect, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { DollarSign, MoreVertical, Undo2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { formatCurrency, formatStatusLabel } from '@/lib/format';
import { isPositiveDecimalInput, normalizeDecimalForSubmit } from '@/lib/decimal-input';

export type CashAccountOption = { id: string; code: string; name: string };

export type PoPaymentApplicationRow = {
  id: string;
  billId: string;
  billNumber: string;
  amount: string;
};

export type PoPaymentRow = {
  id: string;
  number: string;
  paymentDate: Date;
  amount: string;
  method: string | null;
  status: string;
  reference: string | null;
  cashAccountCode: string | null;
  cashAccountName: string | null;
  appliedAmount: string;
  reversedReason: string | null;
  applications: PoPaymentApplicationRow[];
};

const METHODS: Array<{ value: string; label: string }> = [
  { value: 'WIRE', label: 'Wire' },
  { value: 'ACH', label: 'ACH' },
  { value: 'CHECK', label: 'Check' },
  { value: 'CREDIT_CARD', label: 'Credit card' },
  { value: 'CASH', label: 'Cash' },
  { value: 'MONEY_ORDER', label: 'Money order' },
];

function formatMethod(value: string | null): string {
  if (!value) return '—';
  if (value === 'CREDIT_CARD') return 'Credit card';
  if (value === 'MONEY_ORDER') return 'Money order';
  return value.charAt(0) + value.slice(1).toLowerCase();
}

function formatDate(d: Date): string {
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

async function readApiError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as {
      error?: string;
      issues?: Array<{ path?: Array<string | number>; message?: string }>;
    };
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

export function PoPaymentsCard({
  purchaseOrderId,
  canRecord,
  poTotal,
  totalPaid,
  balance,
  cashAccounts,
  payments,
}: {
  purchaseOrderId: string;
  canRecord: boolean;
  currency: string;
  poTotal: string;
  totalPaid: string;
  balance: string;
  cashAccounts: CashAccountOption[];
  payments: PoPaymentRow[];
}) {
  const [recordOpen, setRecordOpen] = useState(false);
  const [voiding, setVoiding] = useState<PoPaymentRow | null>(null);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="text-sm">Payments / deposits</CardTitle>
        {canRecord ? (
          <Button size="sm" onClick={() => setRecordOpen(true)}>
            <DollarSign />
            Record payment
          </Button>
        ) : null}
      </CardHeader>

      {/* Summary strip: PO Total | Total Paid | Balance Remaining */}
      <div className="mx-6 mb-2 grid grid-cols-3 gap-2 rounded-md border border-border bg-muted/20 p-3 text-sm">
        <Summary label="PO total" value={formatCurrency(poTotal)} />
        <Summary label="Total paid" value={formatCurrency(totalPaid)} />
        <Summary
          label="Balance remaining"
          value={formatCurrency(balance)}
          emphasize
        />
      </div>

      <CardContent className="px-0">
        {payments.length === 0 ? (
          <p className="px-6 text-sm text-muted-foreground">
            No deposits recorded yet.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/30 hover:bg-muted/30">
                <TableHead className="pl-6">Payment #</TableHead>
                <TableHead>Date</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Method</TableHead>
                <TableHead>Reference</TableHead>
                <TableHead>GL account</TableHead>
                <TableHead>Applied</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="pr-6 w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {payments.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="pl-6 font-mono text-xs">
                    {p.number}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDate(p.paymentDate)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatCurrency(p.amount)}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatMethod(p.method)}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {p.reference ?? '—'}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {p.cashAccountCode ? (
                      <div className="flex flex-col leading-tight">
                        <span>{p.cashAccountCode}</span>
                        {p.cashAccountName ? (
                          <span className="font-sans text-[10px]">
                            {p.cashAccountName}
                          </span>
                        ) : null}
                      </div>
                    ) : (
                      '—'
                    )}
                  </TableCell>
                  <TableCell className="text-xs">
                    <AppliedCell payment={p} />
                  </TableCell>
                  <TableCell>
                    <PaymentStatusBadge status={p.status} />
                    {p.status === 'REVERSED' && p.reversedReason ? (
                      <div
                        className="mt-0.5 max-w-[16ch] truncate text-[10px] text-muted-foreground"
                        title={p.reversedReason}
                      >
                        {p.reversedReason}
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell className="pr-6">
                    {p.status === 'RECORDED' ? (
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`Actions for ${p.number}`}
                            />
                          }
                        >
                          <MoreVertical />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            variant="destructive"
                            onClick={(e) => {
                              e.preventDefault();
                              setVoiding(p);
                            }}
                          >
                            <Undo2 className="size-4" />
                            Void / reverse
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>

      <RecordPoPaymentDialog
        purchaseOrderId={purchaseOrderId}
        balance={balance}
        cashAccounts={cashAccounts}
        open={recordOpen}
        onOpenChange={setRecordOpen}
      />
      <VoidPaymentDialog
        purchaseOrderId={purchaseOrderId}
        payment={voiding}
        onClose={() => setVoiding(null)}
      />
    </Card>
  );
}

function Summary({
  label,
  value,
  emphasize,
}: {
  label: string;
  value: string;
  emphasize?: boolean;
}) {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span className={`tabular-nums ${emphasize ? 'font-semibold' : ''}`}>
        {value}
      </span>
    </div>
  );
}

function AppliedCell({ payment }: { payment: PoPaymentRow }) {
  if (payment.status === 'REVERSED') {
    return <span className="text-muted-foreground">—</span>;
  }
  if (payment.applications.length === 0) {
    return <span className="text-muted-foreground">Unapplied</span>;
  }
  return (
    <div className="flex flex-col gap-0.5">
      {payment.applications.map((a) => (
        <Link
          key={a.id}
          href={`/bills/${a.billId}`}
          className="font-mono underline-offset-2 hover:underline"
        >
          {a.billNumber}{' '}
          <span className="text-muted-foreground">
            ({formatCurrency(a.amount)})
          </span>
        </Link>
      ))}
    </div>
  );
}

function PaymentStatusBadge({ status }: { status: string }) {
  const label = formatStatusLabel(status);
  if (status === 'RECORDED') return <Badge variant="secondary">{label}</Badge>;
  return (
    <Badge variant="outline" className="text-muted-foreground">
      {label}
    </Badge>
  );
}

function RecordPoPaymentDialog({
  purchaseOrderId,
  balance,
  cashAccounts,
  open,
  onOpenChange,
}: {
  purchaseOrderId: string;
  // PO balance (total − recorded deposits), decimal string.
  balance: string;
  cashAccounts: CashAccountOption[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('WIRE');
  const [cashAccountId, setCashAccountId] = useState('');
  const [paymentDate, setPaymentDate] = useState('');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [errors, setErrors] = useState<Partial<Record<string, string>>>({});

  useEffect(() => {
    if (!open) return;
    setErrors({});
    // Pre-fill with the remaining balance (paying the PO off) when there's
    // one; leave blank if already settled. The operator can change it.
    setAmount(Number(balance) > 0 ? balance : '');
    setMethod('WIRE');
    setCashAccountId(cashAccounts[0]?.id ?? '');
    setPaymentDate(new Date().toISOString().slice(0, 10));
    setReference('');
    setNotes('');
  }, [open, cashAccounts, balance]);

  // Display-only running figures (the service does the authoritative Decimal
  // math on submit). amtN is null until a valid positive amount is typed.
  const balanceN = Number(balance);
  const amtN = isPositiveDecimalInput(amount) ? Number(amount) : null;
  const afterBalance = amtN != null ? balanceN - amtN : null;
  const overpaying = amtN != null && Number.isFinite(balanceN) && amtN > balanceN;

  function submit() {
    const next: Partial<Record<string, string>> = {};
    if (!isPositiveDecimalInput(amount)) next.amount = 'Must be a positive number';
    if (!cashAccountId) next.cashAccountId = 'Pick a GL account';
    if (Object.keys(next).length > 0) {
      setErrors(next);
      return;
    }
    setErrors({});
    const payload = {
      amount: normalizeDecimalForSubmit(amount),
      method,
      cashAccountId,
      paymentDate: paymentDate || undefined,
      reference: reference.trim() || null,
      notes: notes.trim() || null,
    };
    startTransition(async () => {
      try {
        const res = await fetch(
          `/api/purchase-orders/${purchaseOrderId}/payments`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          },
        );
        if (!res.ok) {
          toast.error(await readApiError(res));
          return;
        }
        const result = (await res.json()) as {
          poPayment: { number: string; amount: string };
        };
        toast.success(
          `Recorded ${result.poPayment.number} for ${formatCurrency(
            result.poPayment.amount,
          )}.`,
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
          <AlertDialogTitle>Record PO payment</AlertDialogTitle>
          <AlertDialogDescription>
            Posts a deposit JE (DR 1510 Vendor Deposits / CR the selected
            account). The deposit auto-applies to the vendor bill when goods
            are received against this PO.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-3">
          <div className="flex items-center justify-between rounded-md border border-border bg-muted/30 px-3 py-2">
            <span className="text-sm text-muted-foreground">PO Balance</span>
            <span className="text-base font-semibold tabular-nums">
              {formatCurrency(balance)}
            </span>
          </div>

          <Field>
            <FieldLabel htmlFor="dep-amount">Amount</FieldLabel>
            <Input
              id="dep-amount"
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
                <span className="tabular-nums">{formatCurrency(afterBalance)}</span>
              </p>
            ) : null}
            {overpaying ? (
              <p className="text-xs text-amber-600">
                Overpaying by {formatCurrency(amtN! - balanceN)} — the excess
                sits as a prepaid balance on this PO.
              </p>
            ) : null}
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field>
              <FieldLabel htmlFor="dep-method">Method</FieldLabel>
              <Select value={method} onValueChange={(v) => setMethod(v ?? 'WIRE')}>
                <SelectTrigger id="dep-method" className="w-full">
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
              <FieldLabel htmlFor="dep-date">Date</FieldLabel>
              <Input
                id="dep-date"
                type="date"
                value={paymentDate}
                onChange={(e) => setPaymentDate(e.target.value)}
              />
            </Field>
          </div>

          <Field>
            <FieldLabel htmlFor="dep-account">GL account</FieldLabel>
            <Select
              value={cashAccountId}
              onValueChange={(v) => setCashAccountId(v ?? '')}
            >
              <SelectTrigger
                id="dep-account"
                className="w-full"
                aria-invalid={!!errors.cashAccountId}
              >
                <SelectValue placeholder="Pick a cash or credit-card account">
                  {(v) => {
                    if (!v) return null;
                    const a = cashAccounts.find((x) => x.id === v);
                    if (!a) return v;
                    return (
                      <>
                        <span className="font-mono text-xs text-muted-foreground">
                          {a.code}
                        </span>{' '}
                        {a.name}
                      </>
                    );
                  }}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {cashAccounts.length === 0 ? (
                  <div className="px-2 py-1.5 text-xs text-muted-foreground">
                    No cash/bank or credit-card accounts configured — set one
                    up under Admin → GL accounts first.
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
              errors={[
                errors.cashAccountId
                  ? { message: errors.cashAccountId }
                  : undefined,
              ]}
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="dep-reference">
              Reference (check #, wire ref, transaction ID…)
            </FieldLabel>
            <Input
              id="dep-reference"
              placeholder="optional"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="dep-notes">Notes</FieldLabel>
            <Textarea
              id="dep-notes"
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

function VoidPaymentDialog({
  purchaseOrderId,
  payment,
  onClose,
}: {
  purchaseOrderId: string;
  payment: PoPaymentRow | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const isApplied = payment != null && Number(payment.appliedAmount) > 0;

  function onVoid() {
    if (!payment) return;
    setError(null);
    if (reason.trim().length === 0) {
      setError('Reason is required');
      return;
    }
    startTransition(async () => {
      try {
        const res = await fetch(
          `/api/purchase-orders/${purchaseOrderId}/payments/${payment.id}`,
          {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason: reason.trim() }),
          },
        );
        if (!res.ok) {
          toast.error(await readApiError(res));
          return;
        }
        toast.success(`Voided ${payment.number}`);
        onClose();
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Network error');
      }
    });
  }

  return (
    <AlertDialog
      open={payment != null}
      onOpenChange={(o) => {
        if (!o) {
          setReason('');
          setError(null);
          onClose();
        }
      }}
    >
      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>Void this deposit?</AlertDialogTitle>
          <AlertDialogDescription>
            Posts a reversing JE (DR cash / CR 1510) and marks the deposit
            reversed.
            {isApplied
              ? ' This deposit has been applied to a bill — the application is unwound first (the bill balance is restored) in the same transaction.'
              : ''}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <Field>
          <FieldLabel htmlFor="void-reason">Reason</FieldLabel>
          <Textarea
            id="void-reason"
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. deposit refunded, recorded in error, wrong PO"
            aria-invalid={!!error}
          />
          {error ? <FieldError errors={[{ message: error }]} /> : null}
        </Field>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Keep deposit</AlertDialogCancel>
          <AlertDialogAction
            onClick={onVoid}
            disabled={pending}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {pending ? 'Voiding…' : 'Void deposit'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
