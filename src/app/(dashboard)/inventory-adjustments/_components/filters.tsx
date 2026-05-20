'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { X } from 'lucide-react';
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
import { CATEGORY_OPTIONS, categoryLabel } from './categories';

const STATUSES: Array<{ value: string; label: string }> = [
  { value: 'DRAFT', label: 'Draft' },
  { value: 'POSTED', label: 'Posted' },
  { value: 'VOIDED', label: 'Voided' },
];

const ALL = '__all__';

export type WarehouseOption = { id: string; code: string; name: string };

export function AdjustmentsFilters({
  warehouses,
}: {
  warehouses: WarehouseOption[];
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  const status = params.get('status') ?? ALL;
  const warehouseId = params.get('warehouseId') ?? ALL;
  const category = params.get('category') ?? ALL;
  const currentFrom = params.get('from') ?? '';
  const currentTo = params.get('to') ?? '';

  const [fromInput, setFromInput] = useState(currentFrom);
  const [toInput, setToInput] = useState(currentTo);
  useEffect(() => setFromInput(currentFrom), [currentFrom]);
  useEffect(() => setToInput(currentTo), [currentTo]);

  function apply(updates: Record<string, string | null>) {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(updates)) {
      if (v === null || v === '' || v === ALL) next.delete(k);
      else next.set(k, v);
    }
    startTransition(() => router.push(`/inventory-adjustments?${next.toString()}`));
  }

  function clearAll() {
    setFromInput('');
    setToInput('');
    startTransition(() => router.push('/inventory-adjustments'));
  }

  const hasFilters =
    status !== ALL ||
    warehouseId !== ALL ||
    category !== ALL ||
    currentFrom !== '' ||
    currentTo !== '';

  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="space-y-1.5">
        <Label htmlFor="adj-status">Status</Label>
        <Select value={status} onValueChange={(v) => apply({ status: v, skip: '0' })}>
          <SelectTrigger id="adj-status" className="w-36">
            <SelectValue>
              {(v) =>
                v === ALL
                  ? 'All statuses'
                  : (STATUSES.find((s) => s.value === v)?.label ?? v)
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All statuses</SelectItem>
            {STATUSES.map((s) => (
              <SelectItem key={s.value} value={s.value}>
                {s.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="adj-warehouse">Warehouse</Label>
        <Select
          value={warehouseId}
          onValueChange={(v) => apply({ warehouseId: v, skip: '0' })}
        >
          <SelectTrigger id="adj-warehouse" className="w-48">
            <SelectValue>
              {(v) => {
                if (v === ALL) return 'All warehouses';
                const w = warehouses.find((x) => x.id === v);
                return w ? `${w.code} — ${w.name}` : v;
              }}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All warehouses</SelectItem>
            {warehouses.map((w) => (
              <SelectItem key={w.id} value={w.id}>
                {w.code} — {w.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="adj-category">Category</Label>
        <Select
          value={category}
          onValueChange={(v) => apply({ category: v, skip: '0' })}
        >
          <SelectTrigger id="adj-category" className="w-44">
            <SelectValue>
              {(v) => (v === ALL ? 'All categories' : categoryLabel(v))}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All categories</SelectItem>
            {CATEGORY_OPTIONS.map((c) => (
              <SelectItem key={c.value} value={c.value}>
                {c.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="adj-from">From</Label>
        <Input
          id="adj-from"
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
        <Label htmlFor="adj-to">To</Label>
        <Input
          id="adj-to"
          type="date"
          value={toInput}
          onChange={(e) => {
            setToInput(e.target.value);
            apply({ to: e.target.value || null, skip: '0' });
          }}
          className="w-40"
        />
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
