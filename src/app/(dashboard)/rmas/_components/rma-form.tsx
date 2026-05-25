'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from '@/lib/toast';

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
import {
  CustomerPicker,
  type SalesRepOption,
  type PaymentTermOption,
  type CreatedCustomer,
} from '@/components/shared/customer-picker';
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
export type VariantOption = {
  id: string;
  sku: string;
  variantName: string | null;
  productName: string;
};
export type RestockingFeeDefault = {
  percent: string | null;
  flat: string | null;
};

type InvoiceListOption = {
  id: string;
  number: string;
  invoiceDate: string;
  status: string;
  total: string;
};

type InvoiceLinePayload = {
  id: string;
  variantId: string;
  description: string;
  qty: string;
  unitPrice: string;
  qtyReturned: string;
};

type InvoicePayload = {
  id: string;
  number: string;
  status: string;
  lines: InvoiceLinePayload[];
};

// ===========================================================================
// Form schema
// ===========================================================================

const optionalPercent = z
  .union([
    z.literal(''),
    z.string().refine((v) => {
      if (!isNonNegativeDecimalInput(v)) return false;
      const n = Number(v);
      return n <= 100;
    }, '0–100'),
  ])
  .optional();

const optionalNonNeg = z
  .union([
    z.literal(''),
    z.string().refine(isNonNegativeDecimalInput, 'Must be >= 0'),
  ])
  .optional();

// Each invoice-line row in the form. `selected` toggles inclusion; `qty`
// is the requested return qty (validated against remaining at submit).
const lineRowSchema = z
  .object({
    invoiceLineId: z.string(),
    selected: z.boolean(),
    qty: z.string(),
  })
  .superRefine((data, ctx) => {
    if (!data.selected) return;
    if (!data.qty || !isPositiveDecimalInput(data.qty)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['qty'],
        message: 'Required',
      });
    }
  });

const formSchema = z
  .object({
    customerId: z.string().min(1, 'Required'),
    invoiceId: z.string().min(1, 'Required'),
    returnType: z.enum(['STANDARD', 'RETURNLESS']),
    // Spec says required; the server validator is more permissive
    // (optional ≤2000), but operator-supplied context here is
    // operationally important so we enforce it client-side.
    reason: z.string().min(1, 'Required').max(2000),
    restockingFeePercent: optionalPercent,
    restockingFeeFlat: optionalNonNeg,
    lines: z.array(lineRowSchema),
  })
  .superRefine((data, ctx) => {
    if (
      data.restockingFeePercent &&
      data.restockingFeePercent !== '' &&
      data.restockingFeeFlat &&
      data.restockingFeeFlat !== ''
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['restockingFeeFlat'],
        message: 'Set % OR $, not both',
      });
    }
    const anySelected = data.lines.some((l) => l.selected);
    if (!anySelected) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['lines'],
        message: 'Pick at least one line to return',
      });
    }
  });

type FormValues = z.infer<typeof formSchema>;

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

export function RmaForm({
  customers,
  variants,
  restockingFeeDefault,
  salesReps = [],
  paymentTerms = [],
  defaultSalesRepId = null,
}: {
  customers: CustomerOption[];
  variants: VariantOption[];
  restockingFeeDefault: RestockingFeeDefault;
  // For the inline create-customer dialog.
  salesReps?: SalesRepOption[];
  paymentTerms?: PaymentTermOption[];
  defaultSalesRepId?: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // Shadow the customers prop so an inline-created customer appears
  // immediately and can be auto-selected.
  const [customersState, setCustomersState] =
    useState<CustomerOption[]>(customers);

  function onCustomerCreated(created: CreatedCustomer) {
    setCustomersState((prev) =>
      prev.some((c) => c.id === created.id)
        ? prev
        : [...prev, { id: created.id, code: created.code, name: created.name }],
    );
  }

  // variantId → variant (joined client-side from the catalog snapshot
  // so the invoice-line rows can render SKU + product name without an
  // extra round-trip per line).
  const variantById = new Map(variants.map((v) => [v.id, v]));

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      customerId: '',
      invoiceId: '',
      returnType: 'STANDARD',
      reason: '',
      restockingFeePercent: restockingFeeDefault.percent ?? '',
      restockingFeeFlat: restockingFeeDefault.flat ?? '',
      lines: [],
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

  const customerId = watch('customerId');
  const invoiceId = watch('invoiceId');
  const lines = watch('lines');

  // Customer-scoped invoice list. Fetched on customer change. We don't
  // filter to a specific status server-side because the operator might
  // legitimately RMA a partially-paid invoice — the createRma service
  // only rejects VOIDED invoices, so we filter that one status here.
  const [invoices, setInvoices] = useState<InvoiceListOption[]>([]);
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
        const body = (await res.json()) as InvoiceListOption[];
        if (!cancelled) {
          setInvoices(body.filter((inv) => inv.status !== 'VOIDED'));
        }
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

  // Customer-change side effect: drop invoice + lines.
  const [didInit, setDidInit] = useState(false);
  useEffect(() => {
    if (!didInit) {
      setDidInit(true);
      return;
    }
    setValue('invoiceId', '');
    setValue('lines', []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId]);

  // Invoice-scoped lines. Fetched on invoice change. Each line carries
  // the original qty, the cumulative returned qty, and the unit price
  // — the remaining returnable is qty − qtyReturned and the row qty
  // input defaults to that (full return) when the row is first ticked.
  const [invoiceLines, setInvoiceLines] = useState<InvoiceLinePayload[]>([]);
  const [invoiceLoading, setInvoiceLoading] = useState(false);

  useEffect(() => {
    if (!invoiceId) {
      setInvoiceLines([]);
      setValue('lines', []);
      return;
    }
    let cancelled = false;
    setInvoiceLoading(true);
    fetch(`/api/invoices/${encodeURIComponent(invoiceId)}`)
      .then(async (res) => {
        if (!res.ok) {
          setInvoiceLines([]);
          return;
        }
        const body = (await res.json()) as InvoicePayload;
        if (cancelled) return;
        setInvoiceLines(body.lines);
        // Reset the per-line rows: unselected, qty empty. Operator
        // ticks each line individually.
        setValue(
          'lines',
          body.lines.map((il) => ({
            invoiceLineId: il.id,
            selected: false,
            qty: '',
          })),
        );
      })
      .catch(() => {
        if (!cancelled) setInvoiceLines([]);
      })
      .finally(() => {
        if (!cancelled) setInvoiceLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // setValue is stable; intentionally excluded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoiceId]);

  // Per-line remaining helper.
  function remainingFor(invoiceLineId: string): number {
    const il = invoiceLines.find((x) => x.id === invoiceLineId);
    if (!il) return 0;
    return Number(il.qty) - Number(il.qtyReturned);
  }

  function submit(values: FormValues) {
    const selectedLines = values.lines.filter((l) => l.selected);
    // Validate against remaining at submit (the row schema can't see
    // the invoice-line metadata directly).
    for (const l of selectedLines) {
      const remaining = remainingFor(l.invoiceLineId);
      const requested = Number(l.qty);
      if (requested > remaining) {
        toast.error(
          `Requested qty ${requested} exceeds remaining ${remaining} on line.`,
        );
        return;
      }
    }

    startTransition(async () => {
      const payload = {
        customerId: values.customerId,
        invoiceId: values.invoiceId,
        returnless: values.returnType === 'RETURNLESS',
        reason: values.reason.trim(),
        restockingFeePercent:
          values.restockingFeePercent && values.restockingFeePercent !== ''
            ? normalizeDecimalForSubmit(values.restockingFeePercent)
            : undefined,
        restockingFeeFlat:
          values.restockingFeeFlat && values.restockingFeeFlat !== ''
            ? normalizeDecimalForSubmit(values.restockingFeeFlat)
            : undefined,
        lines: selectedLines.map((l) => ({
          invoiceLineId: l.invoiceLineId,
          qty: normalizeDecimalForSubmit(l.qty),
        })),
      };
      try {
        const res = await fetch('/api/rmas', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          toast.error(await readApiError(res));
          return;
        }
        const saved = (await res.json()) as { id: string; number: string };
        toast.success(`Created ${saved.number}`);
        router.push(`/rmas/${saved.id}`);
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
          <CardTitle className="text-sm">Customer &amp; invoice</CardTitle>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="customerId">Customer</FieldLabel>
                <Controller
                  control={control}
                  name="customerId"
                  render={({ field }) => (
                    <CustomerPicker
                      id="customerId"
                      value={field.value || null}
                      onValueChange={(v) => field.onChange(v ?? '')}
                      customers={customersState}
                      salesReps={salesReps}
                      paymentTerms={paymentTerms}
                      defaultSalesRepId={defaultSalesRepId}
                      onCreated={onCustomerCreated}
                      ariaInvalid={!!errors.customerId}
                      placeholder="Search customers…"
                    />
                  )}
                />
                <FieldError errors={[errors.customerId]} />
              </Field>

              <Field>
                <FieldLabel htmlFor="invoiceId">Invoice</FieldLabel>
                <Controller
                  control={control}
                  name="invoiceId"
                  render={({ field }) => (
                    <Select
                      value={field.value}
                      onValueChange={field.onChange}
                      disabled={!customerId || invoicesLoading}
                    >
                      <SelectTrigger
                        id="invoiceId"
                        className="w-full"
                        aria-invalid={!!errors.invoiceId}
                      >
                        <SelectValue
                          placeholder={
                            !customerId
                              ? 'Pick a customer first'
                              : invoicesLoading
                                ? 'Loading…'
                                : 'Select an invoice'
                          }
                        >
                          {(v) => {
                            if (!v) return null;
                            const inv = invoices.find((x) => x.id === v);
                            return inv ? inv.number : v;
                          }}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {invoices.length === 0 ? (
                          <div className="px-2 py-1.5 text-xs text-muted-foreground">
                            {!customerId
                              ? 'Pick a customer to see invoices.'
                              : invoicesLoading
                                ? 'Loading…'
                                : 'No invoices for this customer.'}
                          </div>
                        ) : (
                          invoices.map((inv) => (
                            <SelectItem key={inv.id} value={inv.id}>
                              <span className="font-mono text-xs">
                                {inv.number}
                              </span>
                              <span className="ml-2 text-muted-foreground">
                                {formatInvoiceDate(inv.invoiceDate)} ·{' '}
                                {inv.status} ·{' '}
                                {formatCurrency(inv.total)}
                              </span>
                            </SelectItem>
                          ))
                        )}
                      </SelectContent>
                    </Select>
                  )}
                />
                <FieldError errors={[errors.invoiceId]} />
              </Field>
            </div>
          </FieldGroup>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Return lines</CardTitle>
        </CardHeader>
        <CardContent>
          {!invoiceId ? (
            <div className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
              Pick an invoice to see its lines.
            </div>
          ) : invoiceLoading ? (
            <div className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
              Loading invoice lines…
            </div>
          ) : invoiceLines.length === 0 ? (
            <div className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
              This invoice has no lines.
            </div>
          ) : (
            <div className="space-y-3">
              {invoiceLines.map((il, idx) => {
                const variant = variantById.get(il.variantId);
                const remaining =
                  Number(il.qty) - Number(il.qtyReturned);
                const fullyReturned = remaining <= 0;
                const row = lines[idx];
                const rowError = errors.lines?.[idx]?.qty;
                return (
                  <div
                    key={il.id}
                    className={
                      'rounded-md border p-3 ' +
                      (fullyReturned
                        ? 'border-dashed border-border bg-muted/30 text-muted-foreground'
                        : 'border-border')
                    }
                  >
                    <div className="grid grid-cols-12 gap-3">
                      <div className="col-span-12 md:col-span-1 flex items-start">
                        <Controller
                          control={control}
                          name={`lines.${idx}.selected`}
                          render={({ field }) => (
                            <Checkbox
                              checked={field.value}
                              disabled={fullyReturned}
                              onCheckedChange={(checked) => {
                                const next = !!checked;
                                field.onChange(next);
                                // When first ticked, default qty to the
                                // full remaining. Untick clears qty.
                                if (next && (!row?.qty || row.qty === '')) {
                                  setValue(
                                    `lines.${idx}.qty`,
                                    String(remaining),
                                  );
                                }
                                if (!next) {
                                  setValue(`lines.${idx}.qty`, '');
                                }
                              }}
                              aria-label="Include this line"
                            />
                          )}
                        />
                      </div>
                      <div className="col-span-12 md:col-span-6 min-w-0">
                        <div className="font-mono text-xs text-muted-foreground">
                          {variant?.sku ?? il.variantId}
                        </div>
                        <div className="font-medium">{il.description}</div>
                        {variant ? (
                          <div className="text-xs text-muted-foreground">
                            {variant.productName}
                            {variant.variantName
                              ? ` · ${variant.variantName}`
                              : ''}
                          </div>
                        ) : null}
                        <div className="mt-1 text-[11px] text-muted-foreground">
                          Invoiced {formatQty(il.qty)} ·{' '}
                          Already returned {formatQty(il.qtyReturned)} ·{' '}
                          Remaining{' '}
                          <span
                            className={
                              fullyReturned
                                ? ''
                                : 'font-medium text-foreground'
                            }
                          >
                            {formatQty(String(remaining))}
                          </span>{' '}
                          @ {formatCurrency(il.unitPrice)}
                        </div>
                      </div>
                      <div className="col-span-12 md:col-span-3">
                        <Field>
                          <FieldLabel htmlFor={`lines.${idx}.qty`}>
                            Qty to return
                          </FieldLabel>
                          <Input
                            id={`lines.${idx}.qty`}
                            inputMode="decimal"
                            disabled={!row?.selected || fullyReturned}
                            aria-invalid={!!rowError}
                            {...register(`lines.${idx}.qty`)}
                          />
                          <FieldError errors={[rowError]} />
                        </Field>
                      </div>
                      <div className="col-span-12 md:col-span-2 flex items-end justify-end">
                        <div className="text-right text-xs">
                          <div className="text-muted-foreground">
                            Line value
                          </div>
                          <div className="tabular-nums font-medium">
                            {row?.selected && row.qty && !isNaN(Number(row.qty))
                              ? formatCurrency(
                                  (
                                    Number(row.qty) * Number(il.unitPrice)
                                  ).toFixed(2),
                                )
                              : '—'}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
              {linesError ? (
                <p className="text-xs text-destructive">{linesError}</p>
              ) : null}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Return details</CardTitle>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="returnType">Return type</FieldLabel>
              <Controller
                control={control}
                name="returnType"
                render={({ field }) => (
                  <Select
                    value={field.value}
                    onValueChange={(v) =>
                      field.onChange((v as 'STANDARD' | 'RETURNLESS'))
                    }
                  >
                    <SelectTrigger id="returnType" className="w-full md:w-72">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="STANDARD">
                        Standard — goods returning
                      </SelectItem>
                      <SelectItem value="RETURNLESS">
                        Returnless — damaged / not worth shipping back
                      </SelectItem>
                    </SelectContent>
                  </Select>
                )}
              />
              <p className="text-[10px] text-muted-foreground">
                Standard: Approved → In Transit → Received → Inspected →
                Credited. Returnless skips In Transit and goes Approved →
                Received → Inspected → Credited.
              </p>
            </Field>

            <Field>
              <FieldLabel htmlFor="reason">Reason</FieldLabel>
              <Textarea
                id="reason"
                rows={2}
                placeholder="e.g. damaged in shipping, wrong items sent"
                aria-invalid={!!errors.reason}
                {...register('reason')}
              />
              <FieldError errors={[errors.reason]} />
            </Field>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="restockingFeePercent">
                  Restocking fee % (optional)
                </FieldLabel>
                <Input
                  id="restockingFeePercent"
                  inputMode="decimal"
                  placeholder={
                    restockingFeeDefault.percent ?? '—'
                  }
                  {...register('restockingFeePercent')}
                />
                <FieldError errors={[errors.restockingFeePercent]} />
              </Field>
              <Field>
                <FieldLabel htmlFor="restockingFeeFlat">
                  Restocking fee $ (optional)
                </FieldLabel>
                <Input
                  id="restockingFeeFlat"
                  inputMode="decimal"
                  placeholder={
                    restockingFeeDefault.flat ?? '—'
                  }
                  {...register('restockingFeeFlat')}
                />
                <FieldError errors={[errors.restockingFeeFlat]} />
                <p className="text-[10px] text-muted-foreground">
                  Set % OR $, not both. Leave blank to inherit the admin
                  default at credit time.
                </p>
              </Field>
            </div>
          </FieldGroup>
        </CardContent>
      </Card>

      <div className="flex items-center justify-end gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={pending}
          render={<Link href="/rmas" />}
        >
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? 'Saving…' : 'Create RMA'}
        </Button>
      </div>
    </form>
  );
}

function formatInvoiceDate(iso: string): string {
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

function formatQty(qty: string): string {
  if (!qty.includes('.')) return qty;
  return qty.replace(/\.?0+$/, '');
}
