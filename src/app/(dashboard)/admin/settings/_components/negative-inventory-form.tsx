'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Field, FieldLabel } from '@/components/ui/field';

export function NegativeInventoryForm({
  initial,
}: {
  initial: { allowed: boolean } | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [allowed, setAllowed] = useState(initial?.allowed ?? false);

  function submit() {
    startTransition(async () => {
      try {
        const res = await fetch(
          '/api/admin/settings/negative_inventory_allowed',
          {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ allowed }),
          },
        );
        if (!res.ok) {
          const errBody = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          toast.error(errBody.error ?? `Save failed (${res.status})`);
          return;
        }
        toast.success('Saved negative inventory setting');
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Network error');
      }
    });
  }

  return (
    <div className="space-y-3">
      <Field orientation="horizontal" className="md:items-start">
        <Checkbox
          id="neg-inv-allowed"
          checked={allowed}
          onCheckedChange={(v) => setAllowed(v === true)}
        />
        <div>
          <FieldLabel htmlFor="neg-inv-allowed">
            Allow negative inventory
          </FieldLabel>
          <p className="text-xs text-muted-foreground">
            When enabled, CONSUME against insufficient stock succeeds with
            unitCost=NULL on the movement and a negativeAllocation flag.
            No FifoConsumption rows are created — back-fill on the next
            RECEIVE is not implemented yet (CLAUDE.md known limitations).
            Default off preserves the historical hard-block behavior.
          </p>
        </div>
      </Field>
      <div className="flex justify-end">
        <Button size="sm" onClick={submit} disabled={pending}>
          {pending ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </div>
  );
}
