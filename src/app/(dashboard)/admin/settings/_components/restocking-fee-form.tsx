'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Field, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

type Mode = 'none' | 'percent' | 'flat';

export function RestockingFeeForm({
  initial,
}: {
  initial: { percent: string | null; flat: string | null };
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [mode, setMode] = useState<Mode>(
    initial.percent != null
      ? 'percent'
      : initial.flat != null
        ? 'flat'
        : 'none',
  );
  const [percent, setPercent] = useState(initial.percent ?? '');
  const [flat, setFlat] = useState(initial.flat ?? '');
  const [errors, setErrors] = useState<Partial<Record<string, string>>>({});

  function submit() {
    const next: Partial<Record<string, string>> = {};
    if (mode === 'percent') {
      if (!/^\d+(\.\d+)?$/.test(percent)) next.percent = 'Must be a number';
      else if (Number(percent) < 0 || Number(percent) > 100)
        next.percent = 'Must be between 0 and 100';
    }
    if (mode === 'flat') {
      if (!/^\d+(\.\d+)?$/.test(flat)) next.flat = 'Must be a number';
      else if (Number(flat) < 0) next.flat = 'Must be >= 0';
    }
    if (Object.keys(next).length > 0) {
      setErrors(next);
      return;
    }
    setErrors({});
    // On-disk shape: { percent: string|null, flat: string|null }.
    // Exactly one is non-null (or both null for "no default").
    const body =
      mode === 'percent'
        ? { percent, flat: null }
        : mode === 'flat'
          ? { percent: null, flat }
          : { percent: null, flat: null };
    startTransition(async () => {
      try {
        const res = await fetch('/api/admin/settings/restocking_fee_default', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const errBody = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          toast.error(errBody.error ?? `Save failed (${res.status})`);
          return;
        }
        toast.success('Saved restocking fee default');
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Network error');
      }
    });
  }

  return (
    <div className="space-y-3">
      <Field>
        <FieldLabel htmlFor="rf-mode">Default fee</FieldLabel>
        <Select value={mode} onValueChange={(v) => setMode((v as Mode) ?? 'none')}>
          <SelectTrigger id="rf-mode" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">No default</SelectItem>
            <SelectItem value="percent">Percent of line total</SelectItem>
            <SelectItem value="flat">Flat fee per RMA</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          Applied as a default on RMAs; operator can override per line.
        </p>
      </Field>

      {mode === 'percent' ? (
        <Field>
          <FieldLabel htmlFor="rf-percent">Percent (0–100)</FieldLabel>
          <Input
            id="rf-percent"
            inputMode="decimal"
            value={percent}
            onChange={(e) => setPercent(e.target.value)}
            aria-invalid={!!errors.percent}
          />
          <FieldError
            errors={[errors.percent ? { message: errors.percent } : undefined]}
          />
        </Field>
      ) : null}

      {mode === 'flat' ? (
        <Field>
          <FieldLabel htmlFor="rf-flat">Flat amount</FieldLabel>
          <Input
            id="rf-flat"
            inputMode="decimal"
            value={flat}
            onChange={(e) => setFlat(e.target.value)}
            aria-invalid={!!errors.flat}
          />
          <FieldError
            errors={[errors.flat ? { message: errors.flat } : undefined]}
          />
        </Field>
      ) : null}

      <div className="flex justify-end">
        <Button size="sm" onClick={submit} disabled={pending}>
          {pending ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </div>
  );
}
