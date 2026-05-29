'use client';

import { useEffect, useMemo, useRef, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from '@/lib/toast';
import { useRepEmailDuplicate } from '../../sales-reps/_components/use-rep-email-duplicate';

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
// salesRepMode drives the three-way sales-rep selector:
//   not-linked: 'none' | 'link' | 'create'
//   linked:     'keep' | 'link' (switch) | 'none' (unlink)
// salesRepId holds the chosen rep for the 'link' path.
const salesRepModeEnum = z.enum(['none', 'link', 'create', 'keep']);

const createSchema = z.object({
  name: z.string().min(1, 'Required').max(255),
  email: z.string().email().max(255),
  password: passwordSchema,
  enabled: z.boolean(),
  isSuperAdmin: z.boolean(),
  forcePasswordReset: z.boolean(),
  roleId: z.string(),
  salesRepMode: salesRepModeEnum,
  salesRepId: z.string(),
  salesRepCode: z.string(),
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
  salesRepMode: salesRepModeEnum,
  salesRepId: z.string(),
  salesRepCode: z.string(),
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

// The rep this user is already linked to (edit mode only). Drives the
// "linked → keep / switch / unlink" branch of the sales-rep card.
export type LinkedRep = { id: string; code: string; name: string };

// Unlinked reps offered in the "Link to existing" / "Switch" dropdown, with
// email so the form can auto-detect a same-email match.
export type UnlinkedRep = {
  id: string;
  code: string;
  name: string;
  email: string | null;
};

const DEFAULT_VALUES: UserFormValues = {
  name: '',
  email: '',
  password: '',
  enabled: true,
  isSuperAdmin: false,
  forcePasswordReset: false,
  roleId: NO_ROLE,
  salesRepMode: 'none',
  salesRepId: '',
  salesRepCode: '',
  commissionEnabled: false,
  commissionBasis: 'REVENUE',
  commissionPercent: '',
};

// Sentinel for the "pick a rep" placeholder in the link dropdown.
const NO_REP = '__none__';

// Client-side mirror of deriveSalesRepCodeBase (name part only) — keeps the
// auto-suggested code in sync with what the server would generate.
function suggestRepCode(name: string): string {
  const words = name
    .split(/\s+/)
    .map((w) => w.replace(/[^A-Za-z0-9]/g, ''))
    .filter(Boolean);
  if (words.length >= 2) {
    const initials = words
      .map((w) => w.charAt(0))
      .join('')
      .toUpperCase()
      .slice(0, 4);
    if (initials.length >= 2) return initials;
  }
  if (words.length === 1 && words[0].length >= 2) {
    return words[0].toUpperCase().slice(0, 3);
  }
  return '';
}

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
  linkedRep = null,
  unlinkedReps = [],
}: {
  mode: UserFormMode;
  defaultValues?: Partial<UserFormValues>;
  roles?: RoleOption[];
  linkedRep?: LinkedRep | null;
  unlinkedReps?: UnlinkedRep[];
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
    setValue,
    formState: { errors },
  } = form;

  const salesRepMode = watch('salesRepMode');
  const salesRepId = watch('salesRepId');
  const name = watch('name');
  const email = watch('email');
  // Linked = already bound to a rep (edit).
  const isLinked = mode.kind === 'edit' && !!linkedRep;
  const isCreatingRep = salesRepMode === 'create';

  // Auto-suggest the rep code from the display name while creating a rep,
  // until the operator edits the code field themselves.
  const codeTouched = useRef(false);
  useEffect(() => {
    if (isCreatingRep && !codeTouched.current) {
      setValue('salesRepCode', suggestRepCode(name));
    }
  }, [name, isCreatingRep, setValue]);

  // Auto-detect: an unlinked rep whose email matches the typed/loaded email.
  // This is the duplicate-prevention guard — surface the existing rep so the
  // operator links instead of creating a second one (CREED vs CR).
  const matchingRep = useMemo(() => {
    const e = email.trim().toLowerCase();
    if (e === '') return null;
    return (
      unlinkedReps.find((r) => (r.email ?? '').toLowerCase() === e) ?? null
    );
  }, [email, unlinkedReps]);

  // While the operator hasn't manually picked a mode, mirror the auto-detect:
  // match → preselect "link" + that rep; no match → fall back to "none".
  // Once they touch the selector we stop steering. Skipped entirely when the
  // user is already linked (the "keep" default owns that case).
  const modeTouched = useRef(false);
  useEffect(() => {
    if (isLinked || modeTouched.current) return;
    if (matchingRep) {
      setValue('salesRepMode', 'link');
      setValue('salesRepId', matchingRep.id);
    } else {
      setValue('salesRepMode', 'none');
      setValue('salesRepId', '');
    }
  }, [matchingRep, isLinked, setValue]);

  // Same email-collision warning the sales-rep form shows — a new rep here
  // inherits the user's email. Only relevant while creating a rep.
  const repEmailDuplicate = useRepEmailDuplicate(isCreatingRep ? email : '');

  // Whether the preselected link is the auto-detected email match (drives the
  // "Found existing sales rep …" hint).
  const showAutoDetectHint =
    !isLinked &&
    salesRepMode === 'link' &&
    !!matchingRep &&
    salesRepId === matchingRep.id;

  function submit(values: UserFormValues) {
    // The "link"/"switch" path needs a chosen rep.
    if (values.salesRepMode === 'link' && values.salesRepId === '') {
      toast.error('Select a sales rep to link');
      return;
    }
    // Commission payload shared by the 'create' and 'keep' actions.
    const commission = {
      commissionEnabled: values.commissionEnabled,
      commissionBasis: values.commissionBasis,
      commissionPercent:
        values.commissionPercent.trim() === ''
          ? null
          : values.commissionPercent.trim(),
    };
    const codeField =
      values.salesRepCode.trim() !== ''
        ? { code: values.salesRepCode.trim() }
        : {};
    startTransition(async () => {
      try {
        if (mode.kind === 'create') {
          const payload: Record<string, unknown> = {
            name: values.name.trim(),
            email: values.email!.trim().toLowerCase(),
            password: values.password!,
            isSuperAdmin: values.isSuperAdmin,
            forcePasswordReset: values.forcePasswordReset,
          };
          // Three-way selector: link an existing rep, or create a new one.
          if (values.salesRepMode === 'link') {
            payload.salesRep = { action: 'link', repId: values.salesRepId };
          } else if (values.salesRepMode === 'create') {
            payload.salesRep = { action: 'create', ...codeField, ...commission };
          }
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
          const m = values.salesRepMode;
          const salesRep =
            m === 'link'
              ? { action: 'link' as const, repId: values.salesRepId }
              : m === 'create'
                ? { action: 'create' as const, ...codeField, ...commission }
                : m === 'keep'
                  ? { action: 'keep' as const, ...commission }
                  : { action: 'none' as const };
          const payload: Record<string, unknown> = {
            name: values.name.trim(),
            isSuperAdmin: values.isSuperAdmin,
            forcePasswordReset: values.forcePasswordReset,
            roleId: values.roleId === NO_ROLE ? null : values.roleId,
            salesRep,
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

  // Options differ by linked state: a linked user keeps/switches/unlinks; an
  // unlinked one has no rep, links an existing one, or creates a new one.
  const modeOptions: Array<{ value: string; label: string }> = isLinked
    ? [
        { value: 'keep', label: `Keep linked to ${linkedRep?.code ?? ''}` },
        { value: 'link', label: 'Switch to a different rep' },
        { value: 'none', label: 'Unlink' },
      ]
    : [
        { value: 'none', label: 'No sales rep' },
        { value: 'link', label: 'Link to existing sales rep' },
        { value: 'create', label: 'Create new sales rep' },
      ];
  const modeLabel = (val: string) =>
    modeOptions.find((o) => o.value === val)?.label ?? val;

  // Commission inputs reused by the 'create' (new rep) and 'keep' (edit the
  // linked rep) branches.
  const commissionFields = (
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
          <FieldLabel htmlFor="commissionEnabled">Earns commission</FieldLabel>
          <p className="text-xs text-muted-foreground">
            Off for salaried reps — the commission engine skips them.
          </p>
        </div>
      </Field>
      <Field>
        <FieldLabel htmlFor="commissionBasis">Commission basis</FieldLabel>
        <Controller
          control={control}
          name="commissionBasis"
          render={({ field }) => (
            <Select value={field.value} onValueChange={field.onChange}>
              <SelectTrigger id="commissionBasis" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="REVENUE">Revenue</SelectItem>
                <SelectItem value="MARGIN">Margin (revenue − COGS)</SelectItem>
              </SelectContent>
            </Select>
          )}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="commissionPercent">Commission rate (%)</FieldLabel>
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
  );

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

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Sales rep</CardTitle>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            {isLinked ? (
              <div className="rounded-md border bg-muted/30 p-3 text-sm">
                Currently linked to{' '}
                <Link
                  href={`/admin/sales-reps/${linkedRep.id}/edit`}
                  className="font-medium underline"
                >
                  {linkedRep.code} — {linkedRep.name}
                </Link>
                . Edit the rep there to rename it or change its code.
              </div>
            ) : null}

            <Field>
              <FieldLabel htmlFor="salesRepMode">
                {isLinked ? 'Sales-rep link' : 'Sales rep'}
              </FieldLabel>
              <Controller
                control={control}
                name="salesRepMode"
                render={({ field }) => (
                  <Select
                    value={field.value}
                    onValueChange={(v) => {
                      modeTouched.current = true;
                      field.onChange(v);
                    }}
                  >
                    <SelectTrigger id="salesRepMode" className="w-full">
                      <SelectValue>{(v) => modeLabel(v ?? '')}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {modeOptions.map((o) => (
                        <SelectItem key={o.value} value={o.value}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </Field>

            {salesRepMode === 'link' ? (
              <Field>
                <FieldLabel htmlFor="salesRepId">
                  {isLinked ? 'New sales rep' : 'Existing sales rep'}
                </FieldLabel>
                {unlinkedReps.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No unlinked sales reps available. Create a new one instead,
                    or unlink another user first.
                  </p>
                ) : (
                  <Controller
                    control={control}
                    name="salesRepId"
                    render={({ field }) => (
                      <Select
                        value={field.value === '' ? NO_REP : field.value}
                        onValueChange={(v) =>
                          field.onChange(v === NO_REP ? '' : v)
                        }
                      >
                        <SelectTrigger id="salesRepId" className="w-full">
                          <SelectValue placeholder="Select a sales rep">
                            {(v) => {
                              if (v === NO_REP || v == null)
                                return 'Select a sales rep';
                              const r = unlinkedReps.find((x) => x.id === v);
                              return r ? `${r.code} — ${r.name}` : v;
                            }}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={NO_REP}>
                            Select a sales rep
                          </SelectItem>
                          {unlinkedReps.map((r) => (
                            <SelectItem key={r.id} value={r.id}>
                              {r.code} — {r.name}
                              {r.email ? ` (${r.email})` : ''}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  />
                )}
                {showAutoDetectHint && matchingRep ? (
                  <p className="text-xs text-emerald-700">
                    Found existing sales rep {matchingRep.code} (
                    {matchingRep.name}) with matching email — linking to it
                    instead of creating a duplicate.
                  </p>
                ) : null}
              </Field>
            ) : null}

            {salesRepMode === 'create' ? (
              <>
                <Field>
                  <FieldLabel htmlFor="salesRepCode">Sales rep code</FieldLabel>
                  <Input
                    id="salesRepCode"
                    placeholder="e.g. JDOE"
                    {...register('salesRepCode', {
                      onChange: () => {
                        codeTouched.current = true;
                      },
                    })}
                  />
                  <p className="text-xs text-muted-foreground">
                    Auto-suggested from the name; edit if you prefer another.
                    Must be unique across all reps.
                  </p>
                  {repEmailDuplicate ? (
                    <p className="text-xs text-amber-700">
                      A sales rep with this email already exists:{' '}
                      <Link
                        href={`/admin/sales-reps/${repEmailDuplicate.id}/edit`}
                        className="font-medium underline"
                      >
                        {repEmailDuplicate.code} — {repEmailDuplicate.name}
                      </Link>
                      . Consider linking to it instead of creating a duplicate.
                    </p>
                  ) : null}
                </Field>
                {commissionFields}
              </>
            ) : null}

            {salesRepMode === 'keep' ? commissionFields : null}
          </FieldGroup>
        </CardContent>
      </Card>

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
