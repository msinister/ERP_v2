'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from '@/lib/toast';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Field, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export type GlAccountOption = {
  id: string;
  code: string;
  name: string;
};

export type WarehouseFormDialogWarehouse = {
  id: string;
  code: string;
  name: string;
  active: boolean;
  inventoryAccountId: string | null;
};

const NO_ACCOUNT = '__none__';

export function WarehouseFormDialog({
  warehouse,
  open,
  onOpenChange,
  glAccounts,
}: {
  warehouse: WarehouseFormDialogWarehouse | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  glAccounts: GlAccountOption[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [active, setActive] = useState(true);
  const [inventoryAccountId, setInventoryAccountId] = useState<string>(NO_ACCOUNT);
  const [errors, setErrors] = useState<Partial<Record<string, string>>>({});

  useEffect(() => {
    if (!open) return;
    setErrors({});
    if (warehouse) {
      setCode(warehouse.code);
      setName(warehouse.name);
      setActive(warehouse.active);
      setInventoryAccountId(warehouse.inventoryAccountId ?? NO_ACCOUNT);
    } else {
      setCode('');
      setName('');
      setActive(true);
      setInventoryAccountId(NO_ACCOUNT);
    }
  }, [open, warehouse]);

  function submit() {
    const next: Partial<Record<string, string>> = {};
    if (!warehouse && code.trim() === '') next.code = 'Required';
    if (name.trim() === '') next.name = 'Required';
    if (Object.keys(next).length > 0) {
      setErrors(next);
      return;
    }
    setErrors({});

    const isEdit = warehouse != null;
    const url = isEdit ? `/api/warehouses/${warehouse.id}` : '/api/warehouses';
    const method = isEdit ? 'PUT' : 'POST';
    const body = {
      ...(isEdit ? {} : { code: code.trim() }),
      name: name.trim(),
      active,
      inventoryAccountId: inventoryAccountId === NO_ACCOUNT ? null : inventoryAccountId,
    };

    startTransition(async () => {
      try {
        const res = await fetch(url, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({})) as { error?: string; issues?: Array<{ message?: string }> };
          if (err.error === 'code already exists') {
            setErrors({ code: 'Code already in use' });
            return;
          }
          toast.error(err.issues?.[0]?.message ?? err.error ?? `Request failed (${res.status})`);
          return;
        }
        toast.success(isEdit ? 'Warehouse saved' : 'Warehouse created');
        onOpenChange(false);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Network error');
      }
    });
  }

  const isEdit = warehouse != null;

  const selectedAccount = glAccounts.find((a) => a.id === inventoryAccountId);

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {isEdit ? 'Edit warehouse' : 'Add warehouse'}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {isEdit
              ? 'Update the warehouse name, inventory GL account, or active status.'
              : 'Create a new warehouse. The code is permanent once set.'}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field>
              <FieldLabel htmlFor="wh-code">Code</FieldLabel>
              <Input
                id="wh-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                disabled={isEdit}
                aria-invalid={!!errors.code}
                className="font-mono"
                placeholder="e.g. WH-01"
              />
              <FieldError
                errors={[errors.code ? { message: errors.code } : undefined]}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="wh-name">Name</FieldLabel>
              <Input
                id="wh-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                aria-invalid={!!errors.name}
                placeholder="Main warehouse"
              />
              <FieldError
                errors={[errors.name ? { message: errors.name } : undefined]}
              />
            </Field>
          </div>

          <Field>
            <FieldLabel htmlFor="wh-inv-acct">Inventory GL Account</FieldLabel>
            <Select
              value={inventoryAccountId}
              onValueChange={(v) => setInventoryAccountId(v ?? NO_ACCOUNT)}
            >
              <SelectTrigger id="wh-inv-acct" className="w-full">
                <SelectValue>
                  {() =>
                    selectedAccount
                      ? `${selectedAccount.code} — ${selectedAccount.name}`
                      : 'None'
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_ACCOUNT}>
                  <span className="text-muted-foreground">None</span>
                </SelectItem>
                {glAccounts.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    <span className="font-mono text-xs">{a.code}</span>
                    {' — '}
                    {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Required for COGS posting when closing sales orders.
            </p>
          </Field>

          <Field orientation="horizontal">
            <Checkbox
              id="wh-active"
              checked={active}
              onCheckedChange={(v) => setActive(v === true)}
            />
            <FieldLabel htmlFor="wh-active">Active</FieldLabel>
          </Field>
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={submit} disabled={pending}>
            {pending ? 'Saving…' : isEdit ? 'Save' : 'Add warehouse'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
