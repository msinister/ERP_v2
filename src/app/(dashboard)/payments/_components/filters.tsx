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

const STATUSES: Array<{ value: string; label: string }> = [
  { value: 'RECORDED', label: 'Recorded' },
  { value: 'REVERSED', label: 'Reversed' },
];

const METHODS: Array<{ value: string; label: string }> = [
  { value: 'CHECK', label: 'Check' },
  { value: 'ACH', label: 'ACH' },
  { value: 'WIRE', label: 'Wire' },
  { value: 'CREDIT_CARD', label: 'Credit card' },
  { value: 'CASH', label: 'Cash' },
  { value: 'MONEY_ORDER', label: 'Money order' },
  { value: 'APPLIED_CREDIT', label: 'Applied credit' },
];

// Sort presets map to (sort, dir) params. Default is newest first.
const SORTS: Array<{ value: string; label: string; sort: string; dir: string }> = [
  { value: 'date_desc', label: 'Newest first', sort: 'receivedAt', dir: 'desc' },
  { value: 'date_asc', label: 'Oldest first', sort: 'receivedAt', dir: 'asc' },
  { value: 'amount_desc', label: 'Amount: high to low', sort: 'amount', dir: 'desc' },
  { value: 'amount_asc', label: 'Amount: low to high', sort: 'amount', dir: 'asc' },
];

const ALL_VALUE = '__all__';

export type CustomerOption = { id: string; code: string; name: string };

export function PaymentsFilters({
  customers,
}: {
  customers: CustomerOption[];
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  const currentQ = params.get('q') ?? '';
  const currentStatus = params.get('status') ?? ALL_VALUE;
  const currentCustomer = params.get('customerId') ?? ALL_VALUE;
  const currentMethod = params.get('method') ?? ALL_VALUE;
  const currentFrom = params.get('from') ?? '';
  const currentTo = params.get('to') ?? '';
  const currentSortValue =
    SORTS.find(
      (s) =>
        s.sort === (params.get('sort') ?? 'receivedAt') &&
        s.dir === (params.get('dir') ?? 'desc'),
    )?.value ?? 'date_desc';

  const [qInput, setQInput] = useState(currentQ);
  const [fromInput, setFromInput] = useState(currentFrom);
  const [toInput, setToInput] = useState(currentTo);

  useEffect(() => {
    if (qInput === currentQ) return;
    const handle = window.setTimeout(() => {
      apply({ q: qInput || null, skip: '0' });
    }, 250);
    return () => window.clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qInput]);

  useEffect(() => {
    setQInput(currentQ);
  }, [currentQ]);
  useEffect(() => {
    setFromInput(currentFrom);
  }, [currentFrom]);
  useEffect(() => {
    setToInput(currentTo);
  }, [currentTo]);

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
      router.push(`/payments?${next.toString()}`);
    });
  }

  function applySort(value: string) {
    const preset = SORTS.find((s) => s.value === value);
    if (!preset) return;
    // Default preset clears the params for a clean URL.
    if (preset.value === 'date_desc') {
      apply({ sort: null, dir: null });
    } else {
      apply({ sort: preset.sort, dir: preset.dir });
    }
  }

  function clearAll() {
    setQInput('');
    setFromInput('');
    setToInput('');
    startTransition(() => {
      router.push('/payments');
    });
  }

  const hasFilters =
    currentQ !== '' ||
    currentStatus !== ALL_VALUE ||
    currentCustomer !== ALL_VALUE ||
    currentMethod !== ALL_VALUE ||
    currentFrom !== '' ||
    currentTo !== '';

  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="min-w-[200px] flex-1 space-y-1.5">
        <Label htmlFor="pmt-search">Search</Label>
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            id="pmt-search"
            placeholder="Payment # or reference…"
            value={qInput}
            onChange={(e) => setQInput(e.target.value)}
            className="pl-8"
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="pmt-status">Status</Label>
        <Select
          value={currentStatus}
          onValueChange={(v) => apply({ status: v, skip: '0' })}
        >
          <SelectTrigger id="pmt-status" className="w-36">
            <SelectValue placeholder="All">
              {(v) =>
                v === ALL_VALUE
                  ? 'All statuses'
                  : (STATUSES.find((s) => s.value === v)?.label ?? v)
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_VALUE}>All statuses</SelectItem>
            {STATUSES.map((s) => (
              <SelectItem key={s.value} value={s.value}>
                {s.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="pmt-customer">Customer</Label>
        <Select
          value={currentCustomer}
          onValueChange={(v) => apply({ customerId: v, skip: '0' })}
        >
          <SelectTrigger id="pmt-customer" className="w-56">
            <SelectValue placeholder="All customers">
              {(v) => {
                if (v === ALL_VALUE) return 'All customers';
                const c = customers.find((x) => x.id === v);
                return c ? `${c.name} (${c.code})` : v;
              }}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_VALUE}>All customers</SelectItem>
            {customers.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.name} ({c.code})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="pmt-method">Method</Label>
        <Select
          value={currentMethod}
          onValueChange={(v) => apply({ method: v, skip: '0' })}
        >
          <SelectTrigger id="pmt-method" className="w-40">
            <SelectValue placeholder="All methods">
              {(v) =>
                v === ALL_VALUE
                  ? 'All methods'
                  : (METHODS.find((m) => m.value === v)?.label ?? v)
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_VALUE}>All methods</SelectItem>
            {METHODS.map((m) => (
              <SelectItem key={m.value} value={m.value}>
                {m.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="pmt-from">From</Label>
        <Input
          id="pmt-from"
          type="date"
          value={fromInput}
          onChange={(e) => {
            setFromInput(e.target.value);
            apply({ from: e.target.value || null, skip: '0' });
          }}
          className="w-40"
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="pmt-to">To</Label>
        <Input
          id="pmt-to"
          type="date"
          value={toInput}
          onChange={(e) => {
            setToInput(e.target.value);
            apply({ to: e.target.value || null, skip: '0' });
          }}
          className="w-40"
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="pmt-sort">Sort</Label>
        <Select
          value={currentSortValue}
          onValueChange={(v) => applySort(v ?? 'date_desc')}
        >
          <SelectTrigger id="pmt-sort" className="w-48">
            <SelectValue>
              {(v) => SORTS.find((s) => s.value === v)?.label ?? 'Newest first'}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {SORTS.map((s) => (
              <SelectItem key={s.value} value={s.value}>
                {s.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {hasFilters ? (
        <Button variant="ghost" size="sm" onClick={clearAll} disabled={pending}>
          <X />
          Clear
        </Button>
      ) : null}
    </div>
  );
}
