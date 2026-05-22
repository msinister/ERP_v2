'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  VendorPicker,
  type VendorPickerOption,
  type PaymentTermOption,
} from '@/components/shared/vendor-picker';
import {
  isPositiveDecimalInput,
  normalizeDecimalForSubmit,
} from '@/lib/decimal-input';
import {
  LAST_PAYMENT_ACCOUNT_KEY,
  type AccountOption,
  type CategoryOption,
} from './types';

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

export function ExpenseSingleEntry({
  vendors,
  paymentTerms,
  categories,
  paymentAccounts,
}: {
  vendors: VendorPickerOption[];
  paymentTerms: PaymentTermOption[];
  categories: CategoryOption[];
  paymentAccounts: AccountOption[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [vendorsState, setVendorsState] =
    useState<VendorPickerOption[]>(vendors);
  const [vendorId, setVendorId] = useState<string>('');
  const [date, setDate] = useState<string>(todayStr());
  const [amount, setAmount] = useState<string>('');
  const [categoryId, setCategoryId] = useState<string>(
    categories[0]?.id ?? '',
  );
  const [paymentAccountId, setPaymentAccountId] = useState<string>(
    paymentAccounts[0]?.id ?? '',
  );
  const [notes, setNotes] = useState<string>('');
  const [errors, setErrors] = useState<Partial<Record<string, string>>>({});

  // Restore the last-used payment account on mount (client-only — avoids
  // an SSR/CSR mismatch by keeping the initial render deterministic).
  useEffect(() => {
    const saved = window.localStorage.getItem(LAST_PAYMENT_ACCOUNT_KEY);
    if (saved && paymentAccounts.some((a) => a.id === saved)) {
      setPaymentAccountId(saved);
    }
  }, [paymentAccounts]);

  const categoryLabel = useMemo(() => {
    const map = new Map(categories.map((c) => [c.id, `${c.code} ${c.name}`]));
    return (id: string) => map.get(id) ?? id;
  }, [categories]);
  const accountLabel = useMemo(() => {
    const map = new Map(
      paymentAccounts.map((a) => [a.id, `${a.code} ${a.name}`]),
    );
    return (id: string) => map.get(id) ?? id;
  }, [paymentAccounts]);

  function validate(): boolean {
    const next: Partial<Record<string, string>> = {};
    if (!vendorId) next.vendorId = 'Pick a vendor';
    if (amount.trim() === '') next.amount = 'Required';
    else if (!isPositiveDecimalInput(amount)) next.amount = 'Must be > 0';
    if (!categoryId) next.categoryId = 'Pick a category';
    if (!paymentAccountId) next.paymentAccountId = 'Pick an account';
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  function submit() {
    if (!validate()) return;
    startTransition(async () => {
      try {
        const res = await fetch('/api/expenses', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            vendorId,
            amount: normalizeDecimalForSubmit(amount),
            expenseAccountId: categoryId,
            paymentAccountId,
            date,
            notes: notes.trim() || undefined,
          }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          toast.error(body.error ?? `Log failed (${res.status})`);
          return;
        }
        const created = (await res.json()) as { billNumber: string };
        window.localStorage.setItem(LAST_PAYMENT_ACCOUNT_KEY, paymentAccountId);
        toast.success(`Logged ${created.billNumber}`);
        // Reset the per-entry fields; keep date + payment account so
        // repeated entries stay fast.
        setVendorId('');
        setAmount('');
        setNotes('');
        setErrors({});
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Network error');
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Log an expense</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-12">
          <div className="md:col-span-2">
            <Field>
              <FieldLabel htmlFor="exp-date">Date</FieldLabel>
              <Input
                id="exp-date"
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </Field>
          </div>

          <div className="md:col-span-3">
            <Field>
              <FieldLabel htmlFor="exp-vendor">Vendor</FieldLabel>
              <VendorPicker
                id="exp-vendor"
                value={vendorId || null}
                onValueChange={(v) => setVendorId(v ?? '')}
                vendors={vendorsState}
                paymentTerms={paymentTerms}
                onCreated={(created) =>
                  setVendorsState((prev) =>
                    prev.some((v) => v.id === created.id)
                      ? prev
                      : [
                          ...prev,
                          {
                            id: created.id,
                            code: created.code,
                            name: created.name,
                          },
                        ],
                  )
                }
                ariaInvalid={!!errors.vendorId}
                placeholder="Search vendors…"
              />
              <FieldError
                errors={[
                  errors.vendorId ? { message: errors.vendorId } : undefined,
                ]}
              />
            </Field>
          </div>

          <div className="md:col-span-1">
            <Field>
              <FieldLabel htmlFor="exp-amount">Amount</FieldLabel>
              <Input
                id="exp-amount"
                inputMode="decimal"
                placeholder="0.00"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                aria-invalid={!!errors.amount}
              />
              <FieldError
                errors={[
                  errors.amount ? { message: errors.amount } : undefined,
                ]}
              />
            </Field>
          </div>

          <div className="md:col-span-2">
            <Field>
              <FieldLabel htmlFor="exp-category">Category</FieldLabel>
              <Select
                value={categoryId}
                onValueChange={(v) => setCategoryId(v ?? '')}
              >
                <SelectTrigger
                  id="exp-category"
                  className="w-full"
                  aria-invalid={!!errors.categoryId}
                >
                  <SelectValue placeholder="Pick…">
                    {(v) => (v ? categoryLabel(v) : 'Pick…')}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {categories.length === 0 ? (
                    <div className="px-2 py-1.5 text-xs text-muted-foreground">
                      No expense accounts configured.
                    </div>
                  ) : (
                    categories.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        <span className="font-mono text-xs text-muted-foreground">
                          {c.code}
                        </span>{' '}
                        {c.name}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
              <FieldError
                errors={[
                  errors.categoryId
                    ? { message: errors.categoryId }
                    : undefined,
                ]}
              />
            </Field>
          </div>

          <div className="md:col-span-2">
            <Field>
              <FieldLabel htmlFor="exp-account">Pay from</FieldLabel>
              <Select
                value={paymentAccountId}
                onValueChange={(v) => setPaymentAccountId(v ?? '')}
              >
                <SelectTrigger
                  id="exp-account"
                  className="w-full"
                  aria-invalid={!!errors.paymentAccountId}
                >
                  <SelectValue placeholder="Pick…">
                    {(v) => (v ? accountLabel(v) : 'Pick…')}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {paymentAccounts.length === 0 ? (
                    <div className="px-2 py-1.5 text-xs text-muted-foreground">
                      No cash/credit-card accounts configured.
                    </div>
                  ) : (
                    paymentAccounts.map((a) => (
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
                  errors.paymentAccountId
                    ? { message: errors.paymentAccountId }
                    : undefined,
                ]}
              />
            </Field>
          </div>

          <div className="flex items-end md:col-span-2">
            <Field className="w-full">
              <FieldLabel htmlFor="exp-notes">Notes</FieldLabel>
              <Input
                id="exp-notes"
                placeholder="Optional"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </Field>
          </div>
        </div>

        <div className="mt-3 flex justify-end">
          <Button size="sm" onClick={submit} disabled={pending}>
            <Plus />
            {pending ? 'Logging…' : 'Log'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
