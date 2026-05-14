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

// Values come from the PurchaseOrderStatus enum in
// prisma/tenant/schema.prisma. Keep in lockstep if a new value is added.
const PO_STATUSES: Array<{ value: string; label: string }> = [
  { value: 'DRAFT', label: 'Draft' },
  { value: 'CONFIRMED', label: 'Confirmed' },
  { value: 'PARTIALLY_RECEIVED', label: 'Partially received' },
  { value: 'CLOSED', label: 'Closed' },
  { value: 'CANCELLED', label: 'Cancelled' },
];

const ALL_VALUE = '__all__';

export type VendorOption = { id: string; label: string };

export function PurchaseOrdersFilters({
  vendors,
}: {
  vendors: VendorOption[];
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  const currentQ = params.get('q') ?? '';
  const currentStatus = params.get('status') ?? ALL_VALUE;
  const currentVendor = params.get('vendorId') ?? ALL_VALUE;
  const currentDateFrom = params.get('dateFrom') ?? '';
  const currentDateTo = params.get('dateTo') ?? '';

  const [qInput, setQInput] = useState(currentQ);

  // Debounced sync from local q text → URL. Skips when already in sync
  // so first-mount / back-nav doesn't trigger a redundant push.
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
      router.push(`/purchase-orders?${next.toString()}`);
    });
  }

  function clearAll() {
    setQInput('');
    startTransition(() => {
      router.push('/purchase-orders');
    });
  }

  const hasFilters =
    currentQ !== '' ||
    currentStatus !== ALL_VALUE ||
    currentVendor !== ALL_VALUE ||
    currentDateFrom !== '' ||
    currentDateTo !== '';

  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="min-w-[200px] flex-1 space-y-1.5">
        <Label htmlFor="po-search">Search</Label>
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            id="po-search"
            placeholder="PO number…"
            value={qInput}
            onChange={(e) => setQInput(e.target.value)}
            className="pl-8"
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="po-status">Status</Label>
        <Select
          value={currentStatus}
          onValueChange={(v) => apply({ status: v, skip: '0' })}
        >
          <SelectTrigger id="po-status" className="w-48">
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_VALUE}>All statuses</SelectItem>
            {PO_STATUSES.map((s) => (
              <SelectItem key={s.value} value={s.value}>
                {s.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="po-vendor">Vendor</Label>
        <Select
          value={currentVendor}
          onValueChange={(v) => apply({ vendorId: v, skip: '0' })}
        >
          <SelectTrigger id="po-vendor" className="w-56">
            <SelectValue placeholder="All vendors" />
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
        <Label htmlFor="po-from">From</Label>
        <Input
          id="po-from"
          type="date"
          value={currentDateFrom}
          onChange={(e) => apply({ dateFrom: e.target.value || null, skip: '0' })}
          className="w-40"
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="po-to">To</Label>
        <Input
          id="po-to"
          type="date"
          value={currentDateTo}
          onChange={(e) => apply({ dateTo: e.target.value || null, skip: '0' })}
          className="w-40"
        />
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
