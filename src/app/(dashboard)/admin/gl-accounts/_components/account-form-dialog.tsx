'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
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

const TYPES: Array<{ value: string; label: string }> = [
  { value: 'ASSET', label: 'Asset' },
  { value: 'LIABILITY', label: 'Liability' },
  { value: 'EQUITY', label: 'Equity' },
  { value: 'REVENUE', label: 'Revenue' },
  { value: 'EXPENSE', label: 'Expense' },
];

export type AccountFormDialogAccount = {
  id: string;
  code: string;
  name: string;
  type: string;
  active: boolean;
};

type ApiErrorBody = {
  error?: string;
  issues?: Array<{ path?: Array<string | number>; message?: string }>;
};

async function readApiError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as ApiErrorBody;
    if (body.issues?.length) {
      const issue = body.issues[0];
      const path = issue.path?.length ? issue.path.join('.') + ': ' : '';
      return `${path}${issue.message ?? 'validation error'}`;
    }
    return body.error ?? `Request failed (${res.status})`;
  } catch {
    return `Request failed (${res.status})`;
  }
}

// Shared add + edit dialog. Type and code are CREATE-only — the
// service rejects updates to either (type changes have GL
// classification implications; code is the stable identifier
// referenced by services).
export function AccountFormDialog({
  account,
  open,
  onOpenChange,
}: {
  account: AccountFormDialogAccount | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [type, setType] = useState<string>('ASSET');
  const [active, setActive] = useState(true);
  const [errors, setErrors] = useState<Partial<Record<string, string>>>({});

  useEffect(() => {
    if (!open) return;
    setErrors({});
    if (account) {
      setCode(account.code);
      setName(account.name);
      setType(account.type);
      setActive(account.active);
    } else {
      setCode('');
      setName('');
      setType('ASSET');
      setActive(true);
    }
  }, [open, account]);

  function submit() {
    const next: Partial<Record<string, string>> = {};
    if (!account && code.trim() === '') next.code = 'Required';
    if (name.trim() === '') next.name = 'Required';
    if (Object.keys(next).length > 0) {
      setErrors(next);
      return;
    }
    setErrors({});
    const isEdit = account != null;
    const url = isEdit ? `/api/gl-accounts/${account.id}` : `/api/gl-accounts`;
    const method = isEdit ? 'PATCH' : 'POST';
    const body = isEdit
      ? { name: name.trim(), active }
      : { code: code.trim(), name: name.trim(), type, active };
    startTransition(async () => {
      try {
        const res = await fetch(url, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          toast.error(await readApiError(res));
          return;
        }
        toast.success(isEdit ? 'Saved account' : 'Added account');
        onOpenChange(false);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Network error');
      }
    });
  }

  const isEdit = account != null;

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {isEdit ? 'Edit GL account' : 'Add GL account'}
          </AlertDialogTitle>
          <AlertDialogDescription>
            Code and type are fixed on edit — services reference them as
            stable identifiers, and type changes have classification
            implications. Archive (active = off) instead of changing.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field>
              <FieldLabel htmlFor="acct-code">Code</FieldLabel>
              <Input
                id="acct-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                disabled={isEdit}
                aria-invalid={!!errors.code}
                className="font-mono"
                placeholder="e.g. 5100"
              />
              <FieldError
                errors={[errors.code ? { message: errors.code } : undefined]}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="acct-type">Type</FieldLabel>
              <Select
                value={type}
                onValueChange={(v) => setType(v ?? 'ASSET')}
                disabled={isEdit}
              >
                <SelectTrigger id="acct-type" className="w-full">
                  <SelectValue>
                    {(v) =>
                      TYPES.find((t) => t.value === v)?.label ?? v
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {TYPES.map((t) => (
                    <SelectItem key={t.value} value={t.value}>
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
          <Field>
            <FieldLabel htmlFor="acct-name">Name</FieldLabel>
            <Input
              id="acct-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-invalid={!!errors.name}
            />
            <FieldError
              errors={[errors.name ? { message: errors.name } : undefined]}
            />
          </Field>
          <Field orientation="horizontal">
            <Checkbox
              id="acct-active"
              checked={active}
              onCheckedChange={(v) => setActive(v === true)}
            />
            <FieldLabel htmlFor="acct-active">Active</FieldLabel>
          </Field>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={submit} disabled={pending}>
            {pending ? 'Saving…' : isEdit ? 'Save' : 'Add account'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
