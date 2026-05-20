'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Pencil } from 'lucide-react';

import {
  Combobox,
  ComboboxContent,
  ComboboxInput,
  ComboboxInputGroup,
  ComboboxItem,
  ComboboxList,
} from '@/components/ui/combobox';
import { cn } from '@/lib/utils';

export type RepOption = { id: string; name: string };

// Sentinel for the "inherit the customer's default rep" choice (clears
// the per-order override → PATCH sends salesRepId: null).
const INHERIT = '__inherit__';

// Inline edit for the SO detail "Sales rep" field. Click the value to
// open a searchable combobox of active reps (plus "Customer default");
// selecting saves immediately via the rep endpoint and refreshes.
export function SalesRepInlineEdit({
  salesOrderId,
  reps,
  effectiveRepName,
  overrideRepId,
  customerDefaultName,
}: {
  salesOrderId: string;
  reps: RepOption[];
  effectiveRepName: string;
  // SalesOrder.salesRepId — null means the order inherits the customer's rep.
  overrideRepId: string | null;
  customerDefaultName: string | null;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [pending, startTransition] = useTransition();
  const [query, setQuery] = useState('');

  const isOverride = overrideRepId != null;
  const inheritLabel = customerDefaultName
    ? `Customer default (${customerDefaultName})`
    : 'Customer default';

  const labelById = useMemo(() => {
    const m = new Map<string, string>();
    m.set(INHERIT, inheritLabel);
    for (const r of reps) m.set(r.id, r.name);
    return m;
  }, [reps, inheritLabel]);

  // Initial selection: the override rep when set, else the inherit slot.
  const selected = overrideRepId ?? INHERIT;

  const filtered = useMemo(() => {
    const all: RepOption[] = [{ id: INHERIT, name: inheritLabel }, ...reps];
    const q = query.trim().toLowerCase();
    if (!q) return all;
    // Keep the inherit option visible regardless of the query.
    return all.filter(
      (r) => r.id === INHERIT || r.name.toLowerCase().includes(q),
    );
  }, [reps, query, inheritLabel]);

  function save(value: string) {
    if (value === selected) {
      setEditing(false);
      return;
    }
    const salesRepId = value === INHERIT ? null : value;
    startTransition(async () => {
      try {
        const res = await fetch(
          `/api/sales-orders/${salesOrderId}/sales-rep`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ salesRepId }),
          },
        );
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          toast.error(body.error ?? 'Failed to update sales rep');
          return;
        }
        toast.success('Sales rep updated');
        setEditing(false);
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Network error');
      }
    });
  }

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="group inline-flex items-center gap-1.5 rounded-sm text-left text-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span>{effectiveRepName}</span>
        {!isOverride ? (
          <span className="text-xs text-muted-foreground">(default)</span>
        ) : null}
        <Pencil className="size-3 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
      </button>
    );
  }

  return (
    <Combobox<string>
      value={selected}
      onValueChange={(v) => {
        if (v) save(v);
      }}
      inputValue={query}
      onInputValueChange={setQuery}
      itemToStringLabel={(idv) => labelById.get(idv) ?? ''}
      disabled={pending}
    >
      <ComboboxInputGroup
        size="sm"
        className={cn('max-w-xs', pending && 'opacity-60')}
      >
        <ComboboxInput
          autoFocus
          placeholder="Search sales reps…"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              setEditing(false);
            }
          }}
        />
      </ComboboxInputGroup>
      <ComboboxContent>
        <ComboboxList>
          {filtered.length === 0 ? (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">
              No matching reps.
            </div>
          ) : (
            filtered.map((r) => (
              <ComboboxItem key={r.id} value={r.id}>
                {r.id === INHERIT ? (
                  <span className="text-muted-foreground">{r.name}</span>
                ) : (
                  r.name
                )}
              </ComboboxItem>
            ))
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
