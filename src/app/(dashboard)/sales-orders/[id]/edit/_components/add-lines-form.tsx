'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Field,
  FieldError,
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
import { VariantPicker } from '@/components/shared/variant-picker';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatCurrency } from '@/lib/format';
import {
  isNonNegativeDecimalInput,
  isPositiveDecimalInput,
  normalizeDecimalForSubmit,
} from '@/lib/decimal-input';
import { useAutoAppendLine } from '@/lib/forms/useAutoAppendLine';

// =============================================================================
// CONFIRMED-status edit surface — add-only on lines. Existing lines render
// read-only (the brief: "qty/price locked, only adding new lines is allowed").
// Submits to POST /api/sales-orders/[id]/lines via addSalesOrderLines.
// =============================================================================

export type ExistingLineRow = {
  id: string;
  sku: string;
  productName: string;
  variantName: string | null;
  qtyOrdered: string;
  qtyReserved: string;
  unitPrice: string;
};

export type AddLinesVariant = {
  id: string;
  sku: string;
  productName: string;
  variantName: string | null;
  shortDescription: string | null;
  basePrice: string | null;
};

type DraftLine = {
  // Local-only key so React can stably render rows as the operator
  // adds / removes drafts.
  key: string;
  variantId: string;
  qtyOrdered: string;
  manualUnitPrice: string;
  customerNote: string;
};

function emptyDraft(): DraftLine {
  return {
    key:
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    variantId: '',
    qtyOrdered: '1',
    manualUnitPrice: '',
    customerNote: '',
  };
}

type CreditErrorBody = {
  code: 'CREDIT_LIMIT_EXCEEDED';
  error: string;
  creditLimit: string;
  arBalance: string;
  openSosTotal: string;
  thisOrderTotal: string;
  projectedExposure: string;
};

type ArHoldErrorBody = {
  code: 'AR_HOLD_EXCEEDED';
  error: string;
  arHoldDays: number;
  worstInvoiceNumber: string;
  worstInvoiceDaysPastDue: number;
};

type Block = CreditErrorBody | ArHoldErrorBody | null;

export function AddLinesForm({
  salesOrderId,
  salesOrderNumber,
  warehouseId,
  warehouseCode,
  existingLines,
  variants,
}: {
  salesOrderId: string;
  salesOrderNumber: string;
  warehouseId: string;
  warehouseCode: string;
  existingLines: ExistingLineRow[];
  variants: AddLinesVariant[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [drafts, setDrafts] = useState<DraftLine[]>([emptyDraft()]);
  const [errors, setErrors] = useState<
    Array<Partial<Record<keyof DraftLine, string>>>
  >([]);
  const [block, setBlock] = useState<Block>(null);

  // Fill the variant on the last draft → a fresh blank draft appears.
  useAutoAppendLine(
    drafts[drafts.length - 1]?.variantId,
    () => setDrafts((ds) => [...ds, emptyDraft()]),
  );

  function patch(key: string, patch: Partial<DraftLine>) {
    setDrafts((ds) => ds.map((d) => (d.key === key ? { ...d, ...patch } : d)));
  }
  // Bulk-add: typical orders here run 20+ lines; adding one row per
  // click is too slow. Ten blanks per click means most orders fit in
  // a click or two and the operator can still ignore the extras.
  function add() {
    setDrafts((ds) => [
      ...ds,
      ...Array.from({ length: 10 }, emptyDraft),
    ]);
  }
  function remove(key: string) {
    setDrafts((ds) => ds.filter((d) => d.key !== key));
  }

  function submit() {
    setBlock(null);
    // Local validation — give the operator a focused error before the
    // server round-trip. The server is still the source of truth.
    // Drop fully-blank drafts (e.g. the auto-appended trailing line) — they
    // aren't validated or submitted.
    const filled = drafts.filter((d) => d.variantId.trim() !== '');
    const nextErrors: Array<Partial<Record<keyof DraftLine, string>>> = drafts.map(
      () => ({}),
    );
    let hasError = false;
    drafts.forEach((d, i) => {
      if (!d.variantId.trim()) return;
      if (!isPositiveDecimalInput(d.qtyOrdered.trim())) {
        nextErrors[i].qtyOrdered = 'Must be > 0';
        hasError = true;
      }
      const priceRaw = d.manualUnitPrice.trim();
      if (priceRaw !== '' && !isNonNegativeDecimalInput(priceRaw)) {
        nextErrors[i].manualUnitPrice = 'Must be a non-negative number';
        hasError = true;
      }
    });
    setErrors(nextErrors);
    if (hasError) return;
    if (filled.length === 0) {
      toast.error('Add at least one line with a product');
      return;
    }

    startTransition(async () => {
      try {
        // Normalize loose-form input (".25" → "0.25") so the server's
        // strict decimalString validator accepts what the operator typed.
        const payload = {
          lines: filled.map((d) => ({
            variantId: d.variantId,
            // Pin every new line to the SO's warehouse. Multi-warehouse
            // SOs aren't supported in pilot — addSalesOrderLines's schema
            // expects per-line warehouseId for forward-compat.
            warehouseId,
            qtyOrdered: normalizeDecimalForSubmit(d.qtyOrdered.trim()),
            ...(d.manualUnitPrice.trim() !== ''
              ? {
                  manualUnitPrice: normalizeDecimalForSubmit(
                    d.manualUnitPrice.trim(),
                  ),
                }
              : {}),
            ...(d.customerNote.trim() !== ''
              ? { customerNote: d.customerNote.trim() }
              : {}),
          })),
        };
        const res = await fetch(
          `/api/sales-orders/${salesOrderId}/lines`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          },
        );
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            code?: string;
            error?: string;
          } & Record<string, unknown>;
          if (
            body.code === 'CREDIT_LIMIT_EXCEEDED' ||
            body.code === 'AR_HOLD_EXCEEDED'
          ) {
            setBlock(body as unknown as Block);
            return;
          }
          toast.error(body.error ?? `Failed to add lines (${res.status})`);
          return;
        }
        toast.success(
          `Line${drafts.length === 1 ? '' : 's'} added to ${salesOrderNumber}. ` +
            'Reprint pick sheet if needed.',
        );
        router.push(`/sales-orders/${salesOrderId}`);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Network error');
      }
    });
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Existing lines (read-only)</CardTitle>
        </CardHeader>
        <CardContent>
          {existingLines.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No existing lines on this order.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/30 hover:bg-muted/30">
                  <TableHead>SKU</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead className="text-right">Unit price</TableHead>
                  <TableHead className="text-right">Line total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {existingLines.map((l) => (
                  <TableRow key={l.id}>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {l.sku}
                    </TableCell>
                    <TableCell>
                      <div className="font-medium">{l.productName}</div>
                      {l.variantName ? (
                        <div className="text-xs text-muted-foreground">
                          {l.variantName}
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {l.qtyOrdered}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatCurrency(l.unitPrice)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums font-medium">
                      {formatCurrency(
                        (Number(l.qtyOrdered) * Number(l.unitPrice)).toFixed(2),
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Add lines</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {drafts.map((d, i) => (
              <DraftRow
                key={d.key}
                draft={d}
                errors={errors[i] ?? {}}
                variants={variants}
                warehouseCode={warehouseCode}
                onChange={(p) => patch(d.key, p)}
                onRemove={drafts.length > 1 ? () => remove(d.key) : null}
              />
            ))}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={add}
            >
              <Plus />
              Add 10 more
            </Button>
          </div>
        </CardContent>
      </Card>

      {block ? <CreditOrArHoldBlock block={block} /> : null}

      <div className="flex items-center justify-end gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={() => router.push(`/sales-orders/${salesOrderId}`)}
        >
          Cancel
        </Button>
        <Button size="sm" disabled={pending} onClick={submit}>
          {pending
            ? 'Saving…'
            : `Add ${drafts.length} line${drafts.length === 1 ? '' : 's'}`}
        </Button>
      </div>
    </div>
  );
}

function DraftRow({
  draft,
  errors,
  variants,
  warehouseCode,
  onChange,
  onRemove,
}: {
  draft: DraftLine;
  errors: Partial<Record<keyof DraftLine, string>>;
  variants: AddLinesVariant[];
  warehouseCode: string;
  onChange: (patch: Partial<DraftLine>) => void;
  onRemove: (() => void) | null;
}) {
  return (
    <div className="rounded-md border border-border p-3">
      <div className="grid grid-cols-12 gap-3">
        <div className="col-span-12 md:col-span-5">
          <Field>
            <FieldLabel htmlFor={`variant-${draft.key}`}>Variant</FieldLabel>
            <VariantPicker
              id={`variant-${draft.key}`}
              value={draft.variantId || null}
              onValueChange={(v) => onChange({ variantId: v ?? '' })}
              variants={variants}
              ariaInvalid={!!errors.variantId}
              placeholder="Pick a product…"
              emptyMessage={
                variants.length === 0
                  ? 'No active variants.'
                  : 'No matching products.'
              }
            />
            {errors.variantId ? (
              <FieldError errors={[{ message: errors.variantId }]} />
            ) : null}
            <p className="text-xs text-muted-foreground">
              Ships from <span className="font-mono">{warehouseCode}</span>.
            </p>
          </Field>
        </div>
        <div className="col-span-4 md:col-span-2">
          <Field>
            <FieldLabel htmlFor={`qty-${draft.key}`}>Qty</FieldLabel>
            <Input
              id={`qty-${draft.key}`}
              inputMode="decimal"
              value={draft.qtyOrdered}
              onChange={(e) => onChange({ qtyOrdered: e.target.value })}
              aria-invalid={!!errors.qtyOrdered}
            />
            {errors.qtyOrdered ? (
              <FieldError errors={[{ message: errors.qtyOrdered }]} />
            ) : null}
          </Field>
        </div>
        <div className="col-span-8 md:col-span-3">
          <Field>
            <FieldLabel htmlFor={`price-${draft.key}`}>
              Unit price override
            </FieldLabel>
            <Input
              id={`price-${draft.key}`}
              inputMode="decimal"
              placeholder="0.00"
              value={draft.manualUnitPrice}
              onChange={(e) => onChange({ manualUnitPrice: e.target.value })}
              aria-invalid={!!errors.manualUnitPrice}
            />
            {errors.manualUnitPrice ? (
              <FieldError errors={[{ message: errors.manualUnitPrice }]} />
            ) : (
              <p className="text-xs text-muted-foreground">
                Blank = resolver-derived price (customer-specific / tier / base).
              </p>
            )}
          </Field>
        </div>
        <div className="col-span-12 md:col-span-2 flex items-end justify-end">
          {onRemove ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Remove draft line"
              onClick={onRemove}
            >
              <Trash2 />
            </Button>
          ) : null}
        </div>
        <div className="col-span-12">
          <Field>
            <FieldLabel htmlFor={`note-${draft.key}`}>
              Customer note (optional)
            </FieldLabel>
            <Input
              id={`note-${draft.key}`}
              value={draft.customerNote}
              onChange={(e) => onChange({ customerNote: e.target.value })}
              placeholder="Shown on the invoice."
            />
          </Field>
        </div>
      </div>
    </div>
  );
}

function CreditOrArHoldBlock({ block }: { block: NonNullable<Block> }) {
  if (block.code === 'CREDIT_LIMIT_EXCEEDED') {
    return (
      <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs">
        <div className="mb-1 font-medium text-destructive">
          Credit limit exceeded
        </div>
        <p className="text-muted-foreground">
          Projected exposure {formatCurrency(block.projectedExposure)} &gt;
          limit {formatCurrency(block.creditLimit)}. AR{' '}
          {formatCurrency(block.arBalance)} + open SOs{' '}
          {formatCurrency(block.openSosTotal)} + this order{' '}
          {formatCurrency(block.thisOrderTotal)}.
        </p>
      </div>
    );
  }
  return (
    <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs">
      <div className="mb-1 font-medium text-destructive">AR hold</div>
      <p className="text-muted-foreground">
        Invoice{' '}
        <span className="font-mono text-foreground">
          {block.worstInvoiceNumber}
        </span>{' '}
        is {block.worstInvoiceDaysPastDue} days past due (threshold{' '}
        {block.arHoldDays} days).
      </p>
    </div>
  );
}
