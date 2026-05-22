'use client';

import type React from 'react';
import { useEffect, useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  Controller,
  useFieldArray,
  useForm,
  type Resolver,
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
import {
  VariantPicker,
  type CreatedProduct,
} from '@/components/shared/variant-picker';
import { formatCurrency } from '@/lib/format';
import {
  isNonNegativeDecimalInput,
  isPositiveDecimalInput,
  normalizeDecimalForSubmit,
} from '@/lib/decimal-input';
import { useAutoAppendLine } from '@/lib/forms/useAutoAppendLine';

// ===========================================================================
// Lookup option shapes (kept narrow so the server fetches stay shallow)
// ===========================================================================

export type CustomerOption = { id: string; code: string; name: string };
export type WarehouseOption = { id: string; code: string; name: string };
export type SalesRepOption = { id: string; name: string };

// Sentinel for "inherit the customer's rep" (Select can't use '' values).
// Maps to salesRepId: null on submit.
const NO_REP = '__inherit__';
// inventoryByWarehouse keys onHand/reserved by warehouseId so the
// LineRow can show QOH + available for the current SO warehouse in
// the SKU dropdown. Variants without inventory rows for the warehouse
// fall back to 0 on hand / 0 reserved.
export type VariantOption = {
  id: string;
  sku: string;
  variantName: string | null;
  productName: string;
  shortDescription: string | null;
  basePrice: string | null;
  inventoryByWarehouse: Record<
    string,
    { onHand: string; reserved: string }
  >;
};

// ===========================================================================
// Form schema — mirrors createSalesOrderInputSchema's shape but uses
// '' as the carrier for "no value" instead of undefined, because
// RHF + native inputs always produce strings.
// ===========================================================================

// Looser refines so operators can type ".25" without a leading zero;
// the submit handler normalizes before posting.
const decimalStr = z
  .union([
    z.literal(''),
    z
      .string()
      .refine(isNonNegativeDecimalInput, 'Must be a non-negative decimal'),
  ])
  .optional();

const percentStr = z
  .union([
    z.literal(''),
    z.string().refine(isNonNegativeDecimalInput, 'Must be a number'),
  ])
  .optional();

const qtyStr = z
  .string()
  .min(1, 'Required')
  .refine(isPositiveDecimalInput, 'Must be a positive decimal');

const lineSchema = z
  .object({
    variantId: z.string().min(1, 'Required'),
    qtyOrdered: qtyStr,
    manualUnitPrice: decimalStr,
    discountPercent: percentStr,
    discountAmount: decimalStr,
    customerNote: z.string().max(2000).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.discountPercent && data.discountAmount) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['discountAmount'],
        message: 'Set % or $, not both',
      });
    }
  });

const formSchema = z
  .object({
    customerId: z.string().min(1, 'Required'),
    warehouseId: z.string().min(1, 'Required'),
    customerPo: z.string().max(255).optional(),
    promisedShipDate: z
      .union([
        z.literal(''),
        z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
      ])
      .optional(),
    shippingAddress: z.string().max(2000).optional(),
    customerNotes: z.string().max(2000).optional(),
    internalNotes: z.string().max(2000).optional(),
    orderDiscountPercent: percentStr,
    orderDiscountAmount: decimalStr,
    shippingAmount: decimalStr,
    handlingAmount: decimalStr,
    // Per-order rep override (edit mode only). NO_REP sentinel = inherit
    // the customer's rep; the submit handler maps it to null.
    salesRepId: z.string().optional(),
    // Drop fully-blank lines (e.g. the auto-appended trailing line)
    // before validation so they never block submit; filled lines keep
    // their strict per-line validation, and the resolver hands the submit
    // handler the already-filtered array.
    lines: z.preprocess(
      (val) =>
        Array.isArray(val)
          ? (val as Array<{ variantId?: string }>).filter(
              (l) => (l.variantId ?? '').trim() !== '',
            )
          : val,
      z.array(lineSchema).min(1, 'At least one line is required'),
    ),
  })
  .superRefine((data, ctx) => {
    if (data.orderDiscountPercent && data.orderDiscountAmount) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['orderDiscountAmount'],
        message: 'Set % or $, not both',
      });
    }
  });

export type OrderFormValues = z.infer<typeof formSchema>;

export type OrderFormMode =
  | { kind: 'create' }
  | { kind: 'edit'; salesOrderId: string };

const DEFAULT_VALUES: OrderFormValues = {
  customerId: '',
  warehouseId: '',
  customerPo: '',
  promisedShipDate: '',
  shippingAddress: '',
  customerNotes: '',
  internalNotes: '',
  orderDiscountPercent: '',
  orderDiscountAmount: '',
  shippingAmount: '',
  handlingAmount: '',
  salesRepId: NO_REP,
  lines: [emptyLine()],
};

function emptyLine(): OrderFormValues['lines'][number] {
  return {
    variantId: '',
    qtyOrdered: '1',
    manualUnitPrice: '',
    discountPercent: '',
    discountAmount: '',
    customerNote: '',
  };
}

function nullEmpty(v: string | undefined): string | undefined {
  if (v == null) return undefined;
  const trimmed = v.trim();
  return trimmed === '' ? undefined : trimmed;
}

// Optional decimal: empty stays undefined, anything else gets
// normalized for the strict server validator (".25" → "0.25").
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

// ===========================================================================
// Form
// ===========================================================================

export function OrderForm({
  mode,
  customers,
  warehouses,
  variants,
  salesReps = [],
  canChangeRep = false,
  defaultValues,
}: {
  mode: OrderFormMode;
  customers: CustomerOption[];
  warehouses: WarehouseOption[];
  variants: VariantOption[];
  // Active reps for the edit-mode rep override picker. Omitted on create.
  salesReps?: SalesRepOption[];
  // Gates the rep override field (UI + payload) on sales_orders.change_rep.
  // The server (PATCH route) re-checks; this just hides the control and
  // omits salesRepId from the request for users without the permission.
  canChangeRep?: boolean;
  defaultValues?: Partial<OrderFormValues>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // Shadow the variants prop so an inline-created product appears on
  // every line. New products have no inventory yet (empty map).
  const [variantsState, setVariantsState] = useState<VariantOption[]>(variants);

  function onProductCreated(created: CreatedProduct) {
    setVariantsState((prev) =>
      prev.some((v) => v.id === created.variantId)
        ? prev
        : [
            ...prev,
            {
              id: created.variantId,
              sku: created.sku,
              variantName: created.variantName,
              productName: created.productName,
              shortDescription: created.shortDescription,
              basePrice: created.basePrice,
              inventoryByWarehouse: {},
            },
          ],
    );
  }

  const form = useForm<OrderFormValues>({
    // Cast: the lines z.preprocess makes the schema's INPUT type
    // `lines: unknown`, which RHF's resolver typing rejects. The resolver
    // still validates + returns OrderFormValues at runtime.
    resolver: zodResolver(formSchema) as unknown as Resolver<OrderFormValues>,
    defaultValues: ((): OrderFormValues => {
      const base: OrderFormValues = {
        ...DEFAULT_VALUES,
        // Pilot: one warehouse. Pre-select it so the operator doesn't
        // have to. If/when there are multiple, the default falls through.
        warehouseId:
          warehouses.length === 1
            ? warehouses[0].id
            : DEFAULT_VALUES.warehouseId,
        ...defaultValues,
      };
      // Edit forms load with existing lines; add a trailing blank so the
      // operator can start adding immediately (auto-append takes over).
      if (mode.kind === 'edit') {
        base.lines = [...base.lines, emptyLine()];
      }
      return base;
    })(),
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

  const customerId = watch('customerId');
  const warehouseId = watch('warehouseId');

  // Fill the SKU on the last line → a fresh blank line appears below it.
  const watchedLines = watch('lines') ?? [];
  useAutoAppendLine(
    watchedLines[watchedLines.length - 1]?.variantId,
    () => append(emptyLine()),
  );

  function submit(values: OrderFormValues) {
    startTransition(async () => {
      // Whole body inside try so ANY failure (payload build, fetch,
      // parse) lands in the catch → toast + the transition settles, so
      // the button never sticks on "Saving…".
      try {
        const payload = {
          customerId: values.customerId,
          warehouseId: values.warehouseId,
          customerPo: nullEmpty(values.customerPo),
          promisedShipDate: nullEmpty(values.promisedShipDate),
          shippingAddress: nullEmpty(values.shippingAddress),
          customerNotes: nullEmpty(values.customerNotes),
          internalNotes: nullEmpty(values.internalNotes),
          orderDiscountPercent: nullEmptyDecimal(values.orderDiscountPercent),
          orderDiscountAmount: nullEmptyDecimal(values.orderDiscountAmount),
          shippingAmount: nullEmptyDecimal(values.shippingAmount),
          handlingAmount: nullEmptyDecimal(values.handlingAmount),
          lines: values.lines.map((l) => ({
            variantId: l.variantId,
            // Every line carries the SO-level warehouse for pilot. Multi-
            // warehouse per-line lands in a later slice; the schema
            // already supports it.
            warehouseId: values.warehouseId,
            qtyOrdered: normalizeDecimalForSubmit(l.qtyOrdered),
            manualUnitPrice: nullEmptyDecimal(l.manualUnitPrice),
            discountPercent: nullEmptyDecimal(l.discountPercent),
            discountAmount: nullEmptyDecimal(l.discountAmount),
            customerNote: nullEmpty(l.customerNote),
          })),
        };
        const endpoint =
          mode.kind === 'create'
            ? '/api/sales-orders'
            : `/api/sales-orders/${mode.salesOrderId}`;
        const method = mode.kind === 'create' ? 'POST' : 'PATCH';
        // PATCH omits customerId — updateSalesOrderInputSchema doesn't
        // accept it. Strip at the edge so the same payload shape works
        // for both paths.
        const body =
          mode.kind === 'create'
            ? payload
            : (() => {
                const { customerId: _c, ...rest } = payload;
                void _c;
                // Edit-only: include the per-order rep override only when
                // the user can change it (the field is hidden otherwise).
                // NO_REP sentinel clears it (inherit the customer's rep).
                return {
                  ...rest,
                  ...(canChangeRep
                    ? {
                        salesRepId:
                          values.salesRepId && values.salesRepId !== NO_REP
                            ? values.salesRepId
                            : null,
                      }
                    : {}),
                };
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
        router.push(`/sales-orders/${saved.id}`);
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
          <CardTitle className="text-sm">Customer &amp; warehouse</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
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
              <FieldLabel htmlFor="warehouseId">Warehouse</FieldLabel>
              <Controller
                control={control}
                name="warehouseId"
                render={({ field }) => (
                  <Select
                    value={field.value}
                    onValueChange={field.onChange}
                    disabled={mode.kind === 'edit'}
                  >
                    <SelectTrigger
                      id="warehouseId"
                      className="w-full"
                      aria-invalid={!!errors.warehouseId}
                    >
                      <SelectValue placeholder="Select a warehouse">
                        {(v) => {
                          if (!v) return null;
                          const w = warehouses.find((x) => x.id === v);
                          if (!w) return v;
                          return (
                            <>
                              <span className="font-mono text-xs text-muted-foreground">
                                {w.code}
                              </span>{' '}
                              {w.name}
                            </>
                          );
                        }}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {warehouses.map((w) => (
                        <SelectItem key={w.id} value={w.id}>
                          <span className="font-mono text-xs text-muted-foreground">
                            {w.code}
                          </span>{' '}
                          {w.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
              <FieldError errors={[errors.warehouseId]} />
            </Field>
          </div>
          {mode.kind === 'edit' && canChangeRep ? (
            <div className="mt-4 md:max-w-[calc(50%-0.5rem)]">
              <Field>
                <FieldLabel htmlFor="salesRepId">Sales rep</FieldLabel>
                <Controller
                  control={control}
                  name="salesRepId"
                  render={({ field }) => (
                    <Select
                      value={field.value || NO_REP}
                      onValueChange={field.onChange}
                    >
                      <SelectTrigger id="salesRepId" className="w-full">
                        <SelectValue>
                          {(v) =>
                            !v || v === NO_REP
                              ? 'Customer default'
                              : (salesReps.find((r) => r.id === v)?.name ?? v)
                          }
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NO_REP}>Customer default</SelectItem>
                        {salesReps.map((r) => (
                          <SelectItem key={r.id} value={r.id}>
                            {r.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
                <p className="text-xs text-muted-foreground">
                  Overrides the rep for this order only — the customer&apos;s
                  default is unchanged.
                </p>
              </Field>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Line items</CardTitle>
        </CardHeader>
        <CardContent>
          {!customerId ? (
            <div className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
              Pick a customer first — pricing depends on it.
            </div>
          ) : (
            <div className="space-y-3">
              {fields.map((field, index) => (
                <LineRow
                  key={field.id}
                  form={form}
                  index={index}
                  customerId={customerId}
                  warehouseId={warehouseId}
                  variants={variantsState}
                  canRemove={fields.length > 1}
                  onRemove={() => remove(index)}
                  onProductCreated={onProductCreated}
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
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Order details</CardTitle>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="customerPo">Customer PO</FieldLabel>
                <Input id="customerPo" {...register('customerPo')} />
                <FieldError errors={[errors.customerPo]} />
              </Field>
              <Field>
                <FieldLabel htmlFor="promisedShipDate">
                  Promised ship date
                </FieldLabel>
                <Input
                  id="promisedShipDate"
                  type="date"
                  {...register('promisedShipDate')}
                />
                <FieldError errors={[errors.promisedShipDate]} />
              </Field>
            </div>
            <Field>
              <FieldLabel htmlFor="shippingAddress">Ship-to address</FieldLabel>
              <Textarea
                id="shippingAddress"
                rows={3}
                placeholder="Free-text address. Customer addresses become a relation in a later slice."
                {...register('shippingAddress')}
              />
              <FieldError errors={[errors.shippingAddress]} />
            </Field>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="customerNotes">
                  Customer notes (printed)
                </FieldLabel>
                <Textarea
                  id="customerNotes"
                  rows={3}
                  {...register('customerNotes')}
                />
                <FieldError errors={[errors.customerNotes]} />
              </Field>
              <Field>
                <FieldLabel htmlFor="internalNotes">Internal notes</FieldLabel>
                <Textarea
                  id="internalNotes"
                  rows={3}
                  {...register('internalNotes')}
                />
                <FieldError errors={[errors.internalNotes]} />
              </Field>
            </div>
          </FieldGroup>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Adjustments</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <Field>
              <FieldLabel htmlFor="orderDiscountPercent">
                Order discount %
              </FieldLabel>
              <Input
                id="orderDiscountPercent"
                inputMode="decimal"
                placeholder="—"
                {...register('orderDiscountPercent')}
              />
              <FieldError errors={[errors.orderDiscountPercent]} />
            </Field>
            <Field>
              <FieldLabel htmlFor="orderDiscountAmount">
                Order discount $
              </FieldLabel>
              <Input
                id="orderDiscountAmount"
                inputMode="decimal"
                placeholder="—"
                {...register('orderDiscountAmount')}
              />
              <FieldError errors={[errors.orderDiscountAmount]} />
            </Field>
            <Field>
              <FieldLabel htmlFor="shippingAmount">Shipping</FieldLabel>
              <Input
                id="shippingAmount"
                inputMode="decimal"
                placeholder="—"
                {...register('shippingAmount')}
              />
              <FieldError errors={[errors.shippingAmount]} />
            </Field>
            <Field>
              <FieldLabel htmlFor="handlingAmount">Handling</FieldLabel>
              <Input
                id="handlingAmount"
                inputMode="decimal"
                placeholder="—"
                {...register('handlingAmount')}
              />
              <FieldError errors={[errors.handlingAmount]} />
            </Field>
          </div>
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
                  ? '/sales-orders'
                  : `/sales-orders/${mode.salesOrderId}`
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
// Per-line subcomponent: owns its own live pricing-preview state. Re-runs
// the resolve when customer / variant / qty / manualUnitPrice changes
// (debounced to avoid hammering the endpoint while the operator types).
// ===========================================================================

type LinePriceResolve = {
  unitPrice: string;
  rule: string;
  discountPercent: string | null;
};

function LineRow({
  form,
  index,
  customerId,
  warehouseId,
  variants,
  canRemove,
  onRemove,
  onProductCreated,
}: {
  form: UseFormReturn<OrderFormValues>;
  index: number;
  customerId: string;
  warehouseId: string;
  variants: VariantOption[];
  canRemove: boolean;
  onRemove: () => void;
  onProductCreated: (created: CreatedProduct) => void;
}) {
  const {
    register,
    control,
    watch,
    formState: { errors },
  } = form;

  const variantId = watch(`lines.${index}.variantId`);
  const qty = watch(`lines.${index}.qtyOrdered`);
  const manualUnitPrice = watch(`lines.${index}.manualUnitPrice`);
  const discountPercent = watch(`lines.${index}.discountPercent`);
  const discountAmount = watch(`lines.${index}.discountAmount`);

  const [resolved, setResolved] = useState<LinePriceResolve | null>(null);
  const [resolving, setResolving] = useState(false);

  // Debounced resolve. The endpoint is cheap (a few reads) but
  // operators type fast; 200ms tames the burst without feeling slow.
  useEffect(() => {
    if (!customerId || !variantId || !qty) {
      setResolved(null);
      return;
    }
    const handle = window.setTimeout(() => {
      const params = new URLSearchParams({
        customerId,
        variantId,
        qty,
      });
      if (manualUnitPrice) params.set('manualUnitPrice', manualUnitPrice);
      setResolving(true);
      fetch(`/api/pricing/resolve?${params.toString()}`)
        .then(async (res) => {
          if (!res.ok) {
            setResolved(null);
            return;
          }
          const body = (await res.json()) as LinePriceResolve;
          setResolved(body);
        })
        .catch(() => setResolved(null))
        .finally(() => setResolving(false));
    }, 200);
    return () => window.clearTimeout(handle);
  }, [customerId, variantId, qty, manualUnitPrice]);

  const lineErrors = errors.lines?.[index];
  const selectedVariant = useMemo(
    () => variants.find((v) => v.id === variantId) ?? null,
    [variants, variantId],
  );

  // Live line total (qty × unit price − discount). Uses the resolved
  // unit price when no manual override is typed; falls back to 0 when
  // the resolver hasn't run yet (no customer / variant picked).
  const effectiveUnitPriceStr =
    (manualUnitPrice && manualUnitPrice.trim() !== ''
      ? manualUnitPrice
      : resolved?.unitPrice) ?? null;
  const lineTotal = (() => {
    const q = Number(qty);
    const u = Number(effectiveUnitPriceStr);
    if (!Number.isFinite(q) || !Number.isFinite(u) || effectiveUnitPriceStr == null)
      return null;
    let total = q * u;
    if (discountAmount && /^\d*\.?\d+$/.test(discountAmount)) {
      total -= Number(discountAmount);
    } else if (discountPercent && /^\d*\.?\d+$/.test(discountPercent)) {
      total -= total * (Number(discountPercent) / 100);
    }
    return total < 0 ? 0 : total;
  })();

  return (
    <div className="rounded-md border border-border p-3">
      <div className="grid grid-cols-12 gap-3">
        <div className="col-span-12 md:col-span-4">
          <Field>
            <FieldLabel htmlFor={`lines.${index}.variantId`}>SKU</FieldLabel>
            <Controller
              control={control}
              name={`lines.${index}.variantId`}
              render={({ field }) => (
                <VariantPicker
                  id={`lines.${index}.variantId`}
                  value={field.value || null}
                  onValueChange={(v) => field.onChange(v ?? '')}
                  variants={variants}
                  ariaInvalid={!!lineErrors?.variantId}
                  placeholder="Pick a product…"
                  emptyMessage={
                    variants.length === 0
                      ? 'No active variants.'
                      : 'No matching products.'
                  }
                  // QOH / available for the current SO warehouse,
                  // rendered in the right-side cell of each row.
                  // Variants with no inventory record for this
                  // warehouse fall back to 0.
                  renderItemMeta={(v) => {
                    const source = variants.find((x) => x.id === v.id);
                    const stock =
                      source?.inventoryByWarehouse[warehouseId];
                    const onHand = Number(stock?.onHand ?? '0');
                    const reserved = Number(stock?.reserved ?? '0');
                    const available = onHand - reserved;
                    return (
                      <span>
                        QOH {formatStockQty(onHand)} / avail{' '}
                        {formatStockQty(available)}
                      </span>
                    );
                  }}
                  onCreated={onProductCreated}
                />
              )}
            />
            <FieldError errors={[lineErrors?.variantId]} />
          </Field>
        </div>

        <div className="col-span-4 md:col-span-1">
          <Field>
            <FieldLabel htmlFor={`lines.${index}.qtyOrdered`}>Qty</FieldLabel>
            <Input
              id={`lines.${index}.qtyOrdered`}
              inputMode="decimal"
              aria-invalid={!!lineErrors?.qtyOrdered}
              {...register(`lines.${index}.qtyOrdered`)}
            />
            <FieldError errors={[lineErrors?.qtyOrdered]} />
          </Field>
        </div>

        <div className="col-span-8 md:col-span-2">
          <Field>
            <FieldLabel htmlFor={`lines.${index}.manualUnitPrice`}>
              Unit price
            </FieldLabel>
            <Input
              id={`lines.${index}.manualUnitPrice`}
              inputMode="decimal"
              placeholder={
                resolved ? formatCurrency(resolved.unitPrice) : 'auto'
              }
              aria-invalid={!!lineErrors?.manualUnitPrice}
              {...register(`lines.${index}.manualUnitPrice`)}
            />
            <PriceHint
              resolved={resolved}
              resolving={resolving}
              overridden={!!manualUnitPrice}
            />
            <FieldError errors={[lineErrors?.manualUnitPrice]} />
          </Field>
        </div>

        <div className="col-span-6 md:col-span-1">
          <Field>
            <FieldLabel htmlFor={`lines.${index}.discountPercent`}>
              Disc %
            </FieldLabel>
            <Input
              id={`lines.${index}.discountPercent`}
              inputMode="decimal"
              placeholder="—"
              aria-invalid={!!lineErrors?.discountPercent}
              {...register(`lines.${index}.discountPercent`)}
            />
            <FieldError errors={[lineErrors?.discountPercent]} />
          </Field>
        </div>

        <div className="col-span-6 md:col-span-1">
          <Field>
            <FieldLabel htmlFor={`lines.${index}.discountAmount`}>
              Disc $
            </FieldLabel>
            <Input
              id={`lines.${index}.discountAmount`}
              inputMode="decimal"
              placeholder="—"
              aria-invalid={!!lineErrors?.discountAmount}
              {...register(`lines.${index}.discountAmount`)}
            />
            <FieldError errors={[lineErrors?.discountAmount]} />
          </Field>
        </div>

        {/* Line note inline (not a full-width sub-row). Optional → no
            validation. */}
        <div className="col-span-12 md:col-span-2">
          <Field>
            <FieldLabel htmlFor={`lines.${index}.customerNote`}>
              Note
            </FieldLabel>
            <Input
              id={`lines.${index}.customerNote`}
              placeholder="Optional (printed)"
              {...register(`lines.${index}.customerNote`)}
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

      {/* Line total preview — computed from current qty/price/discount
          inputs. Renders as a thin right-aligned strip below the grid
          so we don't have to claim a 12-col slot for it. */}
      <div className="mt-2 flex items-center justify-end gap-3 text-xs">
        {selectedVariant?.basePrice ? (
          <span className="text-muted-foreground">
            List {formatCurrency(selectedVariant.basePrice)}
          </span>
        ) : null}
        <span className="text-muted-foreground">Line total</span>
        <span className="tabular-nums font-medium text-foreground">
          {lineTotal != null ? formatCurrency(lineTotal.toFixed(2)) : '—'}
        </span>
      </div>
    </div>
  );
}

// Helper used by the VariantPicker's renderItemMeta for QOH/avail.
function formatStockQty(n: number): string {
  if (!Number.isFinite(n)) return '0';
  // Strip trailing zeros after the decimal — 12.00 → 12; 12.50 → 12.5.
  return n
    .toFixed(5)
    .replace(/\.?0+$/, '');
}

function PriceHint({
  resolved,
  resolving,
  overridden,
}: {
  resolved: LinePriceResolve | null;
  resolving: boolean;
  overridden: boolean;
}) {
  if (resolving) {
    return <p className="text-[10px] text-muted-foreground">resolving…</p>;
  }
  if (!resolved) return null;
  const tone = overridden
    ? 'text-amber-600 dark:text-amber-400'
    : 'text-muted-foreground';
  const label = overridden ? 'manual override' : ruleLabel(resolved.rule);
  return (
    <p className={`text-[10px] ${tone}`}>
      {label} · {formatCurrency(resolved.unitPrice)}
      {resolved.discountPercent
        ? ` · −${Number(resolved.discountPercent)}%`
        : ''}
    </p>
  );
}

function ruleLabel(rule: string): string {
  switch (rule) {
    case 'MANUAL_OVERRIDE':
      return 'manual';
    case 'CUSTOMER_SPECIFIC':
      return 'customer price';
    case 'TIER_DISCOUNT':
      return 'tier';
    case 'BASE_PRICE':
      return 'list price';
    case 'QTY_BREAK':
      return 'qty break';
    case 'PROMO':
      return 'promo';
    case 'COST_PLUS':
      return 'cost+';
    default:
      return rule.toLowerCase();
  }
}
