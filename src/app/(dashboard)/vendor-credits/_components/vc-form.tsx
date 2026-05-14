'use client';

import { useTransition } from 'react';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { formatCurrency } from '@/lib/format';

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
// Form schema — mirrors create/update VendorCreditInputSchema.
// Lines are simple expense-style (description + amount) per pilot scope.
// Math invariant SUM(line.amount) === amount is enforced at the service
// layer, but we mirror it client-side as a soft warning so AP staff
// catches typos before submit.
// ===========================================================================

const positiveAmount = z
  .string()
  .min(1, 'Required')
  .regex(/^\d+(\.\d+)?$/, 'Must be a positive number')
  .refine((v) => Number(v) > 0, 'Must be greater than 0');

const lineSchema = z.object({
  description: z.string().min(1, 'Required').max(500),
  amount: positiveAmount,
  notes: z.string().max(2000).optional(),
});

const formSchema = z.object({
  vendorId: z.string().min(1, 'Required'),
  amount: positiveAmount,
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
  amount: '',
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
  defaultValues,
}: {
  mode: VcFormMode;
  vendors: VendorOption[];
  defaultValues?: Partial<VcFormValues>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

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
  const headerAmount = watch('amount');

  // Soft client-side mismatch warning. The service enforces SUM(line.amount)
  // === amount strictly. Surface the mismatch up front so AP catches typos
  // before submit; the form still lets them submit (server is source of
  // truth).
  const linesSum = lines.reduce((acc, l) => {
    const n = Number(l.amount);
    if (!Number.isFinite(n)) return acc;
    return acc + n;
  }, 0);
  const headerN = Number(headerAmount);
  const mismatchAmount =
    Number.isFinite(headerN) && Math.abs(linesSum - headerN) > 0.001
      ? linesSum - headerN
      : null;

  function submit(values: VcFormValues) {
    startTransition(async () => {
      const payload = {
        vendorId: values.vendorId,
        amount: values.amount,
        creditDate: nullEmpty(values.creditDate),
        currency: nullEmpty(values.currency)?.toUpperCase(),
        reason: nullEmpty(values.reason),
        notes: nullEmpty(values.notes),
        lines: values.lines.map((l) => ({
          description: l.description.trim(),
          amount: l.amount,
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
  const selectedVendor = vendors.find((v) => v.id === vendorId) ?? null;

  return (
    <form onSubmit={handleSubmit(submit)} className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Vendor &amp; total</CardTitle>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="vendorId">Vendor</FieldLabel>
                <Controller
                  control={control}
                  name="vendorId"
                  render={({ field }) => (
                    <Select
                      value={field.value || undefined}
                      onValueChange={field.onChange}
                      disabled={mode.kind === 'edit'}
                    >
                      <SelectTrigger
                        id="vendorId"
                        className="w-full"
                        aria-invalid={!!errors.vendorId}
                      >
                        <SelectValue placeholder="Select a vendor" />
                      </SelectTrigger>
                      <SelectContent>
                        {vendors.length === 0 ? (
                          <div className="px-2 py-1.5 text-xs text-muted-foreground">
                            No active vendors — create one first.
                          </div>
                        ) : (
                          vendors.map((v) => (
                            <SelectItem key={v.id} value={v.id}>
                              <span className="font-mono text-xs text-muted-foreground">
                                {v.code}
                              </span>{' '}
                              {v.name}
                            </SelectItem>
                          ))
                        )}
                      </SelectContent>
                    </Select>
                  )}
                />
                <FieldError errors={[errors.vendorId]} />
              </Field>

              <Field>
                <FieldLabel htmlFor="amount">Credit amount</FieldLabel>
                <Input
                  id="amount"
                  inputMode="decimal"
                  placeholder="0.00"
                  aria-invalid={!!errors.amount}
                  {...register('amount')}
                />
                <FieldError errors={[errors.amount]} />
              </Field>
            </div>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
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
                <div className="text-xs text-muted-foreground">Lines sum</div>
                <div className="text-lg font-semibold tabular-nums">
                  {formatCurrency(linesSum.toFixed(2))}
                </div>
                {mismatchAmount != null ? (
                  <p className="text-xs text-amber-600">
                    Differs from header by{' '}
                    {formatCurrency(Math.abs(mismatchAmount).toFixed(2))}.
                    Server will reject mismatched totals.
                  </p>
                ) : null}
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
