'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { toast } from '@/lib/toast';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { PERMISSION_GROUPS } from '@/lib/permissions/constants';

export type RoleFormMode =
  | { kind: 'create' }
  | { kind: 'edit'; roleId: string };

export type RoleFormDefaults = {
  name: string;
  description: string;
  permissions: Record<string, boolean>;
};

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

export function RoleForm({
  mode,
  defaults,
}: {
  mode: RoleFormMode;
  defaults?: RoleFormDefaults;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState(defaults?.name ?? '');
  const [description, setDescription] = useState(defaults?.description ?? '');
  const [perms, setPerms] = useState<Record<string, boolean>>(
    defaults?.permissions ?? {},
  );

  const grantedCount = useMemo(
    () => Object.values(perms).filter(Boolean).length,
    [perms],
  );

  function toggle(key: string, value: boolean) {
    setPerms((prev) => {
      const next = { ...prev };
      if (value) next[key] = true;
      else delete next[key];
      return next;
    });
  }

  function toggleGroup(keys: string[], value: boolean) {
    setPerms((prev) => {
      const next = { ...prev };
      for (const k of keys) {
        if (value) next[k] = true;
        else delete next[k];
      }
      return next;
    });
  }

  function submit() {
    if (name.trim() === '') {
      toast.error('Name is required');
      return;
    }
    startTransition(async () => {
      try {
        const payload = {
          name: name.trim(),
          description: description.trim() === '' ? null : description.trim(),
          permissions: perms,
        };
        const url =
          mode.kind === 'create'
            ? '/api/admin/roles'
            : `/api/admin/roles/${mode.roleId}`;
        const res = await fetch(url, {
          method: mode.kind === 'create' ? 'POST' : 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          toast.error(await readApiError(res));
          return;
        }
        toast.success(mode.kind === 'create' ? 'Role created' : 'Saved');
        router.push('/admin/roles');
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
          <CardTitle className="text-sm">Role</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Field>
            <FieldLabel htmlFor="role-name">Name</FieldLabel>
            <Input
              id="role-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Sales Rep, Warehouse Manager"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="role-description">Description</FieldLabel>
            <Textarea
              id="role-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              placeholder="Optional — what this role is for."
            />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-sm">Permissions</CardTitle>
          <span className="text-xs text-muted-foreground">
            {grantedCount} granted
          </span>
        </CardHeader>
        <CardContent className="space-y-6">
          {PERMISSION_GROUPS.map((group) => {
            const keys = group.permissions.map((p) => p.key);
            const allOn = keys.every((k) => perms[k]);
            const someOn = keys.some((k) => perms[k]);
            return (
              <div key={group.id} className="space-y-3">
                <div className="flex items-center gap-2 border-b pb-1.5">
                  <Checkbox
                    id={`group-${group.id}`}
                    checked={allOn}
                    indeterminate={someOn && !allOn}
                    onCheckedChange={(v) => toggleGroup(keys, v === true)}
                  />
                  <FieldLabel
                    htmlFor={`group-${group.id}`}
                    className="text-sm font-semibold"
                  >
                    {group.module}
                  </FieldLabel>
                </div>
                <div className="grid grid-cols-1 gap-x-6 gap-y-2.5 pl-6 sm:grid-cols-2 lg:grid-cols-3">
                  {group.permissions.map((p) => {
                    const hint = 'hint' in p ? p.hint : undefined;
                    return (
                      <label
                        key={p.key}
                        htmlFor={p.key}
                        className="flex items-start gap-2 text-sm"
                      >
                        <Checkbox
                          id={p.key}
                          checked={!!perms[p.key]}
                          onCheckedChange={(v) => toggle(p.key, v === true)}
                          className="mt-0.5"
                        />
                        <span>
                          <span className="font-medium">{p.label}</span>
                          {hint ? (
                            <span className="block text-xs text-muted-foreground">
                              {hint}
                            </span>
                          ) : null}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>

      <div className="flex items-center justify-end gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={pending}
          render={<Link href="/admin/roles" />}
        >
          Cancel
        </Button>
        <Button size="sm" disabled={pending} onClick={submit}>
          {pending
            ? 'Saving…'
            : mode.kind === 'create'
              ? 'Create role'
              : 'Save changes'}
        </Button>
      </div>
    </div>
  );
}
