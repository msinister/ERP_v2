'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';
import { cn } from '@/lib/utils';

// Clickable "Balance" column header. Cycles the URL sort state:
//   inactive → desc → asc → inactive (back to default order).
// Resets pagination on change; the server re-sorts by computed balance.
export function BalanceSortHeader() {
  const router = useRouter();
  const params = useSearchParams();
  const active = params.get('sort') === 'balance';
  const dir = params.get('dir') === 'asc' ? 'asc' : 'desc';

  function toggle() {
    const next = new URLSearchParams(params.toString());
    if (!active) {
      next.set('sort', 'balance');
      next.set('dir', 'desc');
    } else if (dir === 'desc') {
      next.set('sort', 'balance');
      next.set('dir', 'asc');
    } else {
      next.delete('sort');
      next.delete('dir');
    }
    next.delete('skip');
    router.push(`/purchase-orders?${next.toString()}`);
  }

  return (
    <button
      type="button"
      onClick={toggle}
      className={cn(
        'inline-flex items-center gap-1 hover:text-foreground',
        active && 'text-foreground',
      )}
      aria-label="Sort by balance"
    >
      Balance
      {active ? (
        dir === 'asc' ? (
          <ArrowUp className="size-3.5" />
        ) : (
          <ArrowDown className="size-3.5" />
        )
      ) : (
        <ChevronsUpDown className="size-3.5 opacity-50" />
      )}
    </button>
  );
}
