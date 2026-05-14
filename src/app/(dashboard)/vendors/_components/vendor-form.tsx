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
import { Textarea } from '@/components/ui/textarea';

// ===========================================================================
// Form schema
// ---------------------------------------------------------------------------
// Mirrors createVendorInputSchema's shape but uses '' as the carrier for
// "no value" so RHF + native inputs play nicely. On submit we map to
// the API payload (createVendorInputSchema-shaped) and POST it.
// ===========================================================================

const VENDOR_TYPES = [
  { value: 'STOCK', label: 'Stock' },
  { value: 'DROP_SHIP', label: 'Drop-ship' },
  { value: 'SERVICE', label: 'Service' },
] as const;

const vendorTypeEnum = z.enum(['STOCK', 'DROP_SHIP', 'SERVICE']);

const optionalDecimal = z
  .union([
    z.literal(''),
    z.string().regex(/^\d+(\.\d+)?$/, 'Must be a non-negative decimal'),
  ])
  .optional();

const optionalPercent = z
  .union([
    z.literal(''),
    z.string().regex(/^\d+(\.\d+)?$/, 'Must be a number'),
  ])
  .optional()
  .refine(
    (v) => v == null || v === '' || (Number(v) >= 0 && Number(v) <= 100),
    'Must be between 0 and 100',
  );

// Remit-to is captured inline on create (one address per kind, can add
// more from the Addresses tab later). Edit mode hides the card — the
// PATCH endpoint doesn't accept remitToAddress and addresses are
// managed via the addresses sub-resource once the vendor exists.
const remitCommonShape = {
  label: z.string().max(255).optional(),
  attention: z.string().max(255).optional(),
  line2: z.string().max(500).optional(),
  country: z
    .union([z.literal(''), z.string().length(2, 'ISO-3166 alpha-2')])
    .optional(),
  phone: z.string().max(64).optional(),
};

const createRemitSchema = z.object({
  ...remitCommonShape,
  line1: z.string().min(1, 'Required').max(500),
  city: z.string().min(1, 'Required').max(255),
  region: z.string().min(1, 'Required').max(255),
  postalCode: z.string().min(1, 'Required').max(32),
});

const editRemitSchema = z.object({
  ...remitCommonShape,
  line1: z.string().max(500),
  city: z.string().max(255),
  region: z.string().max(255),
  postalCode: z.string().max(32),
});

const baseShape = {
  name: z.string().min(1, 'Required').max(255),
  type: vendorTypeEnum,
  paymentTermId: z.string().min(1, 'Required'),
  defaultCurrency: z
    .union([z.literal(''), z.string().length(3, '3-letter ISO code')])
    .optional(),
  minimumOrderAmount: optionalDecimal,
  costChangeAlertPct: optionalPercent,
  notes: z.string().max(10000).optional(),
  active: z.boolean(),
};

const createFormSchema = z.object({
  ...baseShape,
  remit: createRemitSchema,
});

const editFormSchema = z.object({
  ...baseShape,
  remit: editRemitSchema,
});

export type VendorFormValues = z.infer<typeof createFormSchema>;

export type LookupOption = { id: string; label: string };

const DEFAULT_VALUES: VendorFormValues = {
  name: '',
  type: 'STOCK',
  paymentTermId: '',
  defaultCurrency: '',
  minimumOrderAmount: '',
  costChangeAlertPct: '',
  notes: '',
  active: true,
  remit: {
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

export type VendorFormMode =
  | { kind: 'create' }
  | { kind: 'edit'; vendorId: string };

export function VendorForm({
  paymentTerms,
  defaultValues,
  mode,
}: {
  paymentTerms: LookupOption[];
  defaultValues?: Partial<VendorFormValues>;
  mode: VendorFormMode;
}) {
  const submitLabel =
    mode.kind === 'create' ? 'Create vendor' : 'Save changes';
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const form = useForm<VendorFormValues>({
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

  function submit(values: VendorFormValues) {
    startTransition(async () => {
      const payload: VendorCreateApiPayload = {
        name: values.name.trim(),
        type: values.type,
        paymentTermId: values.paymentTermId,
        defaultCurrency: nullEmpty(values.defaultCurrency)?.toUpperCase(),
        minimumOrderAmount: nullEmpty(values.minimumOrderAmount),
        costChangeAlertPct: nullEmpty(values.costChangeAlertPct),
        notes: nullEmpty(values.notes),
        active: values.active,
        remitToAddress: {
          kind: 'REMIT_TO',
          label: nullEmpty(values.remit.label),
          attention: nullEmpty(values.remit.attention),
          line1: values.remit.line1.trim(),
          line2: nullEmpty(values.remit.line2),
          city: values.remit.city.trim(),
          region: values.remit.region.trim(),
          postalCode: values.remit.postalCode.trim(),
          country: nullEmpty(values.remit.country)?.toUpperCase(),
          phone: nullEmpty(values.remit.phone),
          // First remit-to becomes the default automatically. Pilot
          // doesn't expose a checkbox here.
          isDefault: true,
        },
      };
      try {
        const endpoint =
          mode.kind === 'create'
            ? '/api/vendors'
            : `/api/vendors/${mode.vendorId}`;
        const method = mode.kind === 'create' ? 'POST' : 'PATCH';
        // PATCH endpoint doesn't accept remitToAddress — addresses are
        // managed via the addresses sub-resource once the vendor exists.
        // Strip remitToAddress from the edit payload to avoid the API
        // schema rejecting unknown fields.
        const body =
          mode.kind === 'create'
            ? payload
            : (() => {
                const { remitToAddress: _r, ...rest } = payload;
                void _r;
                return rest;
              })();
        // Also drop empty-string optionals on edit so PATCH validators
        // don't reject blank fields. (Create's optional-with-default
        // schema already tolerates them via nullEmpty above.)
        if (mode.kind === 'edit') {
          for (const key of Object.keys(body) as Array<keyof typeof body>) {
            if (body[key] === undefined) delete body[key];
          }
        }
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
        router.push(`/vendors/${saved.id}`);
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
                        {VENDOR_TYPES.map((t) => (
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
            <Field orientation="horizontal" className="md:items-start md:pt-1">
              <Controller
                control={control}
                name="active"
                render={({ field }) => (
                  <Checkbox
                    id="active"
                    checked={field.value}
                    onCheckedChange={(v) => field.onChange(v === true)}
                  />
                )}
              />
              <FieldLabel htmlFor="active">Active</FieldLabel>
            </Field>
          </FieldGroup>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Purchasing</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <Field>
              <FieldLabel htmlFor="defaultCurrency">
                Default currency (blank = USD)
              </FieldLabel>
              <Input
                id="defaultCurrency"
                placeholder="USD"
                maxLength={3}
                aria-invalid={!!errors.defaultCurrency}
                {...register('defaultCurrency')}
              />
              <FieldError errors={[errors.defaultCurrency]} />
            </Field>
            <Field>
              <FieldLabel htmlFor="minimumOrderAmount">
                Minimum order (warning)
              </FieldLabel>
              <Input
                id="minimumOrderAmount"
                inputMode="decimal"
                placeholder="0.00"
                aria-invalid={!!errors.minimumOrderAmount}
                {...register('minimumOrderAmount')}
              />
              <FieldError errors={[errors.minimumOrderAmount]} />
            </Field>
            <Field>
              <FieldLabel htmlFor="costChangeAlertPct">
                Cost change alert (%)
              </FieldLabel>
              <Input
                id="costChangeAlertPct"
                inputMode="decimal"
                placeholder="10"
                aria-invalid={!!errors.costChangeAlertPct}
                {...register('costChangeAlertPct')}
              />
              <FieldError errors={[errors.costChangeAlertPct]} />
            </Field>
          </div>
        </CardContent>
      </Card>

      {mode.kind === 'create' && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Remit-to address</CardTitle>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="remit-label">Label (optional)</FieldLabel>
                  <Input
                    id="remit-label"
                    placeholder="e.g. Main office"
                    {...register('remit.label')}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="remit-attention">
                    Attention (optional)
                  </FieldLabel>
                  <Input id="remit-attention" {...register('remit.attention')} />
                </Field>
              </div>
              <Field>
                <FieldLabel htmlFor="remit-line1">Line 1</FieldLabel>
                <Input
                  id="remit-line1"
                  aria-invalid={!!errors.remit?.line1}
                  {...register('remit.line1')}
                />
                <FieldError errors={[errors.remit?.line1]} />
              </Field>
              <Field>
                <FieldLabel htmlFor="remit-line2">Line 2 (optional)</FieldLabel>
                <Input id="remit-line2" {...register('remit.line2')} />
              </Field>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                <Field>
                  <FieldLabel htmlFor="remit-city">City</FieldLabel>
                  <Input
                    id="remit-city"
                    aria-invalid={!!errors.remit?.city}
                    {...register('remit.city')}
                  />
                  <FieldError errors={[errors.remit?.city]} />
                </Field>
                <Field>
                  <FieldLabel htmlFor="remit-region">State / region</FieldLabel>
                  <Input
                    id="remit-region"
                    aria-invalid={!!errors.remit?.region}
                    {...register('remit.region')}
                  />
                  <FieldError errors={[errors.remit?.region]} />
                </Field>
                <Field>
                  <FieldLabel htmlFor="remit-postalCode">Postal code</FieldLabel>
                  <Input
                    id="remit-postalCode"
                    aria-invalid={!!errors.remit?.postalCode}
                    {...register('remit.postalCode')}
                  />
                  <FieldError errors={[errors.remit?.postalCode]} />
                </Field>
              </div>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="remit-country">
                    Country (ISO-3166 alpha-2, blank = US)
                  </FieldLabel>
                  <Input
                    id="remit-country"
                    placeholder="US"
                    maxLength={2}
                    aria-invalid={!!errors.remit?.country}
                    {...register('remit.country')}
                  />
                  <FieldError errors={[errors.remit?.country]} />
                </Field>
                <Field>
                  <FieldLabel htmlFor="remit-phone">Phone (optional)</FieldLabel>
                  <Input id="remit-phone" {...register('remit.phone')} />
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
            <FieldLabel htmlFor="notes">Internal notes</FieldLabel>
            <Textarea
              id="notes"
              rows={4}
              placeholder="Sticky notes shown alongside this vendor on POs and bills."
              {...register('notes')}
            />
            <FieldError errors={[errors.notes]} />
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
                  ? '/vendors'
                  : `/vendors/${mode.vendorId}`
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

export type VendorCreateApiPayload = {
  name: string;
  type: VendorFormValues['type'];
  paymentTermId: string;
  defaultCurrency?: string;
  minimumOrderAmount?: string;
  costChangeAlertPct?: string;
  notes?: string;
  active: boolean;
  remitToAddress?: {
    kind: 'REMIT_TO';
    label?: string;
    attention?: string;
    line1: string;
    line2?: string;
    city: string;
    region: string;
    postalCode: string;
    country?: string;
    phone?: string;
    isDefault?: boolean;
  };
};
