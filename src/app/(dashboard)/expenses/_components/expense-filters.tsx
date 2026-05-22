'use client';

import { useTransition } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { CategoryOption } from './types';

const ALL_VALUE = '__all__';

export type VendorFilterOption = { id: string; label: string };

export function ExpenseFilters({
  vendors,
  categories,
}: {
  vendors: VendorFilterOption[];
  categories: CategoryOption[];
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  const currentVendor = params.get('vendorId') ?? ALL_VALUE;
  const currentCategory = params.get('category') ?? ALL_VALUE;
  const currentDateFrom = params.get('dateFrom') ?? '';
  const currentDateTo = params.get('dateTo') ?? '';

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
      router.push(`/expenses?${next.toString()}`);
    });
  }

  function clearAll() {
    startTransition(() => {
      router.push('/expenses');
    });
  }

  const hasFilters =
    currentVendor !== ALL_VALUE ||
    currentCategory !== ALL_VALUE ||
    currentDateFrom !== '' ||
    currentDateTo !== '';

  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="space-y-1.5">
        <Label htmlFor="exp-filter-category">Category</Label>
        <Select
          value={currentCategory}
          onValueChange={(v) => apply({ category: v, skip: '0' })}
        >
          <SelectTrigger id="exp-filter-category" className="w-56">
            <SelectValue placeholder="All categories">
              {(v) =>
                v === ALL_VALUE
                  ? 'All categories'
                  : (categories.find((c) => c.id === v)?.name ?? v)
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_VALUE}>All categories</SelectItem>
            {categories.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                <span className="font-mono text-xs text-muted-foreground">
                  {c.code}
                </span>{' '}
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="exp-filter-vendor">Vendor</Label>
        <Select
          value={currentVendor}
          onValueChange={(v) => apply({ vendorId: v, skip: '0' })}
        >
          <SelectTrigger id="exp-filter-vendor" className="w-56">
            <SelectValue placeholder="All vendors">
              {(v) =>
                v === ALL_VALUE
                  ? 'All vendors'
                  : (vendors.find((x) => x.id === v)?.label ?? v)
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_VALUE}>All vendors</SelectItem>
            {vendors.map((v) => (
              <SelectItem key={v.id} value={v.id}>
                {v.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="exp-filter-from">From</Label>
        <Input
          id="exp-filter-from"
          type="date"
          value={currentDateFrom}
          onChange={(e) => apply({ dateFrom: e.target.value || null, skip: '0' })}
          className="w-40"
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="exp-filter-to">To</Label>
        <Input
          id="exp-filter-to"
          type="date"
          value={currentDateTo}
          onChange={(e) => apply({ dateTo: e.target.value || null, skip: '0' })}
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
