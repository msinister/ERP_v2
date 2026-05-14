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

// AuditAction values come from prisma/tenant/schema.prisma. Keep in
// lockstep if a new value lands. Ordered roughly by frequency to keep
// the dropdown skimmable.
const ACTIONS: Array<{ value: string; label: string }> = [
  { value: 'CREATE', label: 'Create' },
  { value: 'UPDATE', label: 'Update' },
  { value: 'DELETE', label: 'Delete' },
  { value: 'STATUS_CHANGE', label: 'Status change' },
  { value: 'VOID', label: 'Void' },
  { value: 'REVERSE', label: 'Reverse' },
  { value: 'REFUND', label: 'Refund' },
  { value: 'PERMISSION_CHANGE', label: 'Permission change' },
  { value: 'CONFIG_CHANGE', label: 'Config change' },
  { value: 'LOGIN', label: 'Login' },
  { value: 'LOGOUT', label: 'Logout' },
  { value: 'SENSITIVE_READ', label: 'Sensitive read' },
  { value: 'INVOICE_GENERATED', label: 'Invoice generated' },
  { value: 'PAYMENT_REVERSED', label: 'Payment reversed' },
  { value: 'RMA_STATUS_CHANGE', label: 'RMA status change' },
  { value: 'INSUFFICIENT_STOCK_AT_CLOSE', label: 'Insufficient stock at close' },
  { value: 'DRAFT_BILL_GENERATED', label: 'Draft bill generated' },
  { value: 'BILL_CONFIRMED', label: 'Bill confirmed' },
  { value: 'BILL_PAYMENT_RECORDED', label: 'Bill payment recorded' },
  { value: 'BILL_PAYMENT_REVERSED', label: 'Bill payment reversed' },
  { value: 'VENDOR_CREDIT_CONFIRMED', label: 'Vendor credit confirmed' },
  { value: 'VENDOR_CREDIT_APPLIED', label: 'Vendor credit applied' },
];

const ALL_VALUE = '__all__';

export type UserOption = { id: string; label: string };

export function AuditLogFilters({ users }: { users: UserOption[] }) {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  const currentEntityType = params.get('entityType') ?? '';
  const currentEntityId = params.get('entityId') ?? '';
  const currentUserId = params.get('userId') ?? ALL_VALUE;
  const currentAction = params.get('action') ?? ALL_VALUE;
  const currentFrom = params.get('from') ?? '';
  const currentTo = params.get('to') ?? '';

  const [entityType, setEntityType] = useState(currentEntityType);
  const [entityId, setEntityId] = useState(currentEntityId);

  // Debounced sync for the free-text inputs. Same pattern as the
  // bills / vendors filters.
  useEffect(() => {
    if (entityType === currentEntityType) return;
    const handle = window.setTimeout(() => {
      apply({ entityType: entityType || null, skip: '0' });
    }, 250);
    return () => window.clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityType]);
  useEffect(() => {
    if (entityId === currentEntityId) return;
    const handle = window.setTimeout(() => {
      apply({ entityId: entityId || null, skip: '0' });
    }, 250);
    return () => window.clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityId]);
  useEffect(() => {
    setEntityType(currentEntityType);
  }, [currentEntityType]);
  useEffect(() => {
    setEntityId(currentEntityId);
  }, [currentEntityId]);

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
      router.push(`/admin/audit-log?${next.toString()}`);
    });
  }

  function clearAll() {
    setEntityType('');
    setEntityId('');
    startTransition(() => {
      router.push('/admin/audit-log');
    });
  }

  const hasFilters =
    currentEntityType !== '' ||
    currentEntityId !== '' ||
    currentUserId !== ALL_VALUE ||
    currentAction !== ALL_VALUE ||
    currentFrom !== '' ||
    currentTo !== '';

  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="space-y-1.5">
        <Label htmlFor="al-entity-type">Entity type</Label>
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            id="al-entity-type"
            placeholder="e.g. Bill"
            value={entityType}
            onChange={(e) => setEntityType(e.target.value)}
            className="w-48 pl-8"
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="al-entity-id">Entity ID</Label>
        <Input
          id="al-entity-id"
          placeholder="cuid…"
          value={entityId}
          onChange={(e) => setEntityId(e.target.value)}
          className="w-48 font-mono text-xs"
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="al-action">Action</Label>
        <Select
          value={currentAction}
          onValueChange={(v) => apply({ action: v, skip: '0' })}
        >
          <SelectTrigger id="al-action" className="w-48">
            <SelectValue placeholder="All actions" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_VALUE}>All actions</SelectItem>
            {ACTIONS.map((a) => (
              <SelectItem key={a.value} value={a.value}>
                {a.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="al-user">User</Label>
        <Select
          value={currentUserId}
          onValueChange={(v) => apply({ userId: v, skip: '0' })}
        >
          <SelectTrigger id="al-user" className="w-56">
            <SelectValue placeholder="All users" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_VALUE}>All users</SelectItem>
            {users.map((u) => (
              <SelectItem key={u.id} value={u.id}>
                {u.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="al-from">From</Label>
        <Input
          id="al-from"
          type="date"
          value={currentFrom}
          onChange={(e) =>
            apply({ from: e.target.value || null, skip: '0' })
          }
          className="w-40"
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="al-to">To</Label>
        <Input
          id="al-to"
          type="date"
          value={currentTo}
          onChange={(e) => apply({ to: e.target.value || null, skip: '0' })}
          className="w-40"
        />
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
