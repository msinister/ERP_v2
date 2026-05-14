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

type Kind = 'WEEKLY' | 'BI_WEEKLY' | 'MONTHLY';

export function CommissionCycleForm({
  initial,
}: {
  initial: { kind: Kind; anchorDay?: number } | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [kind, setKind] = useState<Kind>(initial?.kind ?? 'MONTHLY');
  const [anchorDay, setAnchorDay] = useState(
    initial?.anchorDay != null ? String(initial.anchorDay) : '',
  );
  const [errors, setErrors] = useState<Partial<Record<string, string>>>({});

  function submit() {
    const next: Partial<Record<string, string>> = {};
    if (anchorDay.trim() !== '') {
      const n = Number(anchorDay);
      if (!Number.isInteger(n)) {
        next.anchorDay = 'Must be an integer';
      } else if (kind === 'MONTHLY') {
        if (n < 1 || n > 28) next.anchorDay = '1–28 for MONTHLY';
      } else {
        if (n < 0 || n > 6) next.anchorDay = '0–6 for weekly (0 = Sunday)';
      }
    }
    if (Object.keys(next).length > 0) {
      setErrors(next);
      return;
    }
    setErrors({});
    const body: { kind: Kind; anchorDay?: number } = { kind };
    if (anchorDay.trim() !== '') body.anchorDay = Number(anchorDay);
    startTransition(async () => {
      try {
        const res = await fetch(
          '/api/admin/settings/commission_payout_cycle',
          {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          },
        );
        if (!res.ok) {
          const errBody = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          toast.error(errBody.error ?? `Save failed (${res.status})`);
          return;
        }
        toast.success('Saved commission payout cycle');
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Network error');
      }
    });
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Splits commission accruals into pending vs earned in the commission
        report. Accruals inside the current open window count as pending;
        older ones count as earned.
      </p>
      <div className="grid grid-cols-2 gap-3">
        <Field>
          <FieldLabel htmlFor="cycle-kind">Cycle</FieldLabel>
          <Select value={kind} onValueChange={(v) => setKind((v as Kind) ?? 'MONTHLY')}>
            <SelectTrigger id="cycle-kind" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="WEEKLY">Weekly</SelectItem>
              <SelectItem value="BI_WEEKLY">Bi-weekly</SelectItem>
              <SelectItem value="MONTHLY">Monthly</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field>
          <FieldLabel htmlFor="cycle-anchor">
            Anchor day{' '}
            {kind === 'MONTHLY' ? '(1–28)' : '(0–6, 0=Sunday)'}
          </FieldLabel>
          <Input
            id="cycle-anchor"
            inputMode="numeric"
            value={anchorDay}
            onChange={(e) => setAnchorDay(e.target.value)}
            aria-invalid={!!errors.anchorDay}
            placeholder="optional"
          />
          <FieldError
            errors={[errors.anchorDay ? { message: errors.anchorDay } : undefined]}
          />
        </Field>
      </div>
      <div className="flex justify-end">
        <Button size="sm" onClick={submit} disabled={pending}>
          {pending ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </div>
  );
}
