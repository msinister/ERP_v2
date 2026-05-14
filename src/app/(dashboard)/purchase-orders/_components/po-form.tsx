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
import { Badge } from '@/components/ui/badge';
import { formatCurrency } from '@/lib/format';

// ===========================================================================
// Lookup option shapes — narrow so server fetches stay shallow.
// ===========================================================================

export type VendorOption = {
  id: string;
  code: string;
  name: string;
  type: 'STOCK' | 'DROP_SHIP' | 'SERVICE';
  defaultCurrency: string | null;
};
export type WarehouseOption = { id: string; code: string; name: string };
export type VariantOption = {
  id: string;
  sku: string;
  variantName: string | null;
  productName: string;
};
// Per-vendor catalog hint. Keyed by `${vendorId}:${variantId}` so a
// quick map lookup in the line row pre-fills the SKU + cost.
export type CatalogHint = {
  vendorId: string;
  variantId: string;
  vendorSku: string | null;
  latestCost: string | null;
};

// ===========================================================================
// Form schema — mirrors createPurchaseOrderInputSchema with '' for
// "no value" (RHF + native inputs produce strings).
// ===========================================================================

const qtyStr = z
  .string()
  .min(1, 'Required')
  .regex(/^\d+(\.\d+)?$/, 'Must be a non-negative decimal')
  .refine((v) => Number(v) > 0, 'Must be greater than 0');

const unitCostStr = z
  .string()
  .min(1, 'Required')
  .regex(/^\d+(\.\d+)?$/, 'Must be a non-negative decimal');

const lineSchema = z.object({
  variantId: z.string().min(1, 'Required'),
  qtyOrdered: qtyStr,
  unitCost: unitCostStr,
  vendorSku: z.string().max(255).optional(),
  manufacturerPartNumber: z.string().max(255).optional(),
  notes: z.string().max(2000).optional(),
});

const formSchema = z.object({
  vendorId: z.string().min(1, 'Required'),
  // Single warehouse at the header for pilot. Lines all inherit this
  // on submit. Per-line warehouse override is in the backend schema
  // but deferred for the UI per pilot scope cuts.
  warehouseId: z.string().min(1, 'Required'),
  expectedReceiveDate: z
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
});

export type PoFormValues = z.infer<typeof formSchema>;

export type PoFormMode =
  | { kind: 'create' }
  | { kind: 'edit'; purchaseOrderId: string };

const DEFAULT_VALUES: PoFormValues = {
  vendorId: '',
  warehouseId: '',
  expectedReceiveDate: '',
  currency: '',
  notes: '',
  lines: [emptyLine()],
};

function emptyLine(): PoFormValues['lines'][number] {
  return {
    variantId: '',
    qtyOrdered: '1',
    unitCost: '',
    vendorSku: '',
    manufacturerPartNumber: '',
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

export function PoForm({
  mode,
  vendors,
  warehouses,
  variants,
  catalogHints,
  defaultValues,
}: {
  mode: PoFormMode;
  vendors: VendorOption[];
  warehouses: WarehouseOption[];
  variants: VariantOption[];
  catalogHints: CatalogHint[];
  defaultValues?: Partial<PoFormValues>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  // Catalog hints keyed by `${vendorId}:${variantId}` so the line row
  // can look up vendor SKU + latest cost on every (vendor, variant)
  // change. Pilot scale: a few hundred rows total — trivial in memory.
  const catalogByKey = useMemo(() => {
    const map = new Map<string, CatalogHint>();
    for (const h of catalogHints) {
      map.set(`${h.vendorId}:${h.variantId}`, h);
    }
    return map;
  }, [catalogHints]);

  const form = useForm<PoFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      ...DEFAULT_VALUES,
      warehouseId:
        warehouses.length === 1 ? warehouses[0].id : DEFAULT_VALUES.warehouseId,
      ...defaultValues,
    },
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
  const warehouseId = watch('warehouseId');
  const selectedVendor = useMemo(
    () => vendors.find((v) => v.id === vendorId) ?? null,
    [vendors, vendorId],
  );

  // SERVICE-type vendors can't have line items (catalog is blocked at
  // the service layer). Surface a clear message instead of letting the
  // form hit a 400 on submit.
  const serviceVendorBlock =
    selectedVendor?.type === 'SERVICE';

  function submit(values: PoFormValues) {
    startTransition(async () => {
      if (serviceVendorBlock) {
        toast.error('SERVICE-type vendors are AP-only and cannot have POs.');
        return;
      }
      const payload = {
        vendorId: values.vendorId,
        expectedReceiveDate: nullEmpty(values.expectedReceiveDate),
        currency: nullEmpty(values.currency)?.toUpperCase(),
        notes: nullEmpty(values.notes),
        lines: values.lines.map((l) => ({
          variantId: l.variantId,
          // Header warehouse drives every line for pilot. Multi-
          // warehouse-per-line lands in a later slice — schema already
          // supports it.
          warehouseId: values.warehouseId,
          qtyOrdered: l.qtyOrdered,
          unitCost: l.unitCost,
          vendorSku: nullEmpty(l.vendorSku),
          manufacturerPartNumber: nullEmpty(l.manufacturerPartNumber),
          notes: nullEmpty(l.notes),
        })),
      };
      try {
        const endpoint =
          mode.kind === 'create'
            ? '/api/purchase-orders'
            : `/api/purchase-orders/${mode.purchaseOrderId}`;
        const method = mode.kind === 'create' ? 'POST' : 'PATCH';
        // PATCH (updatePurchaseOrderInputSchema) doesn't accept vendorId
        // — vendor is immutable on edit. Strip at the edge so the same
        // payload shape works for both paths.
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
        router.push(`/purchase-orders/${saved.id}`);
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
          <CardTitle className="text-sm">Vendor &amp; warehouse</CardTitle>
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
              {serviceVendorBlock ? (
                <p className="text-xs text-destructive">
                  SERVICE-type vendors are AP-only and cannot receive POs.
                </p>
              ) : null}
            </Field>

            <Field>
              <FieldLabel htmlFor="warehouseId">Warehouse</FieldLabel>
              <Controller
                control={control}
                name="warehouseId"
                render={({ field }) => (
                  <Select
                    value={field.value || undefined}
                    onValueChange={field.onChange}
                  >
                    <SelectTrigger
                      id="warehouseId"
                      className="w-full"
                      aria-invalid={!!errors.warehouseId}
                    >
                      <SelectValue placeholder="Select a warehouse" />
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
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Line items</CardTitle>
        </CardHeader>
        <CardContent>
          {!vendorId || !warehouseId ? (
            <div className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
              Pick a vendor and warehouse first.
            </div>
          ) : serviceVendorBlock ? (
            <div className="rounded-md border border-dashed border-destructive/30 bg-destructive/5 p-6 text-center text-sm text-destructive">
              SERVICE-type vendor — POs not supported.
            </div>
          ) : (
            <div className="space-y-3">
              {fields.map((field, index) => (
                <LineRow
                  key={field.id}
                  form={form}
                  index={index}
                  vendorId={vendorId}
                  variants={variants}
                  catalogByKey={catalogByKey}
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
              <TotalsSummary form={form} />
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">PO details</CardTitle>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="expectedReceiveDate">
                  Expected receive date
                </FieldLabel>
                <Input
                  id="expectedReceiveDate"
                  type="date"
                  {...register('expectedReceiveDate')}
                />
                <FieldError errors={[errors.expectedReceiveDate]} />
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
                placeholder="Notes for the buyer / receiver — not printed on the PO."
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
                  ? '/purchase-orders'
                  : `/purchase-orders/${mode.purchaseOrderId}`
              }
            />
          }
        >
          Cancel
        </Button>
        <Button
          type="submit"
          size="sm"
          disabled={pending || serviceVendorBlock}
        >
          {pending
            ? 'Saving…'
            : mode.kind === 'create'
              ? 'Create PO'
              : 'Save changes'}
        </Button>
      </div>
    </form>
  );
}

function LineRow({
  form,
  index,
  vendorId,
  variants,
  catalogByKey,
  canRemove,
  onRemove,
}: {
  form: UseFormReturn<PoFormValues>;
  index: number;
  vendorId: string;
  variants: VariantOption[];
  catalogByKey: Map<string, CatalogHint>;
  canRemove: boolean;
  onRemove: () => void;
}) {
  const {
    register,
    control,
    watch,
    setValue,
    getValues,
    formState: { errors },
  } = form;

  const variantId = watch(`lines.${index}.variantId`);
  const lineErrors = errors.lines?.[index];

  const hint = useMemo(() => {
    if (!vendorId || !variantId) return null;
    return catalogByKey.get(`${vendorId}:${variantId}`) ?? null;
  }, [vendorId, variantId, catalogByKey]);

  // Pre-fill vendor SKU + unit cost from the vendor catalog row when
  // both vendor and variant are selected — but ONLY when the field is
  // currently blank, so we never clobber operator input. Triggers on
  // each (vendor, variant) change.
  useEffect(() => {
    if (!hint) return;
    const current = getValues(`lines.${index}`);
    if (hint.vendorSku && !current.vendorSku) {
      setValue(`lines.${index}.vendorSku`, hint.vendorSku, {
        shouldDirty: false,
      });
    }
    if (hint.latestCost && !current.unitCost) {
      setValue(`lines.${index}.unitCost`, hint.latestCost, {
        shouldDirty: false,
      });
    }
    // hint identity changes when vendorId/variantId change — deps are
    // sufficient.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hint]);

  // Variants the selected vendor stocks come first so the picker
  // surfaces the "right" choice for that vendor's catalog. Non-catalog
  // variants remain selectable (spec line 36 — one-off purchases
  // allowed).
  const sortedVariants = useMemo(() => {
    if (!vendorId) return variants;
    return [...variants].sort((a, b) => {
      const ah = catalogByKey.has(`${vendorId}:${a.id}`) ? 0 : 1;
      const bh = catalogByKey.has(`${vendorId}:${b.id}`) ? 0 : 1;
      if (ah !== bh) return ah - bh;
      return a.sku.localeCompare(b.sku);
    });
  }, [vendorId, variants, catalogByKey]);

  return (
    <div className="rounded-md border border-border p-3">
      <div className="grid grid-cols-12 gap-3">
        <div className="col-span-12 md:col-span-5">
          <Field>
            <FieldLabel htmlFor={`lines.${index}.variantId`}>SKU</FieldLabel>
            <Controller
              control={control}
              name={`lines.${index}.variantId`}
              render={({ field }) => (
                <Select
                  value={field.value || undefined}
                  onValueChange={field.onChange}
                >
                  <SelectTrigger
                    id={`lines.${index}.variantId`}
                    className="w-full"
                    aria-invalid={!!lineErrors?.variantId}
                  >
                    <SelectValue placeholder="Pick a product…" />
                  </SelectTrigger>
                  <SelectContent>
                    {sortedVariants.length === 0 ? (
                      <div className="px-2 py-1.5 text-xs text-muted-foreground">
                        No active variants.
                      </div>
                    ) : (
                      sortedVariants.map((v) => {
                        const inCatalog = catalogByKey.has(
                          `${vendorId}:${v.id}`,
                        );
                        return (
                          <SelectItem key={v.id} value={v.id}>
                            <span className="font-mono text-xs text-muted-foreground">
                              {v.sku}
                            </span>{' '}
                            {v.productName}
                            {v.variantName ? ` — ${v.variantName}` : ''}
                            {inCatalog ? (
                              <Badge
                                variant="secondary"
                                className="ml-2 text-[10px]"
                              >
                                In catalog
                              </Badge>
                            ) : null}
                          </SelectItem>
                        );
                      })
                    )}
                  </SelectContent>
                </Select>
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
            <FieldLabel htmlFor={`lines.${index}.unitCost`}>
              Unit cost
            </FieldLabel>
            <Input
              id={`lines.${index}.unitCost`}
              inputMode="decimal"
              placeholder={hint?.latestCost ?? '0.00'}
              aria-invalid={!!lineErrors?.unitCost}
              {...register(`lines.${index}.unitCost`)}
            />
            <FieldError errors={[lineErrors?.unitCost]} />
          </Field>
        </div>

        <div className="col-span-6 md:col-span-2">
          <Field>
            <FieldLabel htmlFor={`lines.${index}.vendorSku`}>
              Vendor SKU
            </FieldLabel>
            <Input
              id={`lines.${index}.vendorSku`}
              placeholder={hint?.vendorSku ?? '—'}
              className="font-mono"
              {...register(`lines.${index}.vendorSku`)}
            />
            <FieldError errors={[lineErrors?.vendorSku]} />
          </Field>
        </div>

        <div className="col-span-6 md:col-span-1">
          <Field>
            <FieldLabel htmlFor={`lines.${index}.manufacturerPartNumber`}>
              MPN
            </FieldLabel>
            <Input
              id={`lines.${index}.manufacturerPartNumber`}
              className="font-mono"
              {...register(`lines.${index}.manufacturerPartNumber`)}
            />
            <FieldError errors={[lineErrors?.manufacturerPartNumber]} />
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

      <div className="mt-2">
        <Field>
          <FieldLabel htmlFor={`lines.${index}.notes`}>
            Line notes
          </FieldLabel>
          <Input
            id={`lines.${index}.notes`}
            placeholder="Optional note for the buyer / receiver."
            {...register(`lines.${index}.notes`)}
          />
        </Field>
      </div>
    </div>
  );
}

function TotalsSummary({ form }: { form: UseFormReturn<PoFormValues> }) {
  const lines = form.watch('lines');
  // Client-side total preview only — server is the source of truth.
  // Skip non-numeric values silently so partial input doesn't NaN out.
  const total = lines.reduce((acc, l) => {
    const qty = Number(l.qtyOrdered);
    const cost = Number(l.unitCost);
    if (!Number.isFinite(qty) || !Number.isFinite(cost)) return acc;
    return acc + qty * cost;
  }, 0);
  return (
    <div className="flex justify-end border-t border-border pt-3 text-sm">
      <div className="text-right">
        <div className="text-xs text-muted-foreground">PO total</div>
        <div className="text-lg font-semibold tabular-nums">
          {formatCurrency(total.toFixed(2))}
        </div>
      </div>
    </div>
  );
}
