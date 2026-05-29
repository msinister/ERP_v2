'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { toast } from '@/lib/toast';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useRepEmailDuplicate } from './use-rep-email-duplicate';

export type SalesRepFormMode =
  | { kind: 'create' }
  | { kind: 'edit'; repId: string };

export type UserOption = { id: string; name: string; email: string };

export type SalesRepFormDefaults = {
  code: string;
  name: string;
  email: string;
  active: boolean;
  commissionEnabled: boolean;
  commissionBasis: 'REVENUE' | 'MARGIN';
  commissionPercent: string;
  // '' = no linked login. Otherwise the linked User id.
  linkUserId: string;
};

const EMPTY: SalesRepFormDefaults = {
  code: '',
  name: '',
  email: '',
  active: true,
  commissionEnabled: false,
  commissionBasis: 'REVENUE',
  commissionPercent: '',
  linkUserId: '',
};

// Select can't hold an empty-string value, so the "no link" option uses a
// sentinel that maps back to ''.
const NO_USER = '__none__';

async function readApiError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as {
      error?: string;
      issues?: Array<{ message?: string }>;
    };
    if (body.issues?.length) return body.issues[0].message ?? 'validation error';
    return body.error ?? `Request failed (${res.status})`;
  } catch {
    return `Request failed (${res.status})`;
  }
}

export function SalesRepForm({
  mode,
  defaults,
  users = [],
}: {
  mode: SalesRepFormMode;
  defaults?: Partial<SalesRepFormDefaults>;
  users?: UserOption[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [v, setV] = useState<SalesRepFormDefaults>({ ...EMPTY, ...defaults });
  const isCreate = mode.kind === 'create';
  const emailDuplicate = useRepEmailDuplicate(
    v.email,
    isCreate ? undefined : (mode as { repId: string }).repId,
  );

  function set<K extends keyof SalesRepFormDefaults>(
    key: K,
    value: SalesRepFormDefaults[K],
  ) {
    setV((prev) => ({ ...prev, [key]: value }));
  }

  function submit() {
    if (v.name.trim() === '') {
      toast.error('Name is required');
      return;
    }
    if (isCreate && v.code.trim() === '') {
      toast.error('Code is required');
      return;
    }
    if (
      v.commissionPercent.trim() !== '' &&
      (Number.isNaN(Number(v.commissionPercent)) ||
        Number(v.commissionPercent) < 0)
    ) {
      toast.error('Commission rate must be a number ≥ 0');
      return;
    }
    startTransition(async () => {
      try {
        const email = v.email.trim();
        const percent =
          v.commissionPercent.trim() === '' ? null : v.commissionPercent.trim();
        const basis = v.commissionEnabled ? v.commissionBasis : null;

        const url = isCreate
          ? '/api/admin/sales-reps'
          : `/api/admin/sales-reps/${(mode as { repId: string }).repId}`;
        const payload = isCreate
          ? {
              code: v.code.trim(),
              name: v.name.trim(),
              ...(email !== '' ? { email } : {}),
              active: v.active,
              commissionEnabled: v.commissionEnabled,
              commissionBasis: basis,
              commissionPercent: percent,
              // Only send a link when one is chosen; absent = standalone rep.
              ...(v.linkUserId !== '' ? { linkUserId: v.linkUserId } : {}),
            }
          : {
              name: v.name.trim(),
              email: email === '' ? null : email,
              active: v.active,
              commissionEnabled: v.commissionEnabled,
              commissionBasis: basis,
              commissionPercent: percent,
              // Always send on edit — the dropdown reflects the intended
              // state, and null explicitly unlinks.
              linkUserId: v.linkUserId === '' ? null : v.linkUserId,
            };

        const res = await fetch(url, {
          method: isCreate ? 'POST' : 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          toast.error(await readApiError(res));
          return;
        }
        toast.success(isCreate ? 'Sales rep created' : 'Saved');
        router.push('/admin/sales-reps');
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Network error');
      }
    });
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Identity</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Field>
            <FieldLabel htmlFor="code">Code</FieldLabel>
            <Input
              id="code"
              value={v.code}
              onChange={(e) => set('code', e.target.value)}
              disabled={!isCreate}
              placeholder="e.g. JDOE"
            />
            {!isCreate ? (
              <p className="text-xs text-muted-foreground">
                Code is immutable after creation.
              </p>
            ) : null}
          </Field>
          <Field>
            <FieldLabel htmlFor="name">Name</FieldLabel>
            <Input
              id="name"
              value={v.name}
              onChange={(e) => set('name', e.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="email">Email</FieldLabel>
            <Input
              id="email"
              type="email"
              value={v.email}
              onChange={(e) => set('email', e.target.value)}
            />
            {emailDuplicate ? (
              <p className="text-xs text-amber-700">
                A sales rep with this email already exists:{' '}
                <Link
                  href={`/admin/sales-reps/${emailDuplicate.id}/edit`}
                  className="font-medium underline"
                >
                  {emailDuplicate.code} — {emailDuplicate.name}
                </Link>
                . You can still save, but check this isn’t a duplicate.
              </p>
            ) : null}
          </Field>
          <Field orientation="horizontal">
            <Checkbox
              id="active"
              checked={v.active}
              onCheckedChange={(c) => set('active', c === true)}
            />
            <FieldLabel htmlFor="active">Active</FieldLabel>
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Commission</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Field orientation="horizontal">
            <Checkbox
              id="commissionEnabled"
              checked={v.commissionEnabled}
              onCheckedChange={(c) => set('commissionEnabled', c === true)}
            />
            <div>
              <FieldLabel htmlFor="commissionEnabled">
                Earns commission
              </FieldLabel>
              <p className="text-xs text-muted-foreground">
                Off for salaried reps — the commission engine skips them.
              </p>
            </div>
          </Field>

          {v.commissionEnabled ? (
            <>
              <Field>
                <FieldLabel htmlFor="commissionBasis">Basis</FieldLabel>
                <Select
                  value={v.commissionBasis}
                  onValueChange={(val) =>
                    set('commissionBasis', val as 'REVENUE' | 'MARGIN')
                  }
                >
                  <SelectTrigger id="commissionBasis" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="REVENUE">Revenue</SelectItem>
                    <SelectItem value="MARGIN">
                      Margin (revenue − COGS)
                    </SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor="commissionPercent">Rate (%)</FieldLabel>
                <Input
                  id="commissionPercent"
                  inputMode="decimal"
                  placeholder="e.g. 5"
                  value={v.commissionPercent}
                  onChange={(e) => set('commissionPercent', e.target.value)}
                />
              </Field>
            </>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Login link</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Field>
            <FieldLabel htmlFor="linkUserId">Linked user</FieldLabel>
            <Select
              value={v.linkUserId === '' ? NO_USER : v.linkUserId}
              onValueChange={(val) =>
                set('linkUserId', val == null || val === NO_USER ? '' : val)
              }
            >
              <SelectTrigger id="linkUserId" className="w-full">
                <SelectValue placeholder="No linked user">
                  {(val) => {
                    if (val === NO_USER) return 'No linked user';
                    const u = users.find((x) => x.id === val);
                    return u ? `${u.name} (${u.email})` : val;
                  }}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_USER}>No linked user</SelectItem>
                {users.map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    {u.name} ({u.email})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Connects this rep to a login. Only users not already linked to
              another rep are listed. Clear it to unlink.
            </p>
          </Field>
        </CardContent>
      </Card>

      <div className="flex items-center justify-end gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={pending}
          render={<Link href="/admin/sales-reps" />}
        >
          Cancel
        </Button>
        <Button size="sm" disabled={pending} onClick={submit}>
          {pending ? 'Saving…' : isCreate ? 'Create sales rep' : 'Save changes'}
        </Button>
      </div>
    </div>
  );
}
