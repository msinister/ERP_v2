'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Search } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

// Inline search box for the work-orders list. Debounced URL sync, same
// shape as every other list page's search field — separate file because
// the WO list page is server-rendered inline and needs a client island
// for the input + URL push.

export function WorkOrderSearchInput() {
  const router = useRouter();
  const params = useSearchParams();
  const [, startTransition] = useTransition();

  const currentQ = params.get('q') ?? '';
  const [qInput, setQInput] = useState(currentQ);

  useEffect(() => {
    if (qInput === currentQ) return;
    const handle = window.setTimeout(() => {
      const next = new URLSearchParams(params.toString());
      if (qInput) next.set('q', qInput);
      else next.delete('q');
      startTransition(() => {
        router.push(`/work-orders?${next.toString()}`);
      });
    }, 250);
    return () => window.clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qInput]);

  useEffect(() => {
    setQInput(currentQ);
  }, [currentQ]);

  return (
    <div className="min-w-[200px] flex-1 space-y-1.5">
      <Label htmlFor="wo-search">Search</Label>
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          id="wo-search"
          placeholder="WO number or product…"
          value={qInput}
          onChange={(e) => setQInput(e.target.value)}
          className="pl-8"
        />
      </div>
    </div>
  );
}
