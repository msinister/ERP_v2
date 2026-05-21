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

const ENABLED_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'true', label: 'Enabled' },
  { value: 'false', label: 'Disabled' },
  { value: 'all', label: 'All' },
];

const ALL_VALUE = '__all__';

export function UsersFilters({
  roles,
}: {
  roles: Array<{ id: string; name: string }>;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  // Role-filter options: special "super" / "none" values plus one per
  // role. Value is the role id (or 'super' / 'none'); the page maps it
  // back to a where clause.
  const roleOptions: Array<{ value: string; label: string }> = [
    { value: 'super', label: 'Super admin' },
    ...roles.map((r) => ({ value: r.id, label: r.name })),
    { value: 'none', label: 'No role' },
  ];

  const currentQ = params.get('q') ?? '';
  const currentRole = params.get('role') ?? ALL_VALUE;
  // Default: show only enabled accounts. 'all' or 'false' override.
  const currentEnabled = params.get('enabled') ?? 'true';

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
      router.push(`/admin/users?${next.toString()}`);
    });
  }

  function clearAll() {
    setQInput('');
    startTransition(() => {
      router.push('/admin/users');
    });
  }

  const hasFilters =
    currentQ !== '' ||
    currentRole !== ALL_VALUE ||
    currentEnabled !== 'true';

  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="min-w-[240px] flex-1 space-y-1.5">
        <Label htmlFor="user-search">Search</Label>
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            id="user-search"
            placeholder="Name or email…"
            value={qInput}
            onChange={(e) => setQInput(e.target.value)}
            className="pl-8"
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="user-role">Role</Label>
        <Select
          value={currentRole}
          onValueChange={(v) => apply({ role: v, skip: '0' })}
        >
          <SelectTrigger id="user-role" className="w-48">
            <SelectValue placeholder="All">
              {(v) =>
                v === ALL_VALUE
                  ? 'All roles'
                  : (roleOptions.find((r) => r.value === v)?.label ?? v)
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_VALUE}>All roles</SelectItem>
            {roleOptions.map((r) => (
              <SelectItem key={r.value} value={r.value}>
                {r.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="user-enabled">Status</Label>
        <Select
          value={currentEnabled}
          onValueChange={(v) =>
            apply({ enabled: v === 'true' ? null : v, skip: '0' })
          }
        >
          <SelectTrigger id="user-enabled" className="w-32">
            <SelectValue>
              {(v) =>
                ENABLED_OPTIONS.find((o) => o.value === v)?.label ?? v
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {ENABLED_OPTIONS.map((o) => (
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
