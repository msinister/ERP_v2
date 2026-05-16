'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { OverShippingPolicyValue } from '@/lib/validation/settings';

const DEFAULT_POLICY: OverShippingPolicyValue = 'CONFIRM';

const POLICY_LABELS: Record<OverShippingPolicyValue, string> = {
  ALLOW: 'Allow without prompting',
  CONFIRM: 'Allow with confirmation',
  BLOCK: 'Block',
};

const POLICY_HINTS: Record<OverShippingPolicyValue, string> = {
  ALLOW:
    'Operators can save a qtyShipped greater than qtyOrdered with no prompt. Use when over-shipping is routine and you trust the warehouse to record it accurately.',
  CONFIRM:
    'When qtyShipped > qtyOrdered, the SO detail page asks the operator to confirm before saving. Server accepts the value either way — the dialog is a speed bump, not a security gate.',
  BLOCK:
    'Server rejects any qtyShipped > qtyOrdered with a 400 error. Original behavior; matches strict-fulfillment shops where over-shipping must always be a customer-service event.',
};

export function OverShippingPolicyForm({
  initial,
}: {
  initial: { policy: OverShippingPolicyValue } | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [policy, setPolicy] = useState<OverShippingPolicyValue>(
    initial?.policy ?? DEFAULT_POLICY,
  );

  function submit() {
    startTransition(async () => {
      try {
        const res = await fetch(
          '/api/admin/settings/over_shipping_policy',
          {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ policy }),
          },
        );
        if (!res.ok) {
          const errBody = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          toast.error(errBody.error ?? `Save failed (${res.status})`);
          return;
        }
        toast.success('Saved over-shipping policy');
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Network error');
      }
    });
  }

  return (
    <div className="space-y-3">
      <Field>
        <FieldLabel htmlFor="over-ship-policy">Policy</FieldLabel>
        <Select
          value={policy}
          onValueChange={(v) =>
            setPolicy((v as OverShippingPolicyValue) ?? DEFAULT_POLICY)
          }
        >
          <SelectTrigger id="over-ship-policy" className="w-full max-w-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(['ALLOW', 'CONFIRM', 'BLOCK'] as const).map((p) => (
              <SelectItem key={p} value={p}>
                {POLICY_LABELS[p]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">{POLICY_HINTS[policy]}</p>
      </Field>
      <div className="flex justify-end">
        <Button size="sm" onClick={submit} disabled={pending}>
          {pending ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </div>
  );
}
