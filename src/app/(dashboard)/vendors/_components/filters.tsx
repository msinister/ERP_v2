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

// Values come from the VendorType enum in prisma/tenant/schema.prisma.
// Keep in lockstep if a new value is added.
const VENDOR_TYPES: Array<{ value: string; label: string }> = [
  { value: 'STOCK', label: 'Stock' },
  { value: 'DROP_SHIP', label: 'Drop-ship' },
  { value: 'SERVICE', label: 'Service' },
];

const ACTIVE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'true', label: 'Active' },
  { value: 'false', label: 'Inactive' },
  { value: 'all', label: 'All' },
];

const ALL_VALUE = '__all__';

export function VendorsFilters() {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  const currentQ = params.get('q') ?? '';
  const currentType = params.get('type') ?? ALL_VALUE;
  // Default UX is "show only active" — same convention as customers.
  const currentActive = params.get('active') ?? 'true';

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
      router.push(`/vendors?${next.toString()}`);
    });
  }

  function clearAll() {
    setQInput('');
    startTransition(() => {
      router.push('/vendors');
    });
  }

  const hasFilters =
    currentQ !== '' ||
    currentType !== ALL_VALUE ||
    currentActive !== 'true';

  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="min-w-[240px] flex-1 space-y-1.5">
        <Label htmlFor="vendor-search">Search</Label>
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            id="vendor-search"
            placeholder="Vendor name or code…"
            value={qInput}
            onChange={(e) => setQInput(e.target.value)}
            className="pl-8"
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="vendor-type">Type</Label>
        <Select
          value={currentType}
          onValueChange={(v) => apply({ type: v, skip: '0' })}
        >
          <SelectTrigger id="vendor-type" className="w-44">
            <SelectValue placeholder="All types" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_VALUE}>All types</SelectItem>
            {VENDOR_TYPES.map((t) => (
              <SelectItem key={t.value} value={t.value}>
                {t.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="vendor-active">Status</Label>
        <Select
          value={currentActive}
          onValueChange={(v) =>
            // 'true' is the default — drop the param so the canonical
            // URL is the bare /vendors. 'all' and 'false' stay explicit.
            apply({ active: v === 'true' ? null : v, skip: '0' })
          }
        >
          <SelectTrigger id="vendor-active" className="w-32">
            <SelectValue />
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
