'use client';

import { useTransition } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Download, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function LedgerFilters() {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  const account = params.get('account') ?? '';
  const dateFrom = params.get('dateFrom') ?? '';
  const dateTo = params.get('dateTo') ?? '';

  function apply(updates: Record<string, string | null>) {
    const next = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(updates)) {
      if (value === null || value === '') next.delete(key);
      else next.set(key, value);
    }
    startTransition(() => {
      router.push(`/gl-ledger?${next.toString()}`);
    });
  }

  // Server export endpoint streams the CSV with a Content-Disposition
  // attachment, so a plain link triggers the download.
  const exportParams = new URLSearchParams();
  if (account) exportParams.set('accountId', account);
  if (dateFrom) exportParams.set('from', dateFrom);
  if (dateTo) exportParams.set('to', dateTo);
  const exportHref = `/api/gl-ledger/export?${exportParams.toString()}`;

  const hasDates = dateFrom !== '' || dateTo !== '';

  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="space-y-1.5">
        <Label htmlFor="ledger-from">From</Label>
        <Input
          id="ledger-from"
          type="date"
          value={dateFrom}
          onChange={(e) => apply({ dateFrom: e.target.value || null, skip: null })}
          className="w-40"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="ledger-to">To</Label>
        <Input
          id="ledger-to"
          type="date"
          value={dateTo}
          onChange={(e) => apply({ dateTo: e.target.value || null, skip: null })}
          className="w-40"
        />
      </div>
      {hasDates ? (
        <Button
          variant="ghost"
          size="sm"
          disabled={pending}
          onClick={() => apply({ dateFrom: null, dateTo: null, skip: null })}
        >
          <X />
          Clear dates
        </Button>
      ) : null}
      <div className="ml-auto">
        <Button
          variant="outline"
          size="sm"
          disabled={!account}
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
