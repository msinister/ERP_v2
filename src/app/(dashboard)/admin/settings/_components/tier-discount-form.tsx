'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Field, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  isNonNegativeDecimalInput,
  normalizeDecimalForSubmit,
} from '@/lib/decimal-input';

type Tiers = {
  WHOLESALE_REGULAR: string;
  WHOLESALE_PREFERRED: string;
  WHOLESALE_DISTRIBUTOR: string;
  WHOLESALE_MASTER_DISTRIBUTOR: string;
  RETAIL: string;
};

const TIER_LABELS: Array<{ key: keyof Tiers; label: string }> = [
  { key: 'WHOLESALE_REGULAR', label: 'Wholesale — regular' },
  { key: 'WHOLESALE_PREFERRED', label: 'Wholesale — preferred' },
  { key: 'WHOLESALE_DISTRIBUTOR', label: 'Wholesale — distributor' },
  {
    key: 'WHOLESALE_MASTER_DISTRIBUTOR',
    label: 'Wholesale — master distributor',
  },
  { key: 'RETAIL', label: 'Retail' },
];

export function TierDiscountForm({ initial }: { initial: Tiers | null }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // Missing-key fallback: zero across the board (resolver treats this
  // as no tier discount).
  const [values, setValues] = useState<Tiers>(
    initial ?? {
      WHOLESALE_REGULAR: '0',
      WHOLESALE_PREFERRED: '0',
      WHOLESALE_DISTRIBUTOR: '0',
      WHOLESALE_MASTER_DISTRIBUTOR: '0',
      RETAIL: '0',
    },
  );
  const [errors, setErrors] = useState<Partial<Record<keyof Tiers, string>>>(
    {},
  );

  function submit() {
    const next: Partial<Record<keyof Tiers, string>> = {};
    for (const t of TIER_LABELS) {
      const v = values[t.key];
      if (!isNonNegativeDecimalInput(v)) next[t.key] = 'Must be a number';
      else if (Number(v) > 100)
        next[t.key] = 'Must be between 0 and 100';
    }
    if (Object.keys(next).length > 0) {
      setErrors(next);
      return;
    }
    setErrors({});
    // Normalize loose decimal input (".25" → "0.25") so the server's
    // strict decimalString validator accepts the value.
    const normalized = Object.fromEntries(
      TIER_LABELS.map((t) => [t.key, normalizeDecimalForSubmit(values[t.key])]),
    ) as Tiers;
    startTransition(async () => {
      try {
        const res = await fetch(
          '/api/admin/settings/tier_discount_percentages',
          {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(normalized),
          },
        );
        if (!res.ok) {
          const errBody = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          toast.error(errBody.error ?? `Save failed (${res.status})`);
          return;
        }
        toast.success('Saved tier discount percentages');
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Network error');
      }
    });
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Pre-fills the % Discount column on SO lines for each customer tier.
        Operator can override per line.
      </p>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {TIER_LABELS.map((t) => (
          <Field key={t.key}>
            <FieldLabel htmlFor={`tier-${t.key}`}>{t.label}</FieldLabel>
            <Input
              id={`tier-${t.key}`}
              inputMode="decimal"
              value={values[t.key]}
              onChange={(e) =>
                setValues((prev) => ({ ...prev, [t.key]: e.target.value }))
              }
              aria-invalid={!!errors[t.key]}
              placeholder="0"
            />
            <FieldError
              errors={[errors[t.key] ? { message: errors[t.key]! } : undefined]}
            />
          </Field>
        ))}
      </div>
      <div className="flex justify-end">
        <Button size="sm" onClick={submit} disabled={pending}>
          {pending ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </div>
  );
}
