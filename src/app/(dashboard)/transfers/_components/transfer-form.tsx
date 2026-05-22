'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { ArrowRight, CreditCard, Landmark } from 'lucide-react';
import { AccountType } from '@/generated/tenant';
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
  isPositiveDecimalInput,
  normalizeDecimalForSubmit,
} from '@/lib/decimal-input';
import type { TransferAccountOption } from './types';

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

export function TransferForm({
  accounts,
}: {
  accounts: TransferAccountOption[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [fromAccountId, setFromAccountId] = useState('');
  const [toAccountId, setToAccountId] = useState('');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(todayStr());
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [errors, setErrors] = useState<Partial<Record<string, string>>>({});

  const accountLabel = useMemo(() => {
    const map = new Map(accounts.map((a) => [a.id, `${a.code} ${a.name}`]));
    return (id: string) => map.get(id) ?? id;
  }, [accounts]);

  // Convenience presets — just pre-fill the selects, the operator can
  // change anything before posting.
  const assets = useMemo(
    () => accounts.filter((a) => a.type === AccountType.ASSET),
    [accounts],
  );
  const liabilities = useMemo(
    () => accounts.filter((a) => a.type === AccountType.LIABILITY),
    [accounts],
  );
  const canPayCard = assets.length >= 1 && liabilities.length >= 1;
  const canBankTransfer = assets.length >= 2;

  function applyPreset(from: string, to: string) {
    setFromAccountId(from);
    setToAccountId(to);
    setErrors({});
  }

  function validate(): boolean {
    const next: Partial<Record<string, string>> = {};
    if (!fromAccountId) next.fromAccountId = 'Pick an account';
    if (!toAccountId) next.toAccountId = 'Pick an account';
    if (fromAccountId && toAccountId && fromAccountId === toAccountId) {
      next.toAccountId = 'Must differ from "From"';
    }
    if (amount.trim() === '') next.amount = 'Required';
    else if (!isPositiveDecimalInput(amount)) next.amount = 'Must be > 0';
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  function submit() {
    if (!validate()) return;
    startTransition(async () => {
      try {
        const res = await fetch('/api/transfers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fromAccountId,
            toAccountId,
            amount: normalizeDecimalForSubmit(amount),
            date,
            reference: reference.trim() || undefined,
            notes: notes.trim() || undefined,
          }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          toast.error(body.error ?? `Transfer failed (${res.status})`);
          return;
        }
        const created = (await res.json()) as { number: string };
        toast.success(`Posted ${created.number}`);
        // Keep accounts + date for fast repeats; clear the rest.
        setAmount('');
        setReference('');
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
        <CardTitle className="text-sm">Post a transfer</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {canPayCard || canBankTransfer ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">Quick start:</span>
            {canPayCard ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => applyPreset(assets[0].id, liabilities[0].id)}
              >
                <CreditCard />
                Pay credit card
              </Button>
            ) : null}
            {canBankTransfer ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => applyPreset(assets[0].id, assets[1].id)}
              >
                <Landmark />
                Bank transfer
              </Button>
            ) : null}
          </div>
        ) : null}

        <div className="grid grid-cols-1 gap-3 md:grid-cols-12 md:items-end">
          <div className="md:col-span-3">
            <Field>
              <FieldLabel htmlFor="tr-from">From account</FieldLabel>
              <Select
                value={fromAccountId}
                onValueChange={(v) => setFromAccountId(v ?? '')}
              >
                <SelectTrigger
                  id="tr-from"
                  className="w-full"
                  aria-invalid={!!errors.fromAccountId}
                >
                  <SelectValue placeholder="Pick…">
                    {(v) => (v ? accountLabel(v) : 'Pick…')}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <AccountItems accounts={accounts} />
                </SelectContent>
              </Select>
              <FieldError
                errors={[
                  errors.fromAccountId
                    ? { message: errors.fromAccountId }
                    : undefined,
                ]}
              />
            </Field>
          </div>

          <div className="hidden items-center justify-center pb-2 md:col-span-1 md:flex">
            <ArrowRight className="size-4 text-muted-foreground" />
          </div>

          <div className="md:col-span-3">
            <Field>
              <FieldLabel htmlFor="tr-to">To account</FieldLabel>
              <Select
                value={toAccountId}
                onValueChange={(v) => setToAccountId(v ?? '')}
              >
                <SelectTrigger
                  id="tr-to"
                  className="w-full"
                  aria-invalid={!!errors.toAccountId}
                >
                  <SelectValue placeholder="Pick…">
                    {(v) => (v ? accountLabel(v) : 'Pick…')}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <AccountItems accounts={accounts} />
                </SelectContent>
              </Select>
              <FieldError
                errors={[
                  errors.toAccountId
                    ? { message: errors.toAccountId }
                    : undefined,
                ]}
              />
            </Field>
          </div>

          <div className="md:col-span-2">
            <Field>
              <FieldLabel htmlFor="tr-amount">Amount</FieldLabel>
              <Input
                id="tr-amount"
                inputMode="decimal"
                placeholder="0.00"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                aria-invalid={!!errors.amount}
              />
              <FieldError
                errors={[errors.amount ? { message: errors.amount } : undefined]}
              />
            </Field>
          </div>

          <div className="md:col-span-3">
            <Field>
              <FieldLabel htmlFor="tr-date">Date</FieldLabel>
              <Input
                id="tr-date"
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </Field>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-12">
          <div className="md:col-span-4">
            <Field>
              <FieldLabel htmlFor="tr-reference">
                Reference (optional)
              </FieldLabel>
              <Input
                id="tr-reference"
                placeholder="Check #, confirmation #…"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
              />
            </Field>
          </div>
          <div className="md:col-span-8">
            <Field>
              <FieldLabel htmlFor="tr-notes">Notes (optional)</FieldLabel>
              <Input
                id="tr-notes"
                placeholder="Optional memo"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </Field>
          </div>
        </div>

        <div className="flex justify-end">
          <Button size="sm" onClick={submit} disabled={pending}>
            {pending ? 'Posting…' : 'Post transfer'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function AccountItems({ accounts }: { accounts: TransferAccountOption[] }) {
  if (accounts.length === 0) {
    return (
      <div className="px-2 py-1.5 text-xs text-muted-foreground">
        No cash / credit-card accounts configured.
      </div>
    );
  }
  return (
    <>
      {accounts.map((a) => (
        <SelectItem key={a.id} value={a.id}>
          <span className="font-mono text-xs text-muted-foreground">
            {a.code}
          </span>{' '}
          {a.name}
        </SelectItem>
      ))}
    </>
  );
}
