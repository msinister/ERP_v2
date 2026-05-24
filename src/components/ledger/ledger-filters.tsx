'use client';

import { useTransition } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowDownUp, Download, X } from 'lucide-react';
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

export type LedgerTypeOption = { value: string; label: string };

// Shared client filter bar for the entity ledgers. URL-driven with
// namespaced keys (ledgerFrom / ledgerTo / ledgerType / ledgerSort /
// ledgerSkip) so it never collides with other tabs' params on the same
// detail page. Soft navigation keeps the active tab mounted.
export function LedgerFilters({
  basePath,
  exportBaseHref,
  typeOptions,
}: {
  basePath: string;
  exportBaseHref: string;
  typeOptions: LedgerTypeOption[];
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  const from = params.get('ledgerFrom') ?? '';
  const to = params.get('ledgerTo') ?? '';
  const type = params.get('ledgerType') ?? 'ALL';
  const sort = params.get('ledgerSort') === 'oldest' ? 'oldest' : 'newest';

  function apply(updates: Record<string, string | null>) {
    const next = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(updates)) {
      if (value === null || value === '') next.delete(key);
      else next.set(key, value);
    }
    startTransition(() => {
      router.push(`${basePath}?${next.toString()}`);
    });
  }

  // CSV export streams from the server with from/to/type applied.
  const exportParams = new URLSearchParams();
  if (from) exportParams.set('from', from);
  if (to) exportParams.set('to', to);
  if (type !== 'ALL') exportParams.set('type', type);
  if (sort === 'oldest') exportParams.set('sort', 'oldest');
  const exportHref = `${exportBaseHref}?${exportParams.toString()}`;

  const hasFilters = from !== '' || to !== '' || type !== 'ALL';

  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="space-y-1.5">
        <Label htmlFor="ledger-from">From</Label>
        <Input
          id="ledger-from"
          type="date"
          value={from}
          onChange={(e) => apply({ ledgerFrom: e.target.value || null, ledgerSkip: null })}
          className="w-40"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="ledger-to">To</Label>
        <Input
          id="ledger-to"
          type="date"
          value={to}
          onChange={(e) => apply({ ledgerTo: e.target.value || null, ledgerSkip: null })}
          className="w-40"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="ledger-type">Type</Label>
        <Select
          value={type}
          onValueChange={(v) =>
            apply({
              ledgerType: !v || v === 'ALL' ? null : v,
              ledgerSkip: null,
            })
          }
        >
          <SelectTrigger id="ledger-type" className="w-48">
            <SelectValue>
              {(v) => {
                if (!v || v === 'ALL') return 'All types';
                return typeOptions.find((o) => o.value === v)?.label ?? v;
              }}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All types</SelectItem>
            {typeOptions.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Button
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={() =>
          apply({ ledgerSort: sort === 'newest' ? 'oldest' : null, ledgerSkip: null })
        }
      >
        <ArrowDownUp />
        {sort === 'newest' ? 'Newest first' : 'Oldest first'}
      </Button>

      {hasFilters ? (
        <Button
          variant="ghost"
          size="sm"
          disabled={pending}
          onClick={() =>
            apply({
              ledgerFrom: null,
              ledgerTo: null,
              ledgerType: null,
              ledgerSkip: null,
            })
          }
        >
          <X />
          Clear
        </Button>
      ) : null}

      <div className="ml-auto">
        <Button
          variant="outline"
          size="sm"
          render={
            <a href={exportHref} download>
              <Download />
              Export CSV
            </a>
          }
        />
      </div>
    </div>
  );
}
