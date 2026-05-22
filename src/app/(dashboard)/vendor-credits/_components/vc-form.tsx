'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  Controller,
  useFieldArray,
  useForm,
  type UseFormReturn,
} from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { Plus, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  VendorPicker,
  type PaymentTermOption,
} from '@/components/shared/vendor-picker';
import { formatCurrency } from '@/lib/format';
import {
  isPositiveDecimalInput,
  normalizeDecimalForSubmit,
} from '@/lib/decimal-input';

// ===========================================================================
// Lookup option shape
// ===========================================================================

export type VendorOption = {
  id: string;
  code: string;
  name: string;
  defaultCurrency: string | null;
};

// ===========================================================================
// Form schema — mirrors create/update VendorCreditInputSchema, minus the
// header `amount` field. The credit total is derived from SUM(line.amount)
// at submit time and recomputed in real time for display. The service
// layer accepts an omitted amount and derives the same sum server-side,
// so there's a single source of truth.
// ===========================================================================

// Looser refine so operators can type ".25" without a leading zero;
// the submit handler normalizes before posting.
const positiveAmount = z
  .string()
  .min(1, 'Required')
  .refine(isPositiveDecimalInput, 'Must be a positive number');

const lineSchema = z.object({
  description: z.string().min(1, 'Required').max(500),
  amount: positiveAmount,
  notes: z.string().max(2000).optional(),
});

const formSchema = z.object({
  vendorId: z.string().min(1, 'Required'),
  creditDate: z
    .union([
      z.literal(''),
      z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
    ])
    .optional(),
  currency: z
    .union([z.literal(''), z.string().length(3, '3-letter ISO code')])
    .optional(),
  reason: z.string().max(2000).optional(),
  notes: z.string().max(2000).optional(),
  lines: z.array(lineSchema).min(1, 'At least one line is required'),
});

export type VcFormValues = z.infer<typeof formSchema>;

export type VcFormMode =
  | { kind: 'create' }
  | { kind: 'edit'; vendorCreditId: string };

const DEFAULT_VALUES: VcFormValues = {
  vendorId: '',
  creditDate: '',
  currency: '',
  reason: '',
  notes: '',
  lines: [emptyLine()],
};

function emptyLine(): VcFormValues['lines'][number] {
  return {
    description: '',
    amount: '',
    notes: '',
  };
}

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

// ===========================================================================
// Form
// ===========================================================================

export function VcForm({
  mode,
  vendors,
  paymentTerms,
  defaultValues,
}: {
  mode: VcFormMode;
  vendors: VendorOption[];
  // Payment terms for the inline "create vendor" dialog (required field).
  paymentTerms: PaymentTermOption[];
  defaultValues?: Partial<VcFormValues>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // Shadow the vendors prop so the inline "create vendor" flow can
  // append + auto-select without a navigation. The prop is the seed only.
  const [vendorsState, setVendorsState] = useState<VendorOption[]>(vendors);

  const form = useForm<VcFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { ...DEFAULT_VALUES, ...defaultValues },
  });

  const {
    register,
    handleSubmit,
    control,
    watch,
    formState: { errors },
  } = form;

  const { fields, append, remove } = useFieldArray({
    control,
    name: 'lines',
  });

  const vendorId = watch('vendorId');
  const lines = watch('lines');

  // Authoritative credit total = sum of all valid line amounts. The
  // service derives the same number server-side when the request omits
  // `amount`; both views agree by construction.
  const linesSum = lines.reduce((acc, l) => {
    const n = Number(l.amount);
    if (!Number.isFinite(n)) return acc;
    return acc + n;
  }, 0);

  function submit(values: VcFormValues) {
    startTransition(async () => {
      const payload = {
        vendorId: values.vendorId,
        creditDate: nullEmpty(values.creditDate),
        currency: nullEmpty(values.currency)?.toUpperCase(),
        reason: nullEmpty(values.reason),
        notes: nullEmpty(values.notes),
        lines: values.lines.map((l) => ({
          description: l.description.trim(),
          amount: normalizeDecimalForSubmit(l.amount),
          notes: nullEmpty(l.notes),
        })),
      };
      try {
        const endpoint =
          mode.kind === 'create'
            ? '/api/vendor-credits'
            : `/api/vendor-credits/${mode.vendorCreditId}`;
        const method = mode.kind === 'create' ? 'POST' : 'PATCH';
        // PATCH (updateVendorCreditInputSchema) doesn't accept vendorId
        // — vendor is immutable on edit. Strip at the edge.
        const body =
          mode.kind === 'create'
            ? payload
            : (() => {
                const { vendorId: _v, ...rest } = payload;
                void _v;
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
        const saved = (await res.json()) as { id: string; number: string };
        toast.success(
          mode.kind === 'create'
            ? `Created ${saved.number}`
            : `Saved ${saved.number}`,
        );
        router.push(`/vendor-credits/${saved.id}`);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Network error');
      }
    });
  }

  const linesError = errors.lines?.message ?? errors.lines?.root?.message;
  const selectedVendor = vendorsState.find((v) => v.id === vendorId) ?? null;

  return (
    <form onSubmit={handleSubmit(submit)} className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Vendor</CardTitle>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <Field>
                <FieldLabel htmlFor="vendorId">Vendor</FieldLabel>
                <Controller
                  control={control}
                  name="vendorId"
                  render={({ field }) => (
                    <VendorPicker
                      id="vendorId"
                      value={field.value || null}
                      onValueChange={(v) => field.onChange(v ?? '')}
                      vendors={vendorsState}
                      paymentTerms={paymentTerms}
                      onCreated={(created) => {
                        setVendorsState((prev) =>
                          prev.some((v) => v.id === created.id)
                            ? prev
                            : [
                                ...prev,
                                {
                                  id: created.id,
                                  code: created.code,
                                  name: created.name,
                                  defaultCurrency: created.defaultCurrency,
                                },
                              ],
                        );
                      }}
                      disabled={mode.kind === 'edit'}
                      ariaInvalid={!!errors.vendorId}
                      placeholder="Search vendors…"
                    />
                  )}
                />
                <FieldError errors={[errors.vendorId]} />
              </Field>
              <Field>
                <FieldLabel htmlFor="creditDate">Credit date</FieldLabel>
                <Input
                  id="creditDate"
                  type="date"
                  {...register('creditDate')}
                />
                <FieldError errors={[errors.creditDate]} />
              </Field>
              <Field>
                <FieldLabel htmlFor="currency">
                  Currency (blank ={' '}
                  {selectedVendor?.defaultCurrency ?? 'USD'})
                </FieldLabel>
                <Input
                  id="currency"
                  placeholder={selectedVendor?.defaultCurrency ?? 'USD'}
                  maxLength={3}
                  {...register('currency')}
                />
                <FieldError errors={[errors.currency]} />
              </Field>
            </div>
          </FieldGroup>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Lines</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {fields.map((field, index) => (
              <LineRow
                key={field.id}
                form={form}
                index={index}
                canRemove={fields.length > 1}
                onRemove={() => remove(index)}
              />
            ))}
            <div className="flex items-center justify-between gap-3">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => append(emptyLine())}
              >
                <Plus />
                Add line
              </Button>
              {linesError ? (
                <span className="text-xs text-destructive">{linesError}</span>
              ) : null}
            </div>
            <div className="flex justify-end border-t border-border pt-3 text-sm">
              <div className="text-right">
                <div className="text-xs text-muted-foreground">
                  Credit total
                </div>
                <div className="text-lg font-semibold tabular-nums">
                  {formatCurrency(linesSum.toFixed(2))}
                </div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Context</CardTitle>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="reason">Reason</FieldLabel>
              <Input
                id="reason"
                placeholder="e.g. damaged in transit, pricing error"
                {...register('reason')}
              />
              <FieldError errors={[errors.reason]} />
            </Field>
            <Field>
              <FieldLabel htmlFor="notes">Internal notes</FieldLabel>
              <Textarea
                id="notes"
                rows={3}
                placeholder="Notes for AP — not printed."
                {...register('notes')}
              />
              <FieldError errors={[errors.notes]} />
            </Field>
          </FieldGroup>
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
                  ? '/vendor-credits'
                  : `/vendor-credits/${mode.vendorCreditId}`
              }
            />
          }
        >
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={pending}>
          {pending
            ? 'Saving…'
            : mode.kind === 'create'
              ? 'Create credit'
              : 'Save changes'}
        </Button>
      </div>
    </form>
  );
}

function LineRow({
  form,
  index,
  canRemove,
  onRemove,
}: {
  form: UseFormReturn<VcFormValues>;
  index: number;
  canRemove: boolean;
  onRemove: () => void;
}) {
  const {
    register,
    formState: { errors },
  } = form;
  const lineErrors = errors.lines?.[index];

  return (
    <div className="rounded-md border border-border p-3">
      <div className="grid grid-cols-12 gap-3">
        <div className="col-span-12 md:col-span-7">
          <Field>
            <FieldLabel htmlFor={`lines.${index}.description`}>
              Description
            </FieldLabel>
            <Input
              id={`lines.${index}.description`}
              aria-invalid={!!lineErrors?.description}
              placeholder="e.g. Damaged units returned"
              {...register(`lines.${index}.description`)}
            />
            <FieldError errors={[lineErrors?.description]} />
          </Field>
        </div>

        <div className="col-span-8 md:col-span-4">
          <Field>
            <FieldLabel htmlFor={`lines.${index}.amount`}>Amount</FieldLabel>
            <Input
              id={`lines.${index}.amount`}
              inputMode="decimal"
              placeholder="0.00"
              aria-invalid={!!lineErrors?.amount}
              {...register(`lines.${index}.amount`)}
            />
            <FieldError errors={[lineErrors?.amount]} />
          </Field>
        </div>

        <div className="col-span-4 flex items-end justify-end md:col-span-1">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={!canRemove}
            aria-label="Remove line"
            onClick={onRemove}
          >
            <Trash2 />
          </Button>
        </div>
      </div>

      <div className="mt-2">
        <Field>
          <FieldLabel htmlFor={`lines.${index}.notes`}>Line notes</FieldLabel>
          <Input
            id={`lines.${index}.notes`}
            placeholder="Optional internal note."
            {...register(`lines.${index}.notes`)}
          />
        </Field>
      </div>
    </div>
  );
}
