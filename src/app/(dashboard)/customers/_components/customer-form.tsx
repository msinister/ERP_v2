'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import Link from 'next/link';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';

// ===========================================================================
// Form schema
// ---------------------------------------------------------------------------
// UI-side zod schema. Mirrors createCustomerInputSchema's shape but uses
// '' (empty string) as the carrier for "no value" instead of the API
// schema's undefined/optional pattern — RHF + native inputs always
// produce strings, so coercing empties to undefined on submit is
// simpler than fighting the resolver. On submit we map to the API
// payload (createCustomerInputSchema-shaped) and POST it.
// ===========================================================================

const CUSTOMER_TYPES = [
  { value: 'WHOLESALE_REGULAR', label: 'Wholesale — regular' },
  { value: 'WHOLESALE_PREFERRED', label: 'Wholesale — preferred' },
  { value: 'WHOLESALE_DISTRIBUTOR', label: 'Wholesale — distributor' },
  {
    value: 'WHOLESALE_MASTER_DISTRIBUTOR',
    label: 'Wholesale — master distributor',
  },
  { value: 'RETAIL', label: 'Retail' },
] as const;

const customerTypeEnum = z.enum([
  'WHOLESALE_REGULAR',
  'WHOLESALE_PREFERRED',
  'WHOLESALE_DISTRIBUTOR',
  'WHOLESALE_MASTER_DISTRIBUTOR',
  'RETAIL',
]);

const optionalEmail = z
  .union([z.literal(''), z.string().email().max(255)])
  .optional();
const optionalDecimal = z
  .union([
    z.literal(''),
    z.string().regex(/^-?\d+(\.\d+)?$/, 'Must be a decimal'),
  ])
  .optional();
const optionalIntStr = z
  .union([z.literal(''), z.string().regex(/^\d+$/, 'Must be a whole number')])
  .optional();

// Billing is required for create (one billing address per customer
// captured inline). In edit mode the billing card is hidden — addresses
// are managed via the Addresses tab — and the PATCH endpoint doesn't
// accept billingAddress anyway, so we relax the validators to keep the
// stale form state from blocking submit.
const billingCommonShape = {
  label: z.string().max(255).optional(),
  attention: z.string().max(255).optional(),
  line2: z.string().max(500).optional(),
  country: z
    .union([z.literal(''), z.string().length(2, 'ISO-3166 alpha-2')])
    .optional(),
  phone: z.string().max(64).optional(),
};

const createBillingSchema = z.object({
  ...billingCommonShape,
  line1: z.string().min(1, 'Required').max(500),
  city: z.string().min(1, 'Required').max(255),
  region: z.string().min(1, 'Required').max(255),
  postalCode: z.string().min(1, 'Required').max(32),
});

// Edit mode: same value shape (string, not string | undefined) so the
// resolver-union stays assignable to a single CustomerFormValues type,
// but with no .min(1) — empty strings pass since the billing card is
// hidden in edit and stripped from the PATCH payload.
const editBillingSchema = z.object({
  ...billingCommonShape,
  line1: z.string().max(500),
  city: z.string().max(255),
  region: z.string().max(255),
  postalCode: z.string().max(32),
});

const baseShape = {
  name: z.string().min(1, 'Required').max(255),
  type: customerTypeEnum,
  salesRepId: z.string().min(1, 'Required'),
  paymentTermId: z.string().min(1, 'Required'),
  primaryPhone: z.string().max(64).optional(),
  primaryEmail: optionalEmail,
  creditLimit: optionalDecimal,
  arHoldDays: optionalIntStr,
  taxExempt: z.boolean(),
  resaleCertNumber: z.string().max(128).optional(),
  internalNotes: z.string().max(10000).optional(),
};

const createFormSchema = z.object({
  ...baseShape,
  billing: createBillingSchema,
});

const editFormSchema = z.object({
  ...baseShape,
  billing: editBillingSchema,
});

// Form values type tracks the create schema (the broader-required
// variant); edit defaults still satisfy it because the optional
// billing fields accept the same string shape.
export type CustomerFormValues = z.infer<typeof createFormSchema>;

export type LookupOption = { id: string; label: string };

const DEFAULT_VALUES: CustomerFormValues = {
  name: '',
  type: 'WHOLESALE_REGULAR',
  salesRepId: '',
  paymentTermId: '',
  primaryPhone: '',
  primaryEmail: '',
  creditLimit: '',
  arHoldDays: '',
  taxExempt: false,
  resaleCertNumber: '',
  internalNotes: '',
  billing: {
    label: '',
    attention: '',
    line1: '',
    line2: '',
    city: '',
    region: '',
    postalCode: '',
    country: '',
    phone: '',
  },
};

function nullEmpty(v: string | undefined): string | undefined {
  if (v == null) return undefined;
  const trimmed = v.trim();
  return trimmed === '' ? undefined : trimmed;
}

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

export type CustomerFormMode =
  | { kind: 'create' }
  | { kind: 'edit'; customerId: string };

export function CustomerForm({
  salesReps,
  paymentTerms,
  defaultValues,
  mode,
}: {
  salesReps: LookupOption[];
  paymentTerms: LookupOption[];
  defaultValues?: Partial<CustomerFormValues>;
  mode: CustomerFormMode;
}) {
  const submitLabel =
    mode.kind === 'create' ? 'Create customer' : 'Save changes';
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const form = useForm<CustomerFormValues>({
    resolver: zodResolver(
      mode.kind === 'create' ? createFormSchema : editFormSchema,
    ),
    defaultValues: { ...DEFAULT_VALUES, ...defaultValues },
  });
  const {
    register,
    handleSubmit,
    control,
    formState: { errors },
  } = form;

  function submit(values: CustomerFormValues) {
    startTransition(async () => {
      const payload: CustomerCreateApiPayload = {
        name: values.name.trim(),
        type: values.type,
        salesRepId: values.salesRepId,
        paymentTermId: values.paymentTermId,
        primaryPhone: nullEmpty(values.primaryPhone),
        primaryEmail: nullEmpty(values.primaryEmail),
        creditLimit: nullEmpty(values.creditLimit),
        arHoldDays:
          values.arHoldDays && values.arHoldDays.trim() !== ''
            ? Number(values.arHoldDays)
            : undefined,
        taxExempt: values.taxExempt,
        resaleCertNumber: nullEmpty(values.resaleCertNumber),
        internalNotes: nullEmpty(values.internalNotes),
        billingAddress: {
          kind: 'BILLING',
          label: nullEmpty(values.billing.label),
          attention: nullEmpty(values.billing.attention),
          line1: values.billing.line1.trim(),
          line2: nullEmpty(values.billing.line2),
          city: values.billing.city.trim(),
          region: values.billing.region.trim(),
          postalCode: values.billing.postalCode.trim(),
          country: nullEmpty(values.billing.country),
          phone: nullEmpty(values.billing.phone),
        },
      };
      try {
        const endpoint =
          mode.kind === 'create'
            ? '/api/customers'
            : `/api/customers/${mode.customerId}`;
        const method = mode.kind === 'create' ? 'POST' : 'PATCH';
        // The PATCH endpoint (updateCustomerInputSchema) doesn't take
        // billingAddress — addresses are managed separately via the
        // address routes once the customer exists.
        const body =
          mode.kind === 'create'
            ? payload
            : (() => {
                const { billingAddress: _b, ...rest } = payload;
                void _b;
                return rest;
              })();
        const res = await fetch(endpoint, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          toast.error(await readApiError(res));
          return;
        }
        const saved = (await res.json()) as { id: string; name: string };
        toast.success(
          mode.kind === 'create'
            ? `Created ${saved.name}`
            : `Saved ${saved.name}`,
        );
        router.push(`/customers/${saved.id}`);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Network error');
      }
    });
  }

  return (
    <form onSubmit={handleSubmit(submit)} className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Master</CardTitle>
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
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="type">Type</FieldLabel>
                <Controller
                  control={control}
                  name="type"
                  render={({ field }) => (
                    <Select
                      value={field.value}
                      onValueChange={field.onChange}
                    >
                      <SelectTrigger id="type" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {CUSTOMER_TYPES.map((t) => (
                          <SelectItem key={t.value} value={t.value}>
                            {t.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
                <FieldError errors={[errors.type]} />
              </Field>

              <Field>
                <FieldLabel htmlFor="salesRepId">Sales rep</FieldLabel>
                <Controller
                  control={control}
                  name="salesRepId"
                  render={({ field }) => (
                    <Select
                      value={field.value || undefined}
                      onValueChange={field.onChange}
                    >
                      <SelectTrigger
                        id="salesRepId"
                        className="w-full"
                        aria-invalid={!!errors.salesRepId}
                      >
                        <SelectValue placeholder="Select a sales rep" />
                      </SelectTrigger>
                      <SelectContent>
                        {salesReps.map((r) => (
                          <SelectItem key={r.id} value={r.id}>
                            {r.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
                <FieldError errors={[errors.salesRepId]} />
              </Field>

              <Field>
                <FieldLabel htmlFor="paymentTermId">Payment term</FieldLabel>
                <Controller
                  control={control}
                  name="paymentTermId"
                  render={({ field }) => (
                    <Select
                      value={field.value || undefined}
                      onValueChange={field.onChange}
                    >
                      <SelectTrigger
                        id="paymentTermId"
                        className="w-full"
                        aria-invalid={!!errors.paymentTermId}
                      >
                        <SelectValue placeholder="Select a payment term" />
                      </SelectTrigger>
                      <SelectContent>
                        {paymentTerms.map((t) => (
                          <SelectItem key={t.id} value={t.id}>
                            {t.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
                <FieldError errors={[errors.paymentTermId]} />
              </Field>
            </div>
          </FieldGroup>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Contact</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="primaryPhone">Primary phone</FieldLabel>
              <Input id="primaryPhone" {...register('primaryPhone')} />
              <FieldError errors={[errors.primaryPhone]} />
            </Field>
            <Field>
              <FieldLabel htmlFor="primaryEmail">Primary email</FieldLabel>
              <Input
                id="primaryEmail"
                type="email"
                aria-invalid={!!errors.primaryEmail}
                {...register('primaryEmail')}
              />
              <FieldError errors={[errors.primaryEmail]} />
            </Field>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Credit &amp; AR</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="creditLimit">
                Credit limit (USD, blank = no limit)
              </FieldLabel>
              <Input
                id="creditLimit"
                inputMode="decimal"
                placeholder="0.00"
                aria-invalid={!!errors.creditLimit}
                {...register('creditLimit')}
              />
              <FieldError errors={[errors.creditLimit]} />
            </Field>
            <Field>
              <FieldLabel htmlFor="arHoldDays">
                AR hold (days past due, blank = off)
              </FieldLabel>
              <Input
                id="arHoldDays"
                inputMode="numeric"
                placeholder="—"
                aria-invalid={!!errors.arHoldDays}
                {...register('arHoldDays')}
              />
              <FieldError errors={[errors.arHoldDays]} />
            </Field>
            <Field>
              <FieldLabel htmlFor="resaleCertNumber">Resale cert #</FieldLabel>
              <Input
                id="resaleCertNumber"
                {...register('resaleCertNumber')}
              />
              <FieldError errors={[errors.resaleCertNumber]} />
            </Field>
            <Field orientation="horizontal" className="md:items-start md:pt-7">
              <Controller
                control={control}
                name="taxExempt"
                render={({ field }) => (
                  <Checkbox
                    id="taxExempt"
                    checked={field.value}
                    onCheckedChange={(v) => field.onChange(v === true)}
                  />
                )}
              />
              <FieldLabel htmlFor="taxExempt">Tax exempt</FieldLabel>
            </Field>
          </div>
        </CardContent>
      </Card>

      {mode.kind === 'create' && (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Billing address</CardTitle>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="billing-label">Label (optional)</FieldLabel>
                <Input
                  id="billing-label"
                  placeholder="e.g. HQ"
                  {...register('billing.label')}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="billing-attention">
                  Attention (optional)
                </FieldLabel>
                <Input
                  id="billing-attention"
                  {...register('billing.attention')}
                />
              </Field>
            </div>
            <Field>
              <FieldLabel htmlFor="billing-line1">Line 1</FieldLabel>
              <Input
                id="billing-line1"
                aria-invalid={!!errors.billing?.line1}
                {...register('billing.line1')}
              />
              <FieldError errors={[errors.billing?.line1]} />
            </Field>
            <Field>
              <FieldLabel htmlFor="billing-line2">Line 2 (optional)</FieldLabel>
              <Input id="billing-line2" {...register('billing.line2')} />
            </Field>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <Field>
                <FieldLabel htmlFor="billing-city">City</FieldLabel>
                <Input
                  id="billing-city"
                  aria-invalid={!!errors.billing?.city}
                  {...register('billing.city')}
                />
                <FieldError errors={[errors.billing?.city]} />
              </Field>
              <Field>
                <FieldLabel htmlFor="billing-region">State / region</FieldLabel>
                <Input
                  id="billing-region"
                  aria-invalid={!!errors.billing?.region}
                  {...register('billing.region')}
                />
                <FieldError errors={[errors.billing?.region]} />
              </Field>
              <Field>
                <FieldLabel htmlFor="billing-postalCode">Postal code</FieldLabel>
                <Input
                  id="billing-postalCode"
                  aria-invalid={!!errors.billing?.postalCode}
                  {...register('billing.postalCode')}
                />
                <FieldError errors={[errors.billing?.postalCode]} />
              </Field>
            </div>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="billing-country">
                  Country (ISO-3166 alpha-2, blank = US)
                </FieldLabel>
                <Input
                  id="billing-country"
                  placeholder="US"
                  maxLength={2}
                  aria-invalid={!!errors.billing?.country}
                  {...register('billing.country')}
                />
                <FieldError errors={[errors.billing?.country]} />
              </Field>
              <Field>
                <FieldLabel htmlFor="billing-phone">Phone (optional)</FieldLabel>
                <Input id="billing-phone" {...register('billing.phone')} />
              </Field>
            </div>
          </FieldGroup>
        </CardContent>
      </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Notes</CardTitle>
        </CardHeader>
        <CardContent>
          <Field>
            <FieldLabel htmlFor="internalNotes">Internal notes</FieldLabel>
            <Textarea
              id="internalNotes"
              rows={4}
              placeholder="Sticky notes that print on every internal document for this customer."
              {...register('internalNotes')}
            />
            <FieldError errors={[errors.internalNotes]} />
          </Field>
        </CardContent>
      </Card>

      <div className="flex items-center justify-end gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={pending}
          render={
            <Link
              href={
                mode.kind === 'create'
                  ? '/customers'
                  : `/customers/${mode.customerId}`
              }
            />
          }
        >
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? 'Saving…' : submitLabel}
        </Button>
      </div>
    </form>
  );
}

export type CustomerCreateApiPayload = {
  name: string;
  type: CustomerFormValues['type'];
  salesRepId: string;
  paymentTermId: string;
  primaryPhone?: string;
  primaryEmail?: string;
  creditLimit?: string;
  arHoldDays?: number;
  taxExempt: boolean;
  resaleCertNumber?: string;
  internalNotes?: string;
  billingAddress: {
    kind: 'BILLING';
    label?: string;
    attention?: string;
    line1: string;
    line2?: string;
    city: string;
    region: string;
    postalCode: string;
    country?: string;
    phone?: string;
  };
};
