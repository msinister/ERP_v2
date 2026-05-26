'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Search, X, Tag as TagIcon, ChevronDown } from 'lucide-react';
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

// Values come from the BillStatus / BillPaymentStatus / BillSource enums
// in prisma/tenant/schema.prisma. Keep in lockstep if a new value lands.
const BILL_STATUSES: Array<{ value: string; label: string }> = [
  { value: 'DRAFT', label: 'Draft' },
  { value: 'CONFIRMED', label: 'Confirmed' },
  { value: 'CANCELLED', label: 'Cancelled' },
];

const PAYMENT_STATUSES: Array<{ value: string; label: string }> = [
  { value: 'UNPAID', label: 'Unpaid' },
  { value: 'PARTIAL', label: 'Partially paid' },
  { value: 'PAID', label: 'Paid' },
];

const BILL_SOURCES: Array<{ value: string; label: string }> = [
  { value: 'PRODUCT', label: 'Product' },
  { value: 'EXPENSE', label: 'Expense' },
];

const ALL_VALUE = '__all__';

export type VendorOption = { id: string; label: string };
export type TagOption = { id: string; name: string };

export function BillsFilters({
  vendors,
  tags,
}: {
  vendors: VendorOption[];
  tags: TagOption[];
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  const currentQ = params.get('q') ?? '';
  const currentStatus = params.get('status') ?? ALL_VALUE;
  const currentPaymentStatus = params.get('paymentStatus') ?? ALL_VALUE;
  const currentSource = params.get('source') ?? ALL_VALUE;
  const currentVendor = params.get('vendorId') ?? ALL_VALUE;
  const currentDateFrom = params.get('dateFrom') ?? '';
  const currentDateTo = params.get('dateTo') ?? '';
  const selectedTagIds = (params.get('tags') ?? '')
    .split(',')
    .filter(Boolean);

  const [qInput, setQInput] = useState(currentQ);

  // Debounced sync from local q text → URL. Skips when already in sync.
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
      router.push(`/bills?${next.toString()}`);
    });
  }

  function toggleTag(tagId: string, checked: boolean) {
    const next = new Set(selectedTagIds);
    if (checked) next.add(tagId);
    else next.delete(tagId);
    const value = Array.from(next).join(',');
    apply({ tags: value || null, skip: '0' });
  }

  function clearAll() {
    setQInput('');
    startTransition(() => {
      router.push('/bills');
    });
  }

  const hasFilters =
    currentQ !== '' ||
    currentStatus !== ALL_VALUE ||
    currentPaymentStatus !== ALL_VALUE ||
    currentSource !== ALL_VALUE ||
    currentVendor !== ALL_VALUE ||
    currentDateFrom !== '' ||
    currentDateTo !== '' ||
    selectedTagIds.length > 0;

  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="min-w-[200px] flex-1 space-y-1.5">
        <Label htmlFor="bill-search">Search</Label>
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            id="bill-search"
            placeholder="Bill # or vendor ref…"
            value={qInput}
            onChange={(e) => setQInput(e.target.value)}
            className="pl-8"
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="bill-status">Status</Label>
        <Select
          value={currentStatus}
          onValueChange={(v) => apply({ status: v, skip: '0' })}
        >
          <SelectTrigger id="bill-status" className="w-36">
            <SelectValue placeholder="All">
              {(v) =>
                v === ALL_VALUE
                  ? 'All statuses'
                  : (BILL_STATUSES.find((s) => s.value === v)?.label ?? v)
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_VALUE}>All statuses</SelectItem>
            {BILL_STATUSES.map((s) => (
              <SelectItem key={s.value} value={s.value}>
                {s.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="bill-payment-status">Payment</Label>
        <Select
          value={currentPaymentStatus}
          onValueChange={(v) => apply({ paymentStatus: v, skip: '0' })}
        >
          <SelectTrigger id="bill-payment-status" className="w-44">
            <SelectValue placeholder="All">
              {(v) =>
                v === ALL_VALUE
                  ? 'All'
                  : (PAYMENT_STATUSES.find((s) => s.value === v)?.label ?? v)
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_VALUE}>All</SelectItem>
            {PAYMENT_STATUSES.map((s) => (
              <SelectItem key={s.value} value={s.value}>
                {s.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="bill-source">Source</Label>
        <Select
          value={currentSource}
          onValueChange={(v) => apply({ source: v, skip: '0' })}
        >
          <SelectTrigger id="bill-source" className="w-36">
            <SelectValue placeholder="All">
              {(v) =>
                v === ALL_VALUE
                  ? 'All sources'
                  : (BILL_SOURCES.find((s) => s.value === v)?.label ?? v)
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_VALUE}>All sources</SelectItem>
            {BILL_SOURCES.map((s) => (
              <SelectItem key={s.value} value={s.value}>
                {s.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="bill-vendor">Vendor</Label>
        <Select
          value={currentVendor}
          onValueChange={(v) => apply({ vendorId: v, skip: '0' })}
        >
          <SelectTrigger id="bill-vendor" className="w-56">
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
        <Label htmlFor="bill-from">From</Label>
        <Input
          id="bill-from"
          type="date"
          value={currentDateFrom}
          onChange={(e) =>
            apply({ dateFrom: e.target.value || null, skip: '0' })
          }
          className="w-40"
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="bill-to">To</Label>
        <Input
          id="bill-to"
          type="date"
          value={currentDateTo}
          onChange={(e) =>
            apply({ dateTo: e.target.value || null, skip: '0' })
          }
          className="w-40"
        />
      </div>

      {tags.length > 0 ? (
        <div className="space-y-1.5">
          <Label>Tags</Label>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button variant="outline" className="w-48 justify-between">
                  <span className="flex items-center gap-1.5 truncate">
                    <TagIcon className="size-3.5" />
                    {selectedTagIds.length > 0
                      ? `${selectedTagIds.length} selected`
                      : 'Any tags'}
                  </span>
                  <ChevronDown className="size-3.5 text-muted-foreground" />
                </Button>
              }
            />
            <DropdownMenuContent align="start" className="max-h-72 overflow-auto">
              {tags.map((t) => (
                <DropdownMenuCheckboxItem
                  key={t.id}
                  checked={selectedTagIds.includes(t.id)}
                  onCheckedChange={(checked) => toggleTag(t.id, checked === true)}
                  closeOnClick={false}
                >
                  {t.name}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ) : null}

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
