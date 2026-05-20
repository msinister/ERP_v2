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

const STATUS_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'active', label: 'Active' },
  { value: 'all', label: 'All (incl. inactive)' },
  { value: 'archived', label: 'Archived' },
];

const ALL_VALUE = '__all__';

export type TagOption = { id: string; name: string };

export function ProductsFilters({
  brands,
  categories,
  tags,
}: {
  brands: string[];
  categories: string[];
  tags: TagOption[];
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  const currentQ = params.get('q') ?? '';
  // Default UX is "show only active" — matches what staff want 90% of
  // the time. Pass status=all in the URL to override.
  const currentStatus = params.get('status') ?? 'active';
  const currentBrand = params.get('brand') ?? ALL_VALUE;
  const currentCategory = params.get('category') ?? ALL_VALUE;
  const selectedTagIds = (params.get('tags') ?? '')
    .split(',')
    .filter(Boolean);

  const [qInput, setQInput] = useState(currentQ);

  // Debounced sync from local q text input → URL (?q=...).
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
      router.push(`/products?${next.toString()}`);
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
      router.push('/products');
    });
  }

  const hasFilters =
    currentQ !== '' ||
    currentStatus !== 'active' ||
    currentBrand !== ALL_VALUE ||
    currentCategory !== ALL_VALUE ||
    selectedTagIds.length > 0;

  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="min-w-[220px] flex-1 space-y-1.5">
        <Label htmlFor="product-search">Search</Label>
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            id="product-search"
            placeholder="SKU or name…"
            value={qInput}
            onChange={(e) => setQInput(e.target.value)}
            className="pl-8"
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="product-status">Status</Label>
        <Select
          value={currentStatus}
          onValueChange={(v) =>
            // 'active' is the default — drop the param so the canonical
            // URL is the bare /products.
            apply({ status: v === 'active' ? null : v, skip: '0' })
          }
        >
          <SelectTrigger id="product-status" className="w-44">
            <SelectValue>
              {(v) =>
                STATUS_OPTIONS.find((s) => s.value === v)?.label ?? v
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {STATUS_OPTIONS.map((s) => (
              <SelectItem key={s.value} value={s.value}>
                {s.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="product-brand">Brand</Label>
        <Select
          value={currentBrand}
          onValueChange={(v) => apply({ brand: v, skip: '0' })}
        >
          <SelectTrigger id="product-brand" className="w-48">
            <SelectValue placeholder="All brands">
              {(v) => (v === ALL_VALUE ? 'All brands' : v)}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_VALUE}>All brands</SelectItem>
            {brands.map((b) => (
              <SelectItem key={b} value={b}>
                {b}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="product-category">Category</Label>
        <Select
          value={currentCategory}
          onValueChange={(v) => apply({ category: v, skip: '0' })}
        >
          <SelectTrigger id="product-category" className="w-48">
            <SelectValue placeholder="All categories">
              {(v) => (v === ALL_VALUE ? 'All categories' : v)}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_VALUE}>All categories</SelectItem>
            {categories.map((c) => (
              <SelectItem key={c} value={c}>
                {c}
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
                  // Keep the menu open while toggling multiple tags.
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
        <Button variant="ghost" size="sm" onClick={clearAll} disabled={pending}>
          <X />
          Clear
        </Button>
      ) : null}
    </div>
  );
}
