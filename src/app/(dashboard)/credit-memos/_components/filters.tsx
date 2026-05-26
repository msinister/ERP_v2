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

const CM_STATUSES: Array<{ value: string; label: string }> = [
  { value: 'DRAFT', label: 'Draft' },
  { value: 'CONFIRMED', label: 'Confirmed' },
  { value: 'VOIDED', label: 'Voided' },
];

const ALL_VALUE = '__all__';

export type CustomerOption = { id: string; code: string; name: string };
export type CategoryOption = { id: string; code: string; label: string };
export type TagOption = { id: string; name: string };

export function CreditMemosFilters({
  customers,
  categories,
  tags,
}: {
  customers: CustomerOption[];
  categories: CategoryOption[];
  tags: TagOption[];
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  const currentQ = params.get('q') ?? '';
  const currentStatus = params.get('status') ?? ALL_VALUE;
  const currentCustomer = params.get('customerId') ?? ALL_VALUE;
  const currentCategory = params.get('categoryId') ?? ALL_VALUE;
  const currentFrom = params.get('from') ?? '';
  const currentTo = params.get('to') ?? '';
  const selectedTagIds = (params.get('tags') ?? '')
    .split(',')
    .filter(Boolean);

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
      router.push(`/credit-memos?${next.toString()}`);
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
    setFromInput('');
    setToInput('');
    startTransition(() => {
      router.push('/credit-memos');
    });
  }

  const hasFilters =
    currentQ !== '' ||
    currentStatus !== ALL_VALUE ||
    currentCustomer !== ALL_VALUE ||
    currentCategory !== ALL_VALUE ||
    currentFrom !== '' ||
    currentTo !== '' ||
    selectedTagIds.length > 0;

  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="min-w-[200px] flex-1 space-y-1.5">
        <Label htmlFor="cm-search">Search</Label>
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            id="cm-search"
            placeholder="CM number…"
            value={qInput}
            onChange={(e) => setQInput(e.target.value)}
            className="pl-8"
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="cm-status">Status</Label>
        <Select
          value={currentStatus}
          onValueChange={(v) => apply({ status: v, skip: '0' })}
        >
          <SelectTrigger id="cm-status" className="w-36">
            <SelectValue placeholder="All">
              {(v) =>
                v === ALL_VALUE
                  ? 'All statuses'
                  : (CM_STATUSES.find((s) => s.value === v)?.label ?? v)
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_VALUE}>All statuses</SelectItem>
            {CM_STATUSES.map((s) => (
              <SelectItem key={s.value} value={s.value}>
                {s.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="cm-customer">Customer</Label>
        <Select
          value={currentCustomer}
          onValueChange={(v) => apply({ customerId: v, skip: '0' })}
        >
          <SelectTrigger id="cm-customer" className="w-56">
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
        <Label htmlFor="cm-category">Category</Label>
        <Select
          value={currentCategory}
          onValueChange={(v) => apply({ categoryId: v, skip: '0' })}
        >
          <SelectTrigger id="cm-category" className="w-48">
            <SelectValue placeholder="All categories">
              {(v) => {
                if (v === ALL_VALUE) return 'All categories';
                const c = categories.find((x) => x.id === v);
                return c ? c.label : v;
              }}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_VALUE}>All categories</SelectItem>
            {categories.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="cm-from">From</Label>
        <Input
          id="cm-from"
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
        <Label htmlFor="cm-to">To</Label>
        <Input
          id="cm-to"
          type="date"
          value={toInput}
          onChange={(e) => {
            setToInput(e.target.value);
            apply({ to: e.target.value || null, skip: '0' });
          }}
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
