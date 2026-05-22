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
import type { TransferAccountOption } from './types';

const ALL_VALUE = '__all__';

export function TransferFilters({
  accounts,
}: {
  accounts: TransferAccountOption[];
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  const currentFrom = params.get('fromAccountId') ?? ALL_VALUE;
  const currentTo = params.get('toAccountId') ?? ALL_VALUE;
  const currentDateFrom = params.get('dateFrom') ?? '';
  const currentDateTo = params.get('dateTo') ?? '';

  const label = (id: string) => {
    const a = accounts.find((x) => x.id === id);
    return a ? `${a.code} ${a.name}` : id;
  };

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
      router.push(`/transfers?${next.toString()}`);
    });
  }

  function clearAll() {
    startTransition(() => {
      router.push('/transfers');
    });
  }

  const hasFilters =
    currentFrom !== ALL_VALUE ||
    currentTo !== ALL_VALUE ||
    currentDateFrom !== '' ||
    currentDateTo !== '';

  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="space-y-1.5">
        <Label htmlFor="tr-filter-from">From account</Label>
        <Select
          value={currentFrom}
          onValueChange={(v) => apply({ fromAccountId: v, skip: '0' })}
        >
          <SelectTrigger id="tr-filter-from" className="w-56">
            <SelectValue placeholder="Any">
              {(v) => (v === ALL_VALUE ? 'Any from' : label(v))}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_VALUE}>Any from</SelectItem>
            {accounts.map((a) => (
              <SelectItem key={a.id} value={a.id}>
                <span className="font-mono text-xs text-muted-foreground">
                  {a.code}
                </span>{' '}
                {a.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="tr-filter-to">To account</Label>
        <Select
          value={currentTo}
          onValueChange={(v) => apply({ toAccountId: v, skip: '0' })}
        >
          <SelectTrigger id="tr-filter-to" className="w-56">
            <SelectValue placeholder="Any">
              {(v) => (v === ALL_VALUE ? 'Any to' : label(v))}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_VALUE}>Any to</SelectItem>
            {accounts.map((a) => (
              <SelectItem key={a.id} value={a.id}>
                <span className="font-mono text-xs text-muted-foreground">
                  {a.code}
                </span>{' '}
                {a.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="tr-filter-datefrom">From</Label>
        <Input
          id="tr-filter-datefrom"
          type="date"
          value={currentDateFrom}
          onChange={(e) => apply({ dateFrom: e.target.value || null, skip: '0' })}
          className="w-40"
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="tr-filter-dateto">To</Label>
        <Input
          id="tr-filter-dateto"
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
