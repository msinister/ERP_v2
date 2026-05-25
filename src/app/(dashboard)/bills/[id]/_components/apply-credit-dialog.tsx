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

// Bill-side apply dialog. Operator picks one of the vendor's CONFIRMED
// vendor credits with available > 0 and an amount up to the smaller of
// (vc.available, bill.remaining).
//
// Q4 from discovery: lazy-fetch the VC list on dialog open rather than
// pre-loading every CONFIRMED VC across the whole org server-side.

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

type AvailableCredit = {
  id: string;
  number: string;
  amount: string;
  appliedAmount: string;
  available: number;
  creditDate: string;
};

export function ApplyCreditDialog({
  billId,
  billNumber,
  vendorId,
  remainingBalance,
  open,
  onOpenChange,
}: {
  billId: string;
  billNumber: string;
  vendorId: string;
  remainingBalance: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [loadingCredits, setLoadingCredits] = useState(false);
  const [credits, setCredits] = useState<AvailableCredit[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [creditId, setCreditId] = useState('');
  const [amount, setAmount] = useState('');
  const [notes, setNotes] = useState('');
  const [errors, setErrors] = useState<Partial<Record<string, string>>>({});

  // Fetch the vendor's CONFIRMED VCs with available > 0 when the
  // dialog opens. The /api/vendor-credits endpoint returns paged rows
  // with appliedAmount, so we filter client-side for available > 0.
  useEffect(() => {
    if (!open) return;
    setErrors({});
    setCreditId('');
    setAmount('');
    setNotes('');
    setLoadError(null);
    setCredits([]);
    setLoadingCredits(true);
    const params = new URLSearchParams({
      vendorId,
      status: 'CONFIRMED',
      take: '500',
    });
    fetch(`/api/vendor-credits?${params.toString()}`)
      .then(async (res) => {
        if (!res.ok) {
          setLoadError(await readApiError(res));
          return;
        }
        const body = (await res.json()) as {
          rows: Array<{
            id: string;
            number: string;
            amount: string;
            appliedAmount: string;
            creditDate: string;
          }>;
        };
        const available = body.rows
          .map((r) => {
            const avail = Number(r.amount) - Number(r.appliedAmount);
            return {
              id: r.id,
              number: r.number,
              amount: r.amount,
              appliedAmount: r.appliedAmount,
              available: avail,
              creditDate: r.creditDate,
            };
          })
          .filter((r) => r.available > 0)
          // Surface oldest credits first so AP burns down stale balances.
          .sort((a, b) => a.creditDate.localeCompare(b.creditDate));
        setCredits(available);
      })
      .catch((err) => {
        setLoadError(err instanceof Error ? err.message : 'Network error');
      })
      .finally(() => setLoadingCredits(false));
  }, [open, vendorId]);

  // Pre-fill amount with min(selected.available, bill remaining)
  // whenever the operator picks a credit.
  const selectedCredit = useMemo(
    () => credits.find((c) => c.id === creditId) ?? null,
    [credits, creditId],
  );
  useEffect(() => {
    if (!selectedCredit) {
      setAmount('');
      return;
    }
    const cap = Math.min(
      selectedCredit.available,
      Number(remainingBalance) || 0,
    );
    if (cap > 0) setAmount(cap.toFixed(2));
  }, [selectedCredit, remainingBalance]);

  function submit() {
    const next: Partial<Record<string, string>> = {};
    if (!creditId) next.creditId = 'Pick a credit';
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
          `/api/vendor-credits/${creditId}/apply`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              billId,
              amount: normalizeDecimalForSubmit(amount),
              notes: notes.trim() || undefined,
            }),
          },
        );
        if (!res.ok) {
          toast.error(await readApiError(res));
          return;
        }
        toast.success(
          `Applied ${formatCurrency(amount)} from ${selectedCredit?.number} to ${billNumber}.`,
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
          <AlertDialogTitle>Apply vendor credit</AlertDialogTitle>
          <AlertDialogDescription>
            Picks from this vendor&apos;s CONFIRMED credits with available
            balance. Application reduces both the credit&apos;s available
            and the bill&apos;s remaining balance — no GL post (the JE
            happened when the credit was confirmed).
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-3">
          <Field>
            <FieldLabel htmlFor="apply-credit">Vendor credit</FieldLabel>
            {loadingCredits ? (
              <p className="text-sm text-muted-foreground">Loading credits…</p>
            ) : loadError ? (
              <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
                {loadError}
              </div>
            ) : credits.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No vendor credits with available balance for this vendor.
                Create one under{' '}
                <span className="font-mono">/vendor-credits/new</span>.
              </p>
            ) : (
              <Select
                value={creditId}
                onValueChange={(v) => setCreditId(v ?? '')}
              >
                <SelectTrigger
                  id="apply-credit"
                  className="w-full"
                  aria-invalid={!!errors.creditId}
                >
                  <SelectValue placeholder="Pick a vendor credit">
                    {(v) => {
                      if (!v) return null;
                      const c = credits.find((x) => x.id === v);
                      if (!c) return v;
                      return (
                        <>
                          <span className="font-mono text-xs text-muted-foreground">
                            {c.number}
                          </span>{' '}
                          · available {formatCurrency(c.available.toFixed(2))}
                        </>
                      );
                    }}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {credits.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      <span className="font-mono text-xs text-muted-foreground">
                        {c.number}
                      </span>{' '}
                      · available {formatCurrency(c.available.toFixed(2))}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <FieldError
              errors={[errors.creditId ? { message: errors.creditId } : undefined]}
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
            {selectedCredit ? (
              <p className="text-xs text-muted-foreground">
                Credit available:{' '}
                {formatCurrency(selectedCredit.available.toFixed(2))}
                {' · '}Bill remaining: {formatCurrency(remainingBalance)}
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
            disabled={pending || loadingCredits || credits.length === 0}
          >
            {pending ? 'Applying…' : 'Apply credit'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
