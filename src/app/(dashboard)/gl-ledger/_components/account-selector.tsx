'use client';

import { useState, useTransition } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { AccountType } from '@/generated/tenant';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import type { SelectorAccount } from './types';

const TYPE_ORDER: AccountType[] = [
  AccountType.ASSET,
  AccountType.LIABILITY,
  AccountType.EQUITY,
  AccountType.REVENUE,
  AccountType.EXPENSE,
];
const TYPE_LABEL: Record<AccountType, string> = {
  ASSET: 'Assets',
  LIABILITY: 'Liabilities',
  EQUITY: 'Equity',
  REVENUE: 'Revenue',
  EXPENSE: 'Expenses',
};

type QuickFilter = 'all' | 'cash' | 'card';

export function AccountSelector({
  accounts,
  selectedId,
}: {
  accounts: SelectorAccount[];
  selectedId: string;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [quick, setQuick] = useState<QuickFilter>('all');

  const visible =
    quick === 'all' ? accounts : accounts.filter((a) => a.bucket === quick);

  function selectAccount(id: string) {
    const next = new URLSearchParams(params.toString());
    next.set('account', id);
    next.delete('skip'); // back to page 1 when the account changes
    startTransition(() => {
      router.push(`/gl-ledger?${next.toString()}`);
    });
  }

  const labelFor = (id: string) => {
    const a = accounts.find((x) => x.id === id);
    return a ? `${a.code} ${a.name}` : 'Select an account';
  };

  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="min-w-[280px] space-y-1.5">
        <Label htmlFor="ledger-account">Account</Label>
        <Select value={selectedId} onValueChange={(v) => v && selectAccount(v)}>
          <SelectTrigger id="ledger-account" className="w-80">
            <SelectValue placeholder="Select an account">
              {(v) => (v ? labelFor(v) : 'Select an account')}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {visible.length === 0 ? (
              <div className="px-2 py-1.5 text-xs text-muted-foreground">
                No accounts in this filter.
              </div>
            ) : (
              TYPE_ORDER.map((type) => {
                const group = visible.filter((a) => a.type === type);
                if (group.length === 0) return null;
                return (
                  <SelectGroup key={type}>
                    <SelectLabel>{TYPE_LABEL[type]}</SelectLabel>
                    {group.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        <span className="font-mono text-xs text-muted-foreground">
                          {a.code}
                        </span>{' '}
                        {a.name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                );
              })
            )}
          </SelectContent>
        </Select>
      </div>

      <div className="flex items-center gap-1.5">
        <QuickButton
          active={quick === 'all'}
          onClick={() => setQuick('all')}
          disabled={pending}
        >
          All
        </QuickButton>
        <QuickButton
          active={quick === 'cash'}
          onClick={() => setQuick('cash')}
          disabled={pending}
        >
          Cash accounts
        </QuickButton>
        <QuickButton
          active={quick === 'card'}
          onClick={() => setQuick('card')}
          disabled={pending}
        >
          Credit cards
        </QuickButton>
      </div>
    </div>
  );
}

function QuickButton({
  active,
  onClick,
  disabled,
  children,
}: {
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant={active ? 'default' : 'outline'}
      onClick={onClick}
      disabled={disabled}
      className={cn(active && 'pointer-events-none')}
    >
      {children}
    </Button>
  );
}
