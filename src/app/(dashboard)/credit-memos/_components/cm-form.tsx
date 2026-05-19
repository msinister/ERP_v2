'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
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
import { VariantPicker } from '@/components/shared/variant-picker';
import { formatCurrency } from '@/lib/format';
import {
  isNonNegativeDecimalInput,
  isPositiveDecimalInput,
  normalizeDecimalForSubmit,
} from '@/lib/decimal-input';

// ===========================================================================
// Lookup option shapes
// ===========================================================================

export type CustomerOption = { id: string; code: string; name: string };
export type CategoryOption = {
  id: string;
  code: string;
  label: string;
  affectsInventory: boolean;
};
export type VariantOption = {
  id: string;
  sku: string;
  variantName: string | null;
  productName: string;
  shortDescription: string | null;
};

// Invoice payload returned from /api/invoices?customerId=…
type InvoiceLineOption = {
  id: string;
  variantId: string;
  description: string;
  qty: string;
  unitPrice: string;
};
type InvoiceOption = {
  id: string;
  number: string;
  invoiceDate: string;
  status: string;
  total: string;
  lines: InvoiceLineOption[];
};

// ===========================================================================
// Form schema — line totals must SUM to header amount; the server
// re-validates with a tolerance. The form derives amount from the
// lines (not user-typed) so the two views agree by construction.
// ===========================================================================

const positiveQty = z
  .string()
  .min(1, 'Required')
  .refine(isPositiveDecimalInput, 'Must be > 0');
const nonNegPrice = z
  .string()
  .min(1, 'Required')
  .refine(isNonNegativeDecimalInput, 'Must be >= 0');
const optionalNonNegDecimal = z
  .union([
    z.literal(''),
    z.string().refine(isNonNegativeDecimalInput, 'Must be a non-negative number'),
  ])
  .optional();

const lineSchema = z.object({
  // Sentinel for the optional "pre-fill from invoice line" picker. Not
  // sent to the server — only used to drive the variantId/qty/unit-
  // Price/description prefill in the LineRow component.
  invoiceLineId: z.string().optional(),
  variantId: z.string().min(1, 'Required'),
  qty: positiveQty,
  unitPrice: nonNegPrice,
  // Notes — optional. Operators only fill in a credit reason when
  // they have something to say. RHF gives us a string from the text
  // input regardless, so we just cap the length.
  description: z.string().max(500),
});

const formSchema = z.object({
  customerId: z.string().min(1, 'Required'),
  invoiceId: z.string().optional(),
  categoryId: z.string().min(1, 'Required'),
  creditDate: z
    .union([
      z.literal(''),
      z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
    ])
    .optional(),
  restockingFee: optionalNonNegDecimal,
  currency: z
    .union([z.literal(''), z.string().length(3, '3-letter ISO code')])
    .optional(),
  reason: z.string().max(2000).optional(),
  lines: z.array(lineSchema).min(1, 'At least one line is required'),
});

export type CmFormValues = z.infer<typeof formSchema>;

export type CmFormMode =
  | { kind: 'create' }
  | { kind: 'edit'; creditMemoId: string };

const DEFAULT_VALUES: CmFormValues = {
  customerId: '',
  invoiceId: '',
  categoryId: '',
  creditDate: '',
  restockingFee: '',
  currency: '',
  reason: '',
  lines: [emptyLine()],
};

function emptyLine(): CmFormValues['lines'][number] {
  return {
    invoiceLineId: '',
    variantId: '',
    qty: '1',
    unitPrice: '',
    description: '',
  };
}

// Today's date as YYYY-MM-DD in the browser's local timezone — matches
// the format the <input type="date"> control reads/writes. Computed at
// component mount (not module load) so a long-lived tab still picks up
// the correct day on a fresh form open.
function todayIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function nullEmpty(v: string | undefined): string | undefined {
  if (v == null) return undefined;
  const trimmed = v.trim();
  return trimmed === '' ? undefined : trimmed;
}

function nullEmptyDecimal(v: string | undefined): string | undefined {
  const n = nullEmpty(v);
  if (n == null) return undefined;
  return normalizeDecimalForSubmit(n);
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

// Sentinel option value for "no invoice selected" / "no invoice line"
// — empty string can't be used by base-ui Select.
const NONE_INVOICE = '__none__';

// ===========================================================================
// Form
// ===========================================================================

export function CmForm({
  mode,
  customers,
  categories,
  variants,
  defaultValues,
}: {
  mode: CmFormMode;
  customers: CustomerOption[];
  categories: CategoryOption[];
  variants: VariantOption[];
  defaultValues?: Partial<CmFormValues>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const form = useForm<CmFormValues>({
    resolver: zodResolver(formSchema),
    // creditDate defaults to today; caller-provided defaultValues may
    // override (e.g., the edit page passes the existing value). The
    // field is informational only — not sent to the server.
    defaultValues: {
      ...DEFAULT_VALUES,
      creditDate: todayIso(),
      ...defaultValues,
    },
  });

  const {
    register,
    handleSubmit,
    control,
    watch,
    setValue,
    formState: { errors },
  } = form;

  const { fields, append, remove } = useFieldArray({
    control,
    name: 'lines',
  });

  const customerId = watch('customerId');
  const invoiceId = watch('invoiceId');
  const categoryId = watch('categoryId');
  const restockingFee = watch('restockingFee');
  const lines = watch('lines');

  // Fetch invoices for the selected customer. Fired after customer
  // picks and cleared when the customer changes. Pilot scale: load all
  // statuses so the operator can credit against voided invoices too
  // (refund-via-CM flow allows that per the service).
  const [invoices, setInvoices] = useState<InvoiceOption[]>([]);
  const [invoicesLoading, setInvoicesLoading] = useState(false);

  useEffect(() => {
    if (!customerId) {
      setInvoices([]);
      return;
    }
    let cancelled = false;
    setInvoicesLoading(true);
    fetch(`/api/invoices?customerId=${encodeURIComponent(customerId)}&take=500`)
      .then(async (res) => {
        if (!res.ok) {
          setInvoices([]);
          return;
        }
        const body = (await res.json()) as InvoiceOption[];
        if (!cancelled) setInvoices(body);
      })
      .catch(() => {
        if (!cancelled) setInvoices([]);
      })
      .finally(() => {
        if (!cancelled) setInvoicesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [customerId]);

  // When the customer changes (and we're not on initial load), clear
  // the invoice selection + any per-line invoiceLineId references —
  // otherwise we'd carry stale references across customers.
  const [didInit, setDidInit] = useState(false);
  useEffect(() => {
    if (!didInit) {
      setDidInit(true);
      return;
    }
    setValue('invoiceId', '');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].invoiceLineId) {
        setValue(`lines.${i}.invoiceLineId`, '');
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId]);

  const selectedInvoice =
    invoices.find((inv) => inv.id === invoiceId) ?? null;
  const selectedCategory =
    categories.find((c) => c.id === categoryId) ?? null;

  // Header amount = SUM(line.qty × line.unitPrice). Same number the
  // server derives. We submit it explicitly because the createCredit-
  // MemoInputSchema requires it; the service re-validates against
  // line sum with a tolerance.
  const amountTotal = lines.reduce((acc, l) => {
    const q = Number(l.qty);
    const u = Number(l.unitPrice);
    if (!Number.isFinite(q) || !Number.isFinite(u)) return acc;
    return acc + q * u;
  }, 0);

  const restockingFeeNum = (() => {
    if (!restockingFee || restockingFee.trim() === '') return 0;
    const n = Number(restockingFee);
    return Number.isFinite(n) ? n : 0;
  })();
  const netCredit = Math.max(0, amountTotal - restockingFeeNum);

  function submit(values: CmFormValues) {
    startTransition(async () => {
      // Amount = sum of line totals, normalized to a string. The
      // service validates against the same sum + a tolerance.
      const amountStr = amountTotal.toFixed(2);
      const payload = {
        customerId: values.customerId,
        invoiceId: nullEmpty(values.invoiceId),
        categoryId: values.categoryId,
        amount: amountStr,
        restockingFee: nullEmptyDecimal(values.restockingFee),
        currency: nullEmpty(values.currency)?.toUpperCase(),
        reason: nullEmpty(values.reason),
        lines: values.lines.map((l) => ({
          invoiceLineId: nullEmpty(l.invoiceLineId),
          variantId: l.variantId,
          qty: normalizeDecimalForSubmit(l.qty),
          unitPrice: normalizeDecimalForSubmit(l.unitPrice),
          description: l.description.trim(),
        })),
      };
      try {
        const endpoint =
          mode.kind === 'create'
            ? '/api/credit-memos'
            : `/api/credit-memos/${mode.creditMemoId}`;
        const method = mode.kind === 'create' ? 'POST' : 'PATCH';
        // PATCH (updateCreditMemoInputSchema) doesn't accept customerId
        // — customer is immutable on edit. Strip at the edge.
        const body =
          mode.kind === 'create'
            ? payload
            : (() => {
                const { customerId: _c, ...rest } = payload;
                void _c;
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
        router.push(`/credit-memos/${saved.id}`);
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
          <CardTitle className="text-sm">Customer &amp; category</CardTitle>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <Field>
                <FieldLabel htmlFor="customerId">Customer</FieldLabel>
                <Controller
                  control={control}
                  name="customerId"
                  render={({ field }) => (
                    <Select
                      value={field.value}
                      onValueChange={field.onChange}
                      disabled={mode.kind === 'edit'}
                    >
                      <SelectTrigger
                        id="customerId"
                        className="w-full"
                        aria-invalid={!!errors.customerId}
                      >
                        <SelectValue placeholder="Select a customer">
                          {(v) => {
                            if (!v) return null;
                            const c = customers.find((x) => x.id === v);
                            if (!c) return v;
                            return (
                              <>
                                <span className="font-mono text-xs text-muted-foreground">
                                  {c.code}
                                </span>{' '}
                                {c.name}
                              </>
                            );
                          }}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {customers.length === 0 ? (
                          <div className="px-2 py-1.5 text-xs text-muted-foreground">
                            No active customers — create one first.
                          </div>
                        ) : (
                          customers.map((c) => (
                            <SelectItem key={c.id} value={c.id}>
                              <span className="font-mono text-xs text-muted-foreground">
                                {c.code}
                              </span>{' '}
                              {c.name}
                            </SelectItem>
                          ))
                        )}
                      </SelectContent>
                    </Select>
                  )}
                />
                <FieldError errors={[errors.customerId]} />
              </Field>

              <Field>
                <FieldLabel htmlFor="categoryId">Category</FieldLabel>
                <Controller
                  control={control}
                  name="categoryId"
                  render={({ field }) => (
                    <Select
                      value={field.value}
                      onValueChange={field.onChange}
                    >
                      <SelectTrigger
                        id="categoryId"
                        className="w-full"
                        aria-invalid={!!errors.categoryId}
                      >
                        <SelectValue placeholder="Pick a category">
                          {(v) => {
                            if (!v) return null;
                            const c = categories.find((x) => x.id === v);
                            return c?.label ?? v;
                          }}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {categories.length === 0 ? (
                          <div className="px-2 py-1.5 text-xs text-muted-foreground">
                            No active categories — set up in Admin →
                            Credit Memo Categories.
                          </div>
                        ) : (
                          categories.map((c) => (
                            <SelectItem key={c.id} value={c.id}>
                              {c.label}
                              <span className="ml-2 font-mono text-[10px] text-muted-foreground">
                                {c.code}
                              </span>
                            </SelectItem>
                          ))
                        )}
                      </SelectContent>
                    </Select>
                  )}
                />
                <FieldError errors={[errors.categoryId]} />
                {/* Inform-only: per current spec, standalone CMs do not
                    restore inventory even when the category is flagged
                    affectsInventory. Inventory restoration only fires
                    through the RMA → creditFromRma flow. */}
                {selectedCategory ? (
                  <p className="text-[10px] text-muted-foreground">
                    {selectedCategory.affectsInventory
                      ? "Category flagged affectsInventory — but inventory is restored only via RMA flow. This standalone credit memo posts AR only."
                      : 'Pure AR — no inventory effect.'}
                  </p>
                ) : null}
              </Field>

              <Field>
                <FieldLabel htmlFor="creditDate">Credit date</FieldLabel>
                <Input
                  id="creditDate"
                  type="date"
                  {...register('creditDate')}
                />
                <FieldError errors={[errors.creditDate]} />
                <p className="text-[10px] text-muted-foreground">
                  Informational. Server stamps issuedAt at confirm.
                </p>
              </Field>
            </div>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="invoiceId">
                  Linked invoice (optional)
                </FieldLabel>
                <Controller
                  control={control}
                  name="invoiceId"
                  render={({ field }) => (
                    <Select
                      value={field.value ? field.value : NONE_INVOICE}
                      onValueChange={(v) =>
                        field.onChange(v === NONE_INVOICE ? '' : v)
                      }
                      disabled={!customerId || invoicesLoading}
                    >
                      <SelectTrigger id="invoiceId" className="w-full">
                        <SelectValue
                          placeholder={
                            !customerId
                              ? 'Pick a customer first'
                              : invoicesLoading
                                ? 'Loading…'
                                : 'No linked invoice'
                          }
                        >
                          {(v) => {
                            if (!v || v === NONE_INVOICE) {
                              return 'No linked invoice';
                            }
                            const inv = invoices.find((x) => x.id === v);
                            return inv?.number ?? v;
                          }}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NONE_INVOICE}>
                          No linked invoice
                        </SelectItem>
                        {invoices.map((inv) => (
                          <SelectItem key={inv.id} value={inv.id}>
                            <span className="font-mono text-xs">
                              {inv.number}
                            </span>
                            <span className="ml-2 text-muted-foreground">
                              {formatDateString(inv.invoiceDate)} ·{' '}
                              {inv.status}
                            </span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
                <p className="text-[10px] text-muted-foreground">
                  When set, the net credit auto-applies to this invoice at
                  confirm.
                </p>
              </Field>

              <Field>
                <FieldLabel htmlFor="currency">
                  Currency (blank = USD)
                </FieldLabel>
                <Input
                  id="currency"
                  placeholder="USD"
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
          <CardTitle className="text-sm">Line items</CardTitle>
        </CardHeader>
        <CardContent>
          {!customerId ? (
            <div className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
              Pick a customer first.
            </div>
          ) : (
            <div className="space-y-3">
              {fields.map((field, index) => (
                <LineRow
                  key={field.id}
                  form={form}
                  index={index}
                  variants={variants}
                  invoice={selectedInvoice}
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
                  <span className="text-xs text-destructive">
                    {linesError}
                  </span>
                ) : null}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Totals &amp; context</CardTitle>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <Field>
                <FieldLabel>Gross amount</FieldLabel>
                <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm tabular-nums">
                  {formatCurrency(amountTotal.toFixed(2))}
                </div>
                <p className="text-[10px] text-muted-foreground">
                  Sum of line totals. Posts to Sales Returns (4500).
                </p>
              </Field>
              <Field>
                <FieldLabel htmlFor="restockingFee">
                  Restocking fee
                </FieldLabel>
                <Input
                  id="restockingFee"
                  inputMode="decimal"
                  placeholder="0.00"
                  {...register('restockingFee')}
                />
                <FieldError errors={[errors.restockingFee]} />
                <p className="text-[10px] text-muted-foreground">
                  Charged back via Restocking Fee Income (4600). Optional.
                </p>
              </Field>
              <Field>
                <FieldLabel>Net credit</FieldLabel>
                <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm font-medium tabular-nums">
                  {formatCurrency(netCredit.toFixed(2))}
                </div>
                <p className="text-[10px] text-muted-foreground">
                  Available for application to invoices.
                </p>
              </Field>
            </div>
            <Field>
              <FieldLabel htmlFor="reason">Reason / notes</FieldLabel>
              <Textarea
                id="reason"
                rows={3}
                placeholder="e.g. damaged in shipping, pricing dispute on PO #4123"
                {...register('reason')}
              />
              <FieldError errors={[errors.reason]} />
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
                  ? '/credit-memos'
                  : `/credit-memos/${mode.creditMemoId}`
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
              ? 'Create draft'
              : 'Save changes'}
        </Button>
      </div>
    </form>
  );
}

// ===========================================================================
// Per-line subcomponent. When the parent has an invoice linked, exposes
// a "From invoice line" picker that prefills variantId, qty, unitPrice,
// description, and stamps invoiceLineId.
// ===========================================================================

function LineRow({
  form,
  index,
  variants,
  invoice,
  canRemove,
  onRemove,
}: {
  form: UseFormReturn<CmFormValues>;
  index: number;
  variants: VariantOption[];
  invoice: InvoiceOption | null;
  canRemove: boolean;
  onRemove: () => void;
}) {
  const {
    register,
    control,
    watch,
    setValue,
    formState: { errors },
  } = form;
  const lineErrors = errors.lines?.[index];

  const qty = watch(`lines.${index}.qty`);
  const unitPrice = watch(`lines.${index}.unitPrice`);
  const invoiceLineId = watch(`lines.${index}.invoiceLineId`);

  const lineSubtotal = useMemo(() => {
    const q = Number(qty);
    const u = Number(unitPrice);
    if (!Number.isFinite(q) || !Number.isFinite(u)) return null;
    return q * u;
  }, [qty, unitPrice]);

  function applyInvoiceLine(invoiceLineRawId: string | null) {
    if (!invoice) return;
    if (!invoiceLineRawId || invoiceLineRawId === NONE_INVOICE) {
      setValue(`lines.${index}.invoiceLineId`, '');
      return;
    }
    const il = invoice.lines.find((l) => l.id === invoiceLineRawId);
    if (!il) return;
    setValue(`lines.${index}.invoiceLineId`, il.id);
    setValue(`lines.${index}.variantId`, il.variantId);
    setValue(`lines.${index}.qty`, il.qty);
    setValue(`lines.${index}.unitPrice`, il.unitPrice);
    // Notes intentionally NOT pre-filled — that field is for the
    // operator to type a reason for the credit on this line, not a
    // repeat of the invoice line's description.
  }

  return (
    <div className="rounded-md border border-border p-3">
      {invoice ? (
        <div className="mb-3">
          <Field>
            <FieldLabel htmlFor={`lines.${index}.invoiceLineId`}>
              Pre-fill from invoice line
            </FieldLabel>
            <Select
              value={invoiceLineId || NONE_INVOICE}
              onValueChange={applyInvoiceLine}
            >
              <SelectTrigger
                id={`lines.${index}.invoiceLineId`}
                className="w-full"
              >
                <SelectValue placeholder="Pick a line from the invoice">
                  {(v) => {
                    if (!v || v === NONE_INVOICE) {
                      return 'None — manual entry';
                    }
                    const il = invoice.lines.find((x) => x.id === v);
                    return il ? il.description : v;
                  }}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE_INVOICE}>
                  None — manual entry
                </SelectItem>
                {invoice.lines.map((il) => (
                  <SelectItem key={il.id} value={il.id}>
                    <span className="font-medium">{il.description}</span>
                    <span className="ml-2 text-muted-foreground tabular-nums">
                      {il.qty} × ${il.unitPrice}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>
      ) : null}

      <div className="grid grid-cols-12 gap-3">
        <div className="col-span-12 md:col-span-5">
          <Field>
            <FieldLabel htmlFor={`lines.${index}.variantId`}>SKU</FieldLabel>
            <Controller
              control={control}
              name={`lines.${index}.variantId`}
              render={({ field }) => (
                <VariantPicker
                  id={`lines.${index}.variantId`}
                  value={field.value || null}
                  // Notes is intentionally not auto-filled on variant
                  // pick — operators use that field for a credit reason,
                  // not a repeat of the product name (the picker already
                  // surfaces SKU + product name).
                  onValueChange={(v) => field.onChange(v ?? '')}
                  variants={variants}
                  ariaInvalid={!!lineErrors?.variantId}
                  placeholder="Pick a product…"
                  emptyMessage={
                    variants.length === 0
                      ? 'No active variants.'
                      : 'No matching products.'
                  }
                />
              )}
            />
            <FieldError errors={[lineErrors?.variantId]} />
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

        <div className="col-span-4 md:col-span-2">
          <Field>
            <FieldLabel htmlFor={`lines.${index}.unitPrice`}>
              Unit price
            </FieldLabel>
            <Input
              id={`lines.${index}.unitPrice`}
              inputMode="decimal"
              placeholder="0.00"
              aria-invalid={!!lineErrors?.unitPrice}
              {...register(`lines.${index}.unitPrice`)}
            />
            <FieldError errors={[lineErrors?.unitPrice]} />
          </Field>
        </div>

        <div className="col-span-12 md:col-span-3">
          <Field>
            <FieldLabel htmlFor={`lines.${index}.description`}>
              Notes
            </FieldLabel>
            <Input
              id={`lines.${index}.description`}
              aria-invalid={!!lineErrors?.description}
              placeholder="e.g. Returned damaged"
              {...register(`lines.${index}.description`)}
            />
            <FieldError errors={[lineErrors?.description]} />
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

      <div className="mt-2 flex items-center justify-end gap-3 text-xs">
        <span className="text-muted-foreground">Line total</span>
        <span className="tabular-nums font-medium text-foreground">
          {lineSubtotal != null
            ? formatCurrency(lineSubtotal.toFixed(2))
            : '—'}
        </span>
      </div>
    </div>
  );
}

function formatDateString(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      timeZone: 'UTC',
    });
  } catch {
    return iso;
  }
}
