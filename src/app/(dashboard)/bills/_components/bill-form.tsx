'use client';

import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
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
  Combobox,
  ComboboxContent,
  ComboboxInput,
  ComboboxInputGroup,
  ComboboxItem,
  ComboboxList,
  ComboboxSeparator,
  ComboboxTrigger,
} from '@/components/ui/combobox';
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
import { QuickCreateProductDialog } from './quick-create-product-dialog';
import { formatCurrency } from '@/lib/format';
import {
  isNonNegativeDecimalInput,
  isPositiveDecimalInput,
  normalizeDecimalForSubmit,
} from '@/lib/decimal-input';

// ===========================================================================
// Lookup option shapes
// ===========================================================================

export type VendorOption = {
  id: string;
  code: string;
  name: string;
  defaultCurrency: string | null;
};
export type VariantOption = {
  id: string;
  sku: string;
  variantName: string | null;
  productName: string;
};
export type ExpenseAccountOption = {
  id: string;
  code: string;
  name: string;
};

// ===========================================================================
// Form schema — mirrors createBillInputSchema, with '' for "no value".
// One bill = one source per the service contract. The line shape is
// discriminated by the parent source:
//   PRODUCT → variantId required, expenseAccountId forbidden
//   EXPENSE → expenseAccountId required, variantId forbidden
// ===========================================================================

// Looser refines so operators can type ".25" without a leading zero;
// the submit handler normalizes before posting.
const qtyStr = z
  .string()
  .min(1, 'Required')
  .refine(isPositiveDecimalInput, 'Must be a positive decimal');

const unitCostStr = z
  .string()
  .min(1, 'Required')
  .refine(isNonNegativeDecimalInput, 'Must be a non-negative decimal');

const lineSchema = z.object({
  // Either variantId OR expenseAccountId is required, depending on
  // bill source. We don't enforce that at the line level — the parent
  // refine below catches mismatches.
  variantId: z.string().optional(),
  expenseAccountId: z.string().optional(),
  // Optional on PRODUCT lines (variant name is the primary identifier);
  // required on EXPENSE lines (account code alone is too coarse). The
  // parent refine enforces the EXPENSE rule.
  description: z.string().max(500).optional(),
  qty: qtyStr,
  unitCost: unitCostStr,
  notes: z.string().max(2000).optional(),
});

const formSchema = z
  .object({
    vendorId: z.string().min(1, 'Required'),
    source: z.enum(['PRODUCT', 'EXPENSE']),
    vendorReference: z.string().max(255).optional(),
    billDate: z
      .union([
        z.literal(''),
        z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
      ])
      .optional(),
    currency: z
      .union([z.literal(''), z.string().length(3, '3-letter ISO code')])
      .optional(),
    notes: z.string().max(2000).optional(),
    lines: z.array(lineSchema).min(1, 'At least one line is required'),
  })
  .superRefine((data, ctx) => {
    for (let i = 0; i < data.lines.length; i++) {
      const line = data.lines[i];
      if (data.source === 'PRODUCT') {
        if (!line.variantId || line.variantId.trim() === '') {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['lines', i, 'variantId'],
            message: 'Pick a product',
          });
        }
      } else {
        if (!line.expenseAccountId || line.expenseAccountId.trim() === '') {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['lines', i, 'expenseAccountId'],
            message: 'Pick an expense account',
          });
        }
        if (!line.description || line.description.trim() === '') {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['lines', i, 'description'],
            message: 'Required',
          });
        }
      }
    }
  });

export type BillFormValues = z.infer<typeof formSchema>;

export type BillFormMode =
  | { kind: 'create' }
  | { kind: 'edit'; billId: string };

const DEFAULT_VALUES: BillFormValues = {
  vendorId: '',
  source: 'PRODUCT',
  vendorReference: '',
  billDate: '',
  currency: '',
  notes: '',
  lines: [emptyLine('PRODUCT')],
};

function emptyLine(source: 'PRODUCT' | 'EXPENSE'): BillFormValues['lines'][number] {
  return {
    variantId: source === 'PRODUCT' ? '' : undefined,
    expenseAccountId: source === 'EXPENSE' ? '' : undefined,
    description: '',
    qty: '1',
    unitCost: '',
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

export function BillForm({
  mode,
  vendors,
  variants,
  expenseAccounts,
  defaultValues,
}: {
  mode: BillFormMode;
  vendors: VendorOption[];
  variants: VariantOption[];
  expenseAccounts: ExpenseAccountOption[];
  defaultValues?: Partial<BillFormValues>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // `variants` is server-rendered into props; the quick-create flow needs
  // to append a newly-created variant without a navigation, so we
  // shadow the prop in local state. The prop becomes the seed only.
  const [variantsState, setVariantsState] =
    useState<VariantOption[]>(variants);
  const [quickCreate, setQuickCreate] = useState<{
    open: boolean;
    lineIndex: number;
    query: string;
  }>({ open: false, lineIndex: 0, query: '' });

  const form = useForm<BillFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { ...DEFAULT_VALUES, ...defaultValues },
  });

  const {
    register,
    handleSubmit,
    control,
    watch,
    setValue,
    getValues,
    formState: { errors },
  } = form;

  const { fields, append, remove } = useFieldArray({
    control,
    name: 'lines',
  });

  const vendorId = watch('vendorId');
  const source = watch('source');
  const selectedVendor = useMemo(
    () => vendors.find((v) => v.id === vendorId) ?? null,
    [vendors, vendorId],
  );

  function onSourceChange(next: 'PRODUCT' | 'EXPENSE') {
    if (next === source) return;
    // Reset lines on source toggle — line shape is different, and
    // partially-typed values would orphan into the new shape's discriminator.
    const current = getValues('lines');
    const clearedLines = current.map(() => emptyLine(next));
    setValue('source', next, { shouldDirty: true });
    setValue('lines', clearedLines, { shouldDirty: true });
  }

  function submit(values: BillFormValues) {
    startTransition(async () => {
      const payload = {
        vendorId: values.vendorId,
        source: values.source,
        vendorReference: nullEmpty(values.vendorReference),
        billDate: nullEmpty(values.billDate),
        currency: nullEmpty(values.currency)?.toUpperCase(),
        notes: nullEmpty(values.notes),
        lines: values.lines.map((l) => ({
          // Send exactly the discriminator that matches source — the
          // server schema rejects the wrong one.
          variantId:
            values.source === 'PRODUCT' ? l.variantId : undefined,
          expenseAccountId:
            values.source === 'EXPENSE' ? l.expenseAccountId : undefined,
          description: nullEmpty(l.description),
          qty: normalizeDecimalForSubmit(l.qty),
          unitCost: normalizeDecimalForSubmit(l.unitCost),
          notes: nullEmpty(l.notes),
        })),
      };
      try {
        const endpoint =
          mode.kind === 'create'
            ? '/api/bills'
            : `/api/bills/${mode.billId}`;
        const method = mode.kind === 'create' ? 'POST' : 'PATCH';
        // PATCH (updateBillInputSchema) doesn't accept vendorId or
        // source — both immutable on edit. Strip at the edge.
        const body =
          mode.kind === 'create'
            ? payload
            : (() => {
                const { vendorId: _v, source: _s, ...rest } = payload;
                void _v;
                void _s;
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
        router.push(`/bills/${saved.id}`);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Network error');
      }
    });
  }

  const linesError = errors.lines?.message ?? errors.lines?.root?.message;

  return (
    <form onSubmit={handleSubmit(submit)} className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Vendor &amp; source</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="vendorId">Vendor</FieldLabel>
              <Controller
                control={control}
                name="vendorId"
                render={({ field }) => (
                  <Select
                    // Keep the Select consistently controlled — `''`
                    // collapses to `undefined` only at the prop edge,
                    // never on subsequent renders. `|| undefined`
                    // looked equivalent but base-ui flags the
                    // string→undefined swap as a controlled/
                    // uncontrolled mode change on first interaction.
                    value={field.value === '' ? undefined : field.value}
                    onValueChange={field.onChange}
                    disabled={mode.kind === 'edit'}
                  >
                    <SelectTrigger
                      id="vendorId"
                      className="w-full"
                      aria-invalid={!!errors.vendorId}
                    >
                      <SelectValue placeholder="Select a vendor">
                        {(v) => {
                          if (!v) return null;
                          const vendor = vendors.find((x) => x.id === v);
                          if (!vendor) return v;
                          return (
                            <>
                              <span className="font-mono text-xs text-muted-foreground">
                                {vendor.code}
                              </span>{' '}
                              {vendor.name}
                            </>
                          );
                        }}
                      </SelectValue>
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
              <FieldLabel htmlFor="source">Source</FieldLabel>
              <Controller
                control={control}
                name="source"
                render={({ field }) => (
                  <Select
                    value={field.value}
                    onValueChange={(v) =>
                      onSourceChange(v as 'PRODUCT' | 'EXPENSE')
                    }
                    disabled={mode.kind === 'edit'}
                  >
                    <SelectTrigger id="source" className="w-full">
                      <SelectValue>
                        {(v) =>
                          v === 'PRODUCT'
                            ? 'Product — variant lines'
                            : v === 'EXPENSE'
                              ? 'Expense — GL account lines'
                              : v
                        }
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="PRODUCT">
                        Product — variant lines
                      </SelectItem>
                      <SelectItem value="EXPENSE">
                        Expense — GL account lines
                      </SelectItem>
                    </SelectContent>
                  </Select>
                )}
              />
              <p className="text-xs text-muted-foreground">
                {mode.kind === 'edit'
                  ? 'Source is fixed on edit.'
                  : 'Product bills post DR Accrued Receipts; Expense bills post DR <expense account>.'}
              </p>
            </Field>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Line items</CardTitle>
        </CardHeader>
        <CardContent>
          {!vendorId ? (
            <div className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
              Pick a vendor first.
            </div>
          ) : (
            <div className="space-y-3">
              {fields.map((field, index) => (
                <LineRow
                  key={field.id}
                  form={form}
                  index={index}
                  source={source}
                  variants={variantsState}
                  expenseAccounts={expenseAccounts}
                  canRemove={fields.length > 1}
                  onRemove={() => remove(index)}
                  onRequestQuickCreate={(query) =>
                    setQuickCreate({ open: true, lineIndex: index, query })
                  }
                />
              ))}
              <div className="flex items-center justify-between gap-3">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => append(emptyLine(source))}
                >
                  <Plus />
                  Add line
                </Button>
                {linesError ? (
                  <span className="text-xs text-destructive">{linesError}</span>
                ) : null}
              </div>
              <TotalsSummary form={form} />
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Bill details</CardTitle>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <Field>
                <FieldLabel htmlFor="vendorReference">
                  Vendor reference (their invoice #)
                </FieldLabel>
                <Input
                  id="vendorReference"
                  placeholder="e.g. INV-12345"
                  className="font-mono"
                  {...register('vendorReference')}
                />
                <FieldError errors={[errors.vendorReference]} />
              </Field>
              <Field>
                <FieldLabel htmlFor="billDate">Bill date</FieldLabel>
                <Input
                  id="billDate"
                  type="date"
                  {...register('billDate')}
                />
                <FieldError errors={[errors.billDate]} />
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
              href={mode.kind === 'create' ? '/bills' : `/bills/${mode.billId}`}
            />
          }
        >
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={pending}>
          {pending
            ? 'Saving…'
            : mode.kind === 'create'
              ? 'Create bill'
              : 'Save changes'}
        </Button>
      </div>

      <QuickCreateProductDialog
        open={quickCreate.open}
        onOpenChange={(open) => setQuickCreate((s) => ({ ...s, open }))}
        initialQuery={quickCreate.query}
        onCreated={(variant) => {
          // Append to the live options list, then select on the requesting
          // line. Use setValue (not useFieldArray.update) so we only touch
          // the variantId field — quantity / unit cost / notes stay as
          // the operator left them.
          setVariantsState((prev) => [...prev, variant]);
          setValue(`lines.${quickCreate.lineIndex}.variantId`, variant.id, {
            shouldDirty: true,
            shouldValidate: true,
          });
        }}
      />
    </form>
  );
}

function variantLabel(v: VariantOption): string {
  return `${v.sku} ${v.productName}${v.variantName ? ` — ${v.variantName}` : ''}`;
}

function filterVariants(
  variants: VariantOption[],
  query: string,
): VariantOption[] {
  const q = query.trim().toLowerCase();
  if (q === '') return variants;
  return variants.filter(
    (v) =>
      v.sku.toLowerCase().includes(q) ||
      v.productName.toLowerCase().includes(q) ||
      (v.variantName?.toLowerCase().includes(q) ?? false),
  );
}

function LineRow({
  form,
  index,
  source,
  variants,
  expenseAccounts,
  canRemove,
  onRemove,
  onRequestQuickCreate,
}: {
  form: UseFormReturn<BillFormValues>;
  index: number;
  source: 'PRODUCT' | 'EXPENSE';
  variants: VariantOption[];
  expenseAccounts: ExpenseAccountOption[];
  canRemove: boolean;
  onRemove: () => void;
  onRequestQuickCreate: (query: string) => void;
}) {
  const {
    register,
    control,
    formState: { errors },
  } = form;

  const lineErrors = errors.lines?.[index];

  // Initial input fill in edit mode: if a variant is already selected,
  // show its label. Otherwise blank. The Combobox is fully controlled
  // (value + inputValue) so we own both the picker state and the
  // display string the operator sees.
  const initialVariantId = form.getValues(`lines.${index}.variantId`) ?? '';
  const initialVariant = variants.find((v) => v.id === initialVariantId);
  const [variantQuery, setVariantQuery] = useState<string>(
    initialVariant ? variantLabel(initialVariant) : '',
  );
  const filteredVariants = useMemo(
    () => filterVariants(variants, variantQuery),
    [variants, variantQuery],
  );

  // When the variantId changes from outside the combobox (the quick-create
  // dialog appends a new variant and setValues this line's variantId),
  // sync the displayed input value to that variant's label. The user's
  // own typing changes variantQuery first → watchedVariantId doesn't
  // shift → this effect stays out of the way.
  const watchedVariantId = form.watch(`lines.${index}.variantId`);
  const prevVariantIdRef = useRef(watchedVariantId);
  useEffect(() => {
    if (prevVariantIdRef.current === watchedVariantId) return;
    prevVariantIdRef.current = watchedVariantId;
    if (!watchedVariantId) return;
    const v = variants.find((x) => x.id === watchedVariantId);
    if (v) setVariantQuery(variantLabel(v));
  }, [watchedVariantId, variants]);
  // "+ Create product" appears only when the typed query has no match —
  // matches the brief. When the variants list is fully empty (no
  // products in the system yet), also surface it as the only path.
  const showCreateCta =
    (filteredVariants.length === 0 && variantQuery.trim() !== '') ||
    variants.length === 0;

  return (
    <div className="rounded-md border border-border p-3">
      <div className="grid grid-cols-12 gap-3">
        <div className="col-span-12 md:col-span-4">
          <Field>
            <FieldLabel htmlFor={`lines.${index}.discriminator`}>
              {source === 'PRODUCT' ? 'Variant' : 'Expense account'}
            </FieldLabel>
            {source === 'PRODUCT' ? (
              <Controller
                control={control}
                name={`lines.${index}.variantId`}
                render={({ field }) => (
                  <Combobox<string>
                    value={field.value || null}
                    onValueChange={(v) => {
                      field.onChange(v ?? '');
                      // Keep the input in sync with the chosen item so
                      // re-opening the dropdown later doesn't show a
                      // stale typed query.
                      const picked = variants.find((x) => x.id === v);
                      setVariantQuery(picked ? variantLabel(picked) : '');
                    }}
                    inputValue={variantQuery}
                    onInputValueChange={(v) => setVariantQuery(v)}
                    itemToStringLabel={(id) => {
                      const v = variants.find((x) => x.id === id);
                      return v ? variantLabel(v) : '';
                    }}
                  >
                    <ComboboxInputGroup
                      aria-invalid={!!lineErrors?.variantId}
                    >
                      <ComboboxInput
                        id={`lines.${index}.discriminator`}
                        placeholder="Search SKU or name…"
                      />
                      <ComboboxTrigger />
                    </ComboboxInputGroup>
                    <ComboboxContent>
                      <ComboboxList>
                        {filteredVariants.map((v) => (
                          <ComboboxItem key={v.id} value={v.id}>
                            <span className="font-mono text-xs text-muted-foreground">
                              {v.sku}
                            </span>{' '}
                            {v.productName}
                            {v.variantName ? ` — ${v.variantName}` : ''}
                          </ComboboxItem>
                        ))}
                      </ComboboxList>
                      {showCreateCta ? (
                        <>
                          {filteredVariants.length > 0 ? (
                            <ComboboxSeparator />
                          ) : null}
                          <button
                            type="button"
                            className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm text-primary outline-none transition-colors hover:bg-accent focus-visible:bg-accent"
                            onClick={() =>
                              onRequestQuickCreate(variantQuery)
                            }
                          >
                            <Plus className="size-3.5" />
                            Create product
                            {variantQuery.trim() !== '' ? (
                              <span className="font-mono text-xs text-muted-foreground">
                                {' '}
                                “{variantQuery.trim()}”
                              </span>
                            ) : null}
                          </button>
                        </>
                      ) : null}
                    </ComboboxContent>
                  </Combobox>
                )}
              />
            ) : (
              <Controller
                control={control}
                name={`lines.${index}.expenseAccountId`}
                render={({ field }) => (
                  <Select
                    // Same controlled-mode guard as the vendor Select
                    // above — initial `''` from emptyLine() must
                    // collapse to undefined at the prop edge only.
                    value={field.value === '' ? undefined : field.value}
                    onValueChange={field.onChange}
                  >
                    <SelectTrigger
                      id={`lines.${index}.discriminator`}
                      className="w-full"
                      aria-invalid={!!lineErrors?.expenseAccountId}
                    >
                      <SelectValue placeholder="Pick an expense account…">
                        {(v) => {
                          if (!v) return null;
                          const a = expenseAccounts.find((x) => x.id === v);
                          if (!a) return v;
                          return (
                            <>
                              <span className="font-mono text-xs text-muted-foreground">
                                {a.code}
                              </span>{' '}
                              {a.name}
                            </>
                          );
                        }}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {expenseAccounts.length === 0 ? (
                        <div className="px-2 py-1.5 text-xs text-muted-foreground">
                          No active expense accounts.
                        </div>
                      ) : (
                        expenseAccounts.map((a) => (
                          <SelectItem key={a.id} value={a.id}>
                            <span className="font-mono text-xs text-muted-foreground">
                              {a.code}
                            </span>{' '}
                            {a.name}
                          </SelectItem>
                        ))
                      )}
                    </SelectContent>
                  </Select>
                )}
              />
            )}
            <FieldError
              errors={[
                source === 'PRODUCT'
                  ? lineErrors?.variantId
                  : lineErrors?.expenseAccountId,
              ]}
            />
          </Field>
        </div>

        <div className="col-span-12 md:col-span-2">
          <Field>
            <FieldLabel htmlFor={`lines.${index}.description`}>
              Description
            </FieldLabel>
            <Input
              id={`lines.${index}.description`}
              aria-invalid={!!lineErrors?.description}
              placeholder={
                source === 'PRODUCT'
                  ? 'e.g. Bulk caps'
                  : 'e.g. Freight'
              }
              {...register(`lines.${index}.description`)}
            />
            <FieldError errors={[lineErrors?.description]} />
          </Field>
        </div>

        <div className="col-span-4 md:col-span-1">
          <Field>
            <FieldLabel htmlFor={`lines.${index}.qty`}>Qty</FieldLabel>
            <Input
              id={`lines.${index}.qty`}
              inputMode="decimal"
              aria-invalid={!!lineErrors?.qty}
              {...register(`lines.${index}.qty`)}
            />
            <FieldError errors={[lineErrors?.qty]} />
          </Field>
        </div>

        <div className="col-span-8 md:col-span-2">
          <Field>
            <FieldLabel htmlFor={`lines.${index}.unitCost`}>
              Unit cost
            </FieldLabel>
            <Input
              id={`lines.${index}.unitCost`}
              inputMode="decimal"
              placeholder="0.00"
              aria-invalid={!!lineErrors?.unitCost}
              {...register(`lines.${index}.unitCost`)}
            />
            <FieldError errors={[lineErrors?.unitCost]} />
          </Field>
        </div>

        {/* Notes inline on the same row instead of a full-width sub-row.
            Optional → no error state to worry about. */}
        <div className="col-span-12 md:col-span-2">
          <Field>
            <FieldLabel htmlFor={`lines.${index}.notes`}>Notes</FieldLabel>
            <Input
              id={`lines.${index}.notes`}
              placeholder="Optional"
              {...register(`lines.${index}.notes`)}
            />
          </Field>
        </div>

        <div className="col-span-12 flex items-end justify-end md:col-span-1">
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
    </div>
  );
}

function TotalsSummary({ form }: { form: UseFormReturn<BillFormValues> }) {
  const lines = form.watch('lines');
  // Client-side total preview — server is source of truth. Skip non-
  // numeric values silently so partial input doesn't NaN out.
  const total = lines.reduce((acc, l) => {
    const qty = Number(l.qty);
    const cost = Number(l.unitCost);
    if (!Number.isFinite(qty) || !Number.isFinite(cost)) return acc;
    return acc + qty * cost;
  }, 0);
  return (
    <div className="flex justify-end border-t border-border pt-3 text-sm">
      <div className="text-right">
        <div className="text-xs text-muted-foreground">Bill total</div>
        <div className="text-lg font-semibold tabular-nums">
          {formatCurrency(total.toFixed(2))}
        </div>
      </div>
    </div>
  );
}
