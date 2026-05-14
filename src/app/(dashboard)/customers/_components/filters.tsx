'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Search, X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

// All five values come from the CustomerType enum in
// prisma/tenant/schema.prisma (and the customerTypeEnum in
// validation/customers.ts). If the enum gets a new value, add it here
// in lockstep.
const CUSTOMER_TYPES: Array<{ value: string; label: string }> = [
  { value: 'WHOLESALE_REGULAR', label: 'Wholesale — regular' },
  { value: 'WHOLESALE_PREFERRED', label: 'Wholesale — preferred' },
  { value: 'WHOLESALE_DISTRIBUTOR', label: 'Wholesale — distributor' },
  {
    value: 'WHOLESALE_MASTER_DISTRIBUTOR',
    label: 'Wholesale — master distributor',
  },
  { value: 'RETAIL', label: 'Retail' },
];

const ACTIVE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'true', label: 'Active' },
  { value: 'false', label: 'Inactive' },
  { value: 'all', label: 'All' },
];

const ALL_VALUE = '__all__';

export type SalesRepOption = { id: string; label: string };

export function CustomersFilters({
  salesReps,
}: {
  salesReps: SalesRepOption[];
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  const currentQ = params.get('q') ?? '';
  const currentType = params.get('type') ?? ALL_VALUE;
  // Default UX is "show only active" — matches what staff want 90% of
  // the time. Pass active=all in the URL to override.
  const currentActive = params.get('active') ?? 'true';
  const currentSalesRep = params.get('salesRepId') ?? ALL_VALUE;

  const [qInput, setQInput] = useState(currentQ);

  // Debounced sync from local q text input → URL (?q=...). Skips when
  // the value is already in sync (avoids a round-trip on first mount /
  // back-button navigation).
  useEffect(() => {
    if (qInput === currentQ) return;
    const handle = window.setTimeout(() => {
      apply({ q: qInput || null, skip: '0' });
    }, 250);
    return () => window.clearTimeout(handle);
    // apply / currentQ are stable enough — explicitly excluded to avoid
    // re-triggering the timer when params race the local state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qInput]);

  // Keep local input in sync if the URL changes underneath us (e.g.
  // user clicked Clear or navigated back).
  useEffect(() => {
    setQInput(currentQ);
  }, [currentQ]);

  function apply(updates: Record<string, string | null>) {
    const next = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(updates)) {
      if (value === null || value === '' || value === ALL_VALUE) {
        next.delete(key);
      } else {
        next.set(key, value);
      }
    }
    startTransition(() => {
      router.push(`/customers?${next.toString()}`);
    });
  }

  function clearAll() {
    setQInput('');
    startTransition(() => {
      router.push('/customers');
    });
  }

  const hasFilters =
    currentQ !== '' ||
    currentType !== ALL_VALUE ||
    currentActive !== 'true' ||
    currentSalesRep !== ALL_VALUE;

  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="min-w-[240px] flex-1 space-y-1.5">
        <Label htmlFor="customer-search">Search</Label>
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            id="customer-search"
            placeholder="Customer name…"
            value={qInput}
            onChange={(e) => setQInput(e.target.value)}
            className="pl-8"
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="customer-type">Type</Label>
        <Select
          value={currentType}
          onValueChange={(v) => apply({ type: v, skip: '0' })}
        >
          <SelectTrigger id="customer-type" className="w-56">
            <SelectValue placeholder="All types">
              {(v) =>
                v === ALL_VALUE
                  ? 'All types'
                  : (CUSTOMER_TYPES.find((t) => t.value === v)?.label ?? v)
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_VALUE}>All types</SelectItem>
            {CUSTOMER_TYPES.map((t) => (
              <SelectItem key={t.value} value={t.value}>
                {t.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="customer-active">Status</Label>
        <Select
          value={currentActive}
          onValueChange={(v) =>
            // 'true' is the default — drop the param so the canonical
            // URL is the bare /customers. 'all' and 'false' are
            // explicit overrides and stay in the URL.
            apply({ active: v === 'true' ? null : v, skip: '0' })
          }
        >
          <SelectTrigger id="customer-active" className="w-32">
            <SelectValue>
              {(v) =>
                ACTIVE_OPTIONS.find((o) => o.value === v)?.label ?? v
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {ACTIVE_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="customer-salesrep">Sales rep</Label>
        <Select
          value={currentSalesRep}
          onValueChange={(v) => apply({ salesRepId: v, skip: '0' })}
        >
          <SelectTrigger id="customer-salesrep" className="w-48">
            <SelectValue placeholder="All reps">
              {(v) =>
                v === ALL_VALUE
                  ? 'All reps'
                  : (salesReps.find((r) => r.id === v)?.label ?? v)
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_VALUE}>All reps</SelectItem>
            {salesReps.map((r) => (
              <SelectItem key={r.id} value={r.id}>
                {r.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {hasFilters ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={clearAll}
          disabled={pending}
        >
          <X />
          Clear
        </Button>
      ) : null}
    </div>
  );
}
