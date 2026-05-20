'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

// ===========================================================================
// Form schema — mirrors the POST /api/admin/users + PATCH endpoints.
// Password policy matches the create-first-super-admin script (8+ chars,
// upper/lower/digit/special). Email + password are create-only; the
// edit path PATCHes name + role + enabled + forcePasswordReset, plus the
// custom-role assignment and the sales-rep link + commission fields.
// ===========================================================================

const passwordSchema = z
  .string()
  .min(8, 'Must be at least 8 characters')
  .refine((v) => /[A-Z]/.test(v), 'Must include an uppercase letter')
  .refine((v) => /[a-z]/.test(v), 'Must include a lowercase letter')
  .refine((v) => /\d/.test(v), 'Must include a digit')
  .refine((v) => /[^A-Za-z0-9]/.test(v), 'Must include a special character');

// Sentinel for the "no role" Select option (empty string values aren't
// allowed by the Select primitive).
const NO_ROLE = '__none__';

// Both schemas resolve to the same TS shape so RHF's Resolver type stays
// consistent across create/edit. Email + password validate strictly in
// create mode; in edit mode email is read-only and password is carrier-
// only — both get stripped from the PATCH payload. Role + sales-rep fields
// are edit-only (the create endpoint ignores them).
const createSchema = z.object({
  name: z.string().min(1, 'Required').max(255),
  email: z.string().email().max(255),
  password: passwordSchema,
  enabled: z.boolean(),
  isSuperAdmin: z.boolean(),
  forcePasswordReset: z.boolean(),
  roleId: z.string(),
  isSalesRep: z.boolean(),
  commissionEnabled: z.boolean(),
  commissionBasis: z.enum(['REVENUE', 'MARGIN']),
  commissionPercent: z.string(),
});

const editSchema = z.object({
  name: z.string().min(1, 'Required').max(255),
  email: z.string().max(255),
  password: z.string(),
  enabled: z.boolean(),
  isSuperAdmin: z.boolean(),
  forcePasswordReset: z.boolean(),
  roleId: z.string(),
  isSalesRep: z.boolean(),
  commissionEnabled: z.boolean(),
  commissionBasis: z.enum(['REVENUE', 'MARGIN']),
  commissionPercent: z
    .string()
    .refine(
      (v) => v.trim() === '' || (!Number.isNaN(Number(v)) && Number(v) >= 0),
      'Must be a number ≥ 0',
    ),
});

export type UserFormValues = z.infer<typeof createSchema>;

export type UserFormMode =
  | { kind: 'create' }
  | { kind: 'edit'; userId: string; isSelf: boolean };

export type RoleOption = { id: string; name: string };

const DEFAULT_VALUES: UserFormValues = {
  name: '',
  email: '',
  password: '',
  enabled: true,
  isSuperAdmin: false,
  forcePasswordReset: false,
  roleId: NO_ROLE,
  isSalesRep: false,
  commissionEnabled: false,
  commissionBasis: 'REVENUE',
  commissionPercent: '',
};

type ApiErrorBody = {
  error?: string;
  issues?: Array<{ path?: Array<string | number>; message?: string }>;
};

type ApiOkBody = { unlinkWarning?: { assignedCustomerCount: number } };

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

export function UserForm({
  mode,
  defaultValues,
  roles = [],
}: {
  mode: UserFormMode;
  defaultValues?: Partial<UserFormValues>;
  roles?: RoleOption[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const form = useForm<UserFormValues>({
    resolver: zodResolver(mode.kind === 'create' ? createSchema : editSchema),
    defaultValues: { ...DEFAULT_VALUES, ...defaultValues },
  });
  const {
    register,
    handleSubmit,
    control,
    watch,
    formState: { errors },
  } = form;

  const isSalesRep = watch('isSalesRep');

  function submit(values: UserFormValues) {
    startTransition(async () => {
      try {
        if (mode.kind === 'create') {
          const payload = {
            name: values.name.trim(),
            email: values.email!.trim().toLowerCase(),
            password: values.password!,
            isSuperAdmin: values.isSuperAdmin,
            forcePasswordReset: values.forcePasswordReset,
          };
          const res = await fetch('/api/admin/users', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          if (!res.ok) {
            toast.error(await readApiError(res));
            return;
          }
          toast.success(`Created ${payload.email}`);
          router.push('/admin/users');
          router.refresh();
        } else {
          // PATCH only the fields the endpoint accepts. Self-edits hide
          // the destructive toggles, but defense in depth: even if the
          // form bypassed that, the server rejects self-disable /
          // self-demote.
          const payload: Record<string, unknown> = {
            name: values.name.trim(),
            isSuperAdmin: values.isSuperAdmin,
            forcePasswordReset: values.forcePasswordReset,
            roleId: values.roleId === NO_ROLE ? null : values.roleId,
            salesRep: {
              isSalesRep: values.isSalesRep,
              ...(values.isSalesRep
                ? {
                    commissionEnabled: values.commissionEnabled,
                    commissionBasis: values.commissionBasis,
                    commissionPercent:
                      values.commissionPercent.trim() === ''
                        ? null
                        : values.commissionPercent.trim(),
                  }
                : {}),
            },
          };
          if (!mode.isSelf) {
            payload.enabled = values.enabled;
          }
          const res = await fetch(`/api/admin/users/${mode.userId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          if (!res.ok) {
            toast.error(await readApiError(res));
            return;
          }
          const body = (await res.json().catch(() => ({}))) as ApiOkBody;
          if (body.unlinkWarning) {
            toast.warning(
              `Unlinked — the sales rep still has ${body.unlinkWarning.assignedCustomerCount} assigned customer(s). Reassign them so orders stay scoped correctly.`,
            );
          } else {
            toast.success('Saved');
          }
          router.push('/admin/users');
          router.refresh();
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Network error');
      }
    });
  }

  const isCreate = mode.kind === 'create';
  const isSelf = mode.kind === 'edit' && mode.isSelf;

  return (
    <form onSubmit={handleSubmit(submit)} className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Identity</CardTitle>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="name">Display name</FieldLabel>
              <Input
                id="name"
                aria-invalid={!!errors.name}
                {...register('name')}
              />
              <FieldError errors={[errors.name]} />
            </Field>
            <Field>
              <FieldLabel htmlFor="email">Email</FieldLabel>
              <Input
                id="email"
                type="email"
                autoComplete="off"
                aria-invalid={!!errors.email}
                disabled={!isCreate}
                {...register('email')}
              />
              <FieldError errors={[errors.email]} />
              {!isCreate ? (
                <p className="text-xs text-muted-foreground">
                  Email is immutable — changing it would orphan audit
                  history. Disable the user and create a new account if
                  needed.
                </p>
              ) : null}
            </Field>
            {isCreate ? (
              <Field>
                <FieldLabel htmlFor="password">
                  Initial password (8+ chars, upper + lower + digit + special)
                </FieldLabel>
                <Input
                  id="password"
                  type="password"
                  autoComplete="new-password"
                  aria-invalid={!!errors.password}
                  {...register('password')}
                />
                <FieldError errors={[errors.password]} />
                <p className="text-xs text-muted-foreground">
                  Share this with the user out-of-band. Pair it with the
                  force-password-reset flag below to require they pick
                  their own on first login.
                </p>
              </Field>
            ) : null}
          </FieldGroup>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Access</CardTitle>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <Field orientation="horizontal">
              <Controller
                control={control}
                name="isSuperAdmin"
                render={({ field }) => (
                  <Checkbox
                    id="isSuperAdmin"
                    checked={field.value}
                    onCheckedChange={(v) => field.onChange(v === true)}
                    disabled={isSelf}
                  />
                )}
              />
              <div>
                <FieldLabel htmlFor="isSuperAdmin">Super admin</FieldLabel>
                <p className="text-xs text-muted-foreground">
                  Full access to every page, including this one.{' '}
                  {isSelf
                    ? "You can't demote your own account."
                    : 'Demoting a user keeps their audit history. Super admins bypass roles entirely.'}
                </p>
              </div>
            </Field>
            {!isCreate ? (
              <Field>
                <FieldLabel htmlFor="roleId">Role</FieldLabel>
                <Controller
                  control={control}
                  name="roleId"
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger id="roleId" className="w-full">
                        <SelectValue placeholder="No role">
                          {(v) =>
                            v === NO_ROLE
                              ? 'No role'
                              : (roles.find((r) => r.id === v)?.name ?? v)
                          }
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NO_ROLE}>No role</SelectItem>
                        {roles.map((r) => (
                          <SelectItem key={r.id} value={r.id}>
                            {r.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
                <p className="text-xs text-muted-foreground">
                  Custom role granting granular permissions. Ignored while
                  Super admin is on.
                </p>
              </Field>
            ) : null}
            {!isCreate ? (
              <Field orientation="horizontal">
                <Controller
                  control={control}
                  name="enabled"
                  render={({ field }) => (
                    <Checkbox
                      id="enabled"
                      checked={field.value}
                      onCheckedChange={(v) => field.onChange(v === true)}
                      disabled={isSelf}
                    />
                  )}
                />
                <div>
                  <FieldLabel htmlFor="enabled">Enabled</FieldLabel>
                  <p className="text-xs text-muted-foreground">
                    Uncheck to revoke login while preserving the audit
                    trail.{' '}
                    {isSelf ? "You can't disable your own account." : null}
                  </p>
                </div>
              </Field>
            ) : null}
            <Field orientation="horizontal">
              <Controller
                control={control}
                name="forcePasswordReset"
                render={({ field }) => (
                  <Checkbox
                    id="forcePasswordReset"
                    checked={field.value}
                    onCheckedChange={(v) => field.onChange(v === true)}
                  />
                )}
              />
              <div>
                <FieldLabel htmlFor="forcePasswordReset">
                  Force password reset on next login
                </FieldLabel>
                <p className="text-xs text-muted-foreground">
                  Flags the user — actual rotation happens on their next
                  successful sign-in.
                </p>
              </div>
            </Field>
          </FieldGroup>
        </CardContent>
      </Card>

      {!isCreate ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Sales rep</CardTitle>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <Field orientation="horizontal">
                <Controller
                  control={control}
                  name="isSalesRep"
                  render={({ field }) => (
                    <Checkbox
                      id="isSalesRep"
                      checked={field.value}
                      onCheckedChange={(v) => field.onChange(v === true)}
                    />
                  )}
                />
                <div>
                  <FieldLabel htmlFor="isSalesRep">
                    This user is a sales rep
                  </FieldLabel>
                  <p className="text-xs text-muted-foreground">
                    Links the user to a sales-rep record (created on demand).
                    Customers can then be assigned to them, and “view own”
                    scoping resolves through this link. Turning it off removes
                    the assignment — you’ll be warned if customers are still
                    assigned.
                  </p>
                </div>
              </Field>

              {isSalesRep ? (
                <>
                  <Field orientation="horizontal">
                    <Controller
                      control={control}
                      name="commissionEnabled"
                      render={({ field }) => (
                        <Checkbox
                          id="commissionEnabled"
                          checked={field.value}
                          onCheckedChange={(v) => field.onChange(v === true)}
                        />
                      )}
                    />
                    <div>
                      <FieldLabel htmlFor="commissionEnabled">
                        Earns commission
                      </FieldLabel>
                      <p className="text-xs text-muted-foreground">
                        Off for salaried reps — the commission engine skips
                        them.
                      </p>
                    </div>
                  </Field>

                  <Field>
                    <FieldLabel htmlFor="commissionBasis">
                      Commission basis
                    </FieldLabel>
                    <Controller
                      control={control}
                      name="commissionBasis"
                      render={({ field }) => (
                        <Select
                          value={field.value}
                          onValueChange={field.onChange}
                        >
                          <SelectTrigger
                            id="commissionBasis"
                            className="w-full"
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="REVENUE">Revenue</SelectItem>
                            <SelectItem value="MARGIN">
                              Margin (revenue − COGS)
                            </SelectItem>
                          </SelectContent>
                        </Select>
                      )}
                    />
                  </Field>

                  <Field>
                    <FieldLabel htmlFor="commissionPercent">
                      Commission rate (%)
                    </FieldLabel>
                    <Input
                      id="commissionPercent"
                      inputMode="decimal"
                      placeholder="e.g. 5"
                      aria-invalid={!!errors.commissionPercent}
                      {...register('commissionPercent')}
                    />
                    <FieldError errors={[errors.commissionPercent]} />
                  </Field>
                </>
              ) : null}
            </FieldGroup>
          </CardContent>
        </Card>
      ) : null}

      <div className="flex items-center justify-end gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={pending}
          render={<Link href="/admin/users" />}
        >
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? 'Saving…' : isCreate ? 'Create user' : 'Save changes'}
        </Button>
      </div>
    </form>
  );
}
