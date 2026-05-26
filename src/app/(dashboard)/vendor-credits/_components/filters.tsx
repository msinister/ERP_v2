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

const VC_STATUSES: Array<{ value: string; label: string }> = [
  { value: 'DRAFT', label: 'Draft' },
  { value: 'CONFIRMED', label: 'Confirmed' },
  { value: 'CANCELLED', label: 'Cancelled' },
];

const ALL_VALUE = '__all__';

export type VendorOption = { id: string; label: string };
export type TagOption = { id: string; name: string };

export function VendorCreditsFilters({
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
  const currentVendor = params.get('vendorId') ?? ALL_VALUE;
  const selectedTagIds = (params.get('tags') ?? '')
    .split(',')
    .filter(Boolean);

  const [qInput, setQInput] = useState(currentQ);

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
      router.push(`/vendor-credits?${next.toString()}`);
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
      router.push('/vendor-credits');
    });
  }

  const hasFilters =
    currentQ !== '' ||
    currentStatus !== ALL_VALUE ||
    currentVendor !== ALL_VALUE ||
    selectedTagIds.length > 0;

  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="min-w-[200px] flex-1 space-y-1.5">
        <Label htmlFor="vc-search">Search</Label>
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            id="vc-search"
            placeholder="VC number…"
            value={qInput}
            onChange={(e) => setQInput(e.target.value)}
            className="pl-8"
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="vc-status">Status</Label>
        <Select
          value={currentStatus}
          onValueChange={(v) => apply({ status: v, skip: '0' })}
        >
          <SelectTrigger id="vc-status" className="w-36">
            <SelectValue placeholder="All">
              {(v) =>
                v === ALL_VALUE
                  ? 'All statuses'
                  : (VC_STATUSES.find((s) => s.value === v)?.label ?? v)
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_VALUE}>All statuses</SelectItem>
            {VC_STATUSES.map((s) => (
              <SelectItem key={s.value} value={s.value}>
                {s.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="vc-vendor">Vendor</Label>
        <Select
          value={currentVendor}
          onValueChange={(v) => apply({ vendorId: v, skip: '0' })}
        >
          <SelectTrigger id="vc-vendor" className="w-56">
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
