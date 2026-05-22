'use client';

import { useEffect, useState } from 'react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

// Self-fetching "Deposit to" account picker for the customer-payment
// dialogs. The bills/AP side passes its accounts down as props from the
// bill detail page; the customer-payment dialog opens from three places
// (SO detail, Customer AR tab, Payments list), so it fetches the GL
// accounts client-side instead of threading props through every caller.
//
// Shows ASSET (cash/bank) + LIABILITY (e.g. a credit-card payable)
// accounts — the same set the recordPayment service accepts. Defaults to
// the operator's last-used account (localStorage), else the first
// cash/bank (ASSET) account.

export type CashAccountOption = { id: string; code: string; name: string };

type GlAccountApi = {
  id: string;
  code: string;
  name: string;
  type: string;
  active: boolean;
};

const STORAGE_KEY = 'erp.customerPayment.cashAccountId';

/** Persist the operator's choice so the next payment defaults to it. */
export function rememberCashAccount(id: string) {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // localStorage can throw in private mode — defaulting is best-effort.
  }
}

function readRememberedCashAccount(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function CashAccountSelect({
  value,
  onValueChange,
  id,
  ariaInvalid,
  disabled,
}: {
  value: string;
  onValueChange: (id: string) => void;
  id?: string;
  ariaInvalid?: boolean;
  disabled?: boolean;
}) {
  const [accounts, setAccounts] = useState<CashAccountOption[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch('/api/gl-accounts?active=true&take=500')
      .then((res) => (res.ok ? (res.json() as Promise<GlAccountApi[]>) : []))
      .then((list) => {
        if (cancelled) return;
        setAccounts(
          list
            .filter(
              (a) => a.active && (a.type === 'ASSET' || a.type === 'LIABILITY'),
            )
            .map((a) => ({ id: a.id, code: a.code, name: a.name })),
        );
      })
      .catch(() => {
        if (!cancelled) setAccounts([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Default once the list loads and nothing is selected: last-used account
  // if it still exists, else the first cash/bank (ASSET) account, else the
  // first account. Re-runs after each open (parent clears `value`); the
  // `!value` guard stops it from firing again once a choice is set.
  useEffect(() => {
    if (loading || value || accounts.length === 0) return;
    const remembered = readRememberedCashAccount();
    const pick =
      (remembered && accounts.find((a) => a.id === remembered)?.id) ??
      accounts.find((a) => a.code.startsWith('1'))?.id ??
      accounts[0].id;
    onValueChange(pick);
  }, [loading, value, accounts, onValueChange]);

  return (
    <Select
      value={value}
      onValueChange={(v) => onValueChange(v ?? '')}
      disabled={disabled}
    >
      <SelectTrigger id={id} className="w-full" aria-invalid={ariaInvalid}>
        <SelectValue
          placeholder={
            loading ? 'Loading accounts…' : 'Pick a cash or credit-card account'
          }
        >
          {(v) => {
            if (!v) return null;
            const a = accounts.find((x) => x.id === v);
            if (!a) return v;
            return (
              <>
                <span className="font-mono text-xs text-muted-foreground">
                  {a.code}
                </span>{' '}
                {a.name}
              </>
            );
          }}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {accounts.length === 0 ? (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">
            {loading
              ? 'Loading accounts…'
              : 'No cash/bank or credit-card accounts configured — set one up under Admin → GL accounts first.'}
          </div>
        ) : (
          accounts.map((a) => (
            <SelectItem key={a.id} value={a.id}>
              <span className="font-mono text-xs text-muted-foreground">
                {a.code}
              </span>{' '}
              {a.name}
            </SelectItem>
          ))
        )}
      </SelectContent>
    </Select>
  );
}
