'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
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

// VC-side apply dialog. Operator picks one of the vendor's CONFIRMED
// bills with remaining > 0 and an amount up to the smaller of
// (vc.available, bill.remaining).

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

type OpenBill = {
  id: string;
  number: string;
  total: string;
  amountPaid: string;
  amountCredited: string;
  remaining: number;
  billDate: string;
};

export function ApplyToBillDialog({
  vendorCreditId,
  vendorCreditNumber,
  vendorId,
  available,
  open,
  onOpenChange,
}: {
  vendorCreditId: string;
  vendorCreditNumber: string;
  vendorId: string;
  // String (Decimal-as-string) — the VC's remaining balance.
  available: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [loadingBills, setLoadingBills] = useState(false);
  const [bills, setBills] = useState<OpenBill[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [billId, setBillId] = useState('');
  const [amount, setAmount] = useState('');
  const [notes, setNotes] = useState('');
  const [errors, setErrors] = useState<Partial<Record<string, string>>>({});

  // Fetch the vendor's CONFIRMED bills on dialog open. We pull all
  // CONFIRMED for the vendor and filter client-side to those with
  // remaining > 0 — avoids fetching twice (UNPAID + PARTIAL) since
  // the API only accepts one paymentStatus at a time.
  useEffect(() => {
    if (!open) return;
    setErrors({});
    setBillId('');
    setAmount('');
    setNotes('');
    setLoadError(null);
    setBills([]);
    setLoadingBills(true);
    const params = new URLSearchParams({
      vendorId,
      status: 'CONFIRMED',
      take: '500',
    });
    fetch(`/api/bills?${params.toString()}`)
      .then(async (res) => {
        if (!res.ok) {
          setLoadError(await readApiError(res));
          return;
        }
        const body = (await res.json()) as {
          rows: Array<{
            id: string;
            number: string;
            total: string;
            amountPaid: string;
            amountCredited: string;
            billDate: string;
          }>;
        };
        const open = body.rows
          .map((b) => {
            const remaining =
              Number(b.total) -
              Number(b.amountPaid) -
              Number(b.amountCredited);
            return {
              id: b.id,
              number: b.number,
              total: b.total,
              amountPaid: b.amountPaid,
              amountCredited: b.amountCredited,
              remaining,
              billDate: b.billDate,
            };
          })
          .filter((b) => b.remaining > 0)
          // Oldest bills first — match AR/AP convention of paying down
          // the oldest open balance.
          .sort((a, b) => a.billDate.localeCompare(b.billDate));
        setBills(open);
      })
      .catch((err) => {
        setLoadError(err instanceof Error ? err.message : 'Network error');
      })
      .finally(() => setLoadingBills(false));
  }, [open, vendorId]);

  const selectedBill = useMemo(
    () => bills.find((b) => b.id === billId) ?? null,
    [bills, billId],
  );
  useEffect(() => {
    if (!selectedBill) {
      setAmount('');
      return;
    }
    const cap = Math.min(selectedBill.remaining, Number(available) || 0);
    if (cap > 0) setAmount(cap.toFixed(2));
  }, [selectedBill, available]);

  function submit() {
    const next: Partial<Record<string, string>> = {};
    if (!billId) next.billId = 'Pick a bill';
    if (!POSITIVE_DECIMAL_RE.test(amount))
      next.amount = 'Must be a positive number';
    else if (Number(amount) <= 0) next.amount = 'Must be greater than 0';
    if (Object.keys(next).length > 0) {
      setErrors(next);
      return;
    }
    setErrors({});
    startTransition(async () => {
      try {
        const res = await fetch(
          `/api/vendor-credits/${vendorCreditId}/apply`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              billId,
              amount,
              notes: notes.trim() || undefined,
            }),
          },
        );
        if (!res.ok) {
          toast.error(await readApiError(res));
          return;
        }
        toast.success(
          `Applied ${formatCurrency(amount)} from ${vendorCreditNumber} to ${selectedBill?.number}.`,
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
          <AlertDialogTitle>Apply to bill</AlertDialogTitle>
          <AlertDialogDescription>
            Picks from this vendor&apos;s open CONFIRMED bills (remaining
            balance &gt; 0). Application reduces both this credit&apos;s
            available and the bill&apos;s remaining balance — no GL post
            (the JE happened when the credit was confirmed).
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-3">
          <Field>
            <FieldLabel htmlFor="apply-bill">Bill</FieldLabel>
            {loadingBills ? (
              <p className="text-sm text-muted-foreground">Loading bills…</p>
            ) : loadError ? (
              <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
                {loadError}
              </div>
            ) : bills.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No open CONFIRMED bills for this vendor.
              </p>
            ) : (
              <Select value={billId} onValueChange={(v) => setBillId(v ?? '')}>
                <SelectTrigger
                  id="apply-bill"
                  className="w-full"
                  aria-invalid={!!errors.billId}
                >
                  <SelectValue placeholder="Pick a bill" />
                </SelectTrigger>
                <SelectContent>
                  {bills.map((b) => (
                    <SelectItem key={b.id} value={b.id}>
                      <span className="font-mono text-xs text-muted-foreground">
                        {b.number}
                      </span>{' '}
                      · remaining {formatCurrency(b.remaining.toFixed(2))}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <FieldError
              errors={[errors.billId ? { message: errors.billId } : undefined]}
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
            {selectedBill ? (
              <p className="text-xs text-muted-foreground">
                Bill remaining:{' '}
                {formatCurrency(selectedBill.remaining.toFixed(2))}
                {' · '}Credit available: {formatCurrency(available)}
              </p>
            ) : null}
          </Field>

          <Field>
            <FieldLabel htmlFor="apply-notes">Notes</FieldLabel>
            <Textarea
              id="apply-notes"
              rows={2}
              placeholder="optional"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </Field>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={submit}
            disabled={pending || loadingBills || bills.length === 0}
          >
            {pending ? 'Applying…' : 'Apply'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
