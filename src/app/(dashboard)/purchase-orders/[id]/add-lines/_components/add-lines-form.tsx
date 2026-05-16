'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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

// =============================================================================
// PO add-lines form. Mirrors the SO add-lines pattern at
// /sales-orders/[id]/edit/_components/add-lines-form.tsx, with the
// purchasing-side differences:
//   - Unit cost is required, not optional. PO lines have no pricing
//     resolver — operator types the cost directly.
//   - No discount fields. POs price at unit cost; vendor credits cover
//     adjustments after the fact.
//   - Adds vendor SKU + MPN + line notes for vendor-side metadata.
//   - No credit-limit / AR-hold gates. POs don't reserve inventory.
// Submits to POST /api/purchase-orders/[id]/lines.
// =============================================================================

export type ExistingPoLineRow = {
  id: string;
  sku: string;
  productName: string;
  variantName: string | null;
  warehouseCode: string;
  qtyOrdered: string;
  qtyReceived: string;
  unitCost: string;
};

export type AddPoLinesVariant = {
  id: string;
  sku: string;
  productName: string;
  variantName: string | null;
};

export type AddPoLinesWarehouse = {
  id: string;
  code: string;
  name: string;
};

type DraftLine = {
  key: string;
  variantId: string;
  warehouseId: string;
  qtyOrdered: string;
  unitCost: string;
  vendorSku: string;
  manufacturerPartNumber: string;
  notes: string;
};

function emptyDraft(defaultWarehouseId: string): DraftLine {
  return {
    key:
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    variantId: '',
    warehouseId: defaultWarehouseId,
    qtyOrdered: '1',
    unitCost: '',
    vendorSku: '',
    manufacturerPartNumber: '',
    notes: '',
  };
}

export function AddLinesForm({
  purchaseOrderId,
  purchaseOrderNumber,
  defaultWarehouseId,
  existingLines,
  variants,
  warehouses,
  currency,
}: {
  purchaseOrderId: string;
  purchaseOrderNumber: string;
  defaultWarehouseId: string;
  existingLines: ExistingPoLineRow[];
  variants: AddPoLinesVariant[];
  warehouses: AddPoLinesWarehouse[];
  currency: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [drafts, setDrafts] = useState<DraftLine[]>([
    emptyDraft(defaultWarehouseId),
  ]);
  const [errors, setErrors] = useState<
    Array<Partial<Record<keyof DraftLine, string>>>
  >([]);

  function patch(key: string, partial: Partial<DraftLine>) {
    setDrafts((ds) =>
      ds.map((d) => (d.key === key ? { ...d, ...partial } : d)),
    );
  }
  // 10 blank rows per click — matches the SO pattern.
  function add() {
    setDrafts((ds) => [
      ...ds,
      ...Array.from({ length: 10 }, () => emptyDraft(defaultWarehouseId)),
    ]);
  }
  function remove(key: string) {
    setDrafts((ds) => ds.filter((d) => d.key !== key));
  }

  function submit() {
    // Drop blank draft rows so the operator can leave the extras
    // alone — only real rows go to the server.
    const filled = drafts.filter(
      (d) =>
        d.variantId.trim() !== '' ||
        d.qtyOrdered.trim() !== '1' ||
        d.unitCost.trim() !== '' ||
        d.vendorSku.trim() !== '' ||
        d.manufacturerPartNumber.trim() !== '' ||
        d.notes.trim() !== '',
    );
    if (filled.length === 0) {
      toast.error('Add at least one line');
      return;
    }

    const nextErrors: Array<Partial<Record<keyof DraftLine, string>>> =
      drafts.map(() => ({}));
    let hasError = false;
    drafts.forEach((d, i) => {
      // Skip empty (default) drafts — only validate the filled ones.
      const isFilled = filled.includes(d);
      if (!isFilled) return;
      if (!d.variantId.trim()) {
        nextErrors[i].variantId = 'Pick a product';
        hasError = true;
      }
      if (!d.warehouseId.trim()) {
        nextErrors[i].warehouseId = 'Pick a warehouse';
        hasError = true;
      }
      if (!isPositiveDecimalInput(d.qtyOrdered.trim())) {
        nextErrors[i].qtyOrdered = 'Must be > 0';
        hasError = true;
      }
      if (!isNonNegativeDecimalInput(d.unitCost.trim())) {
        nextErrors[i].unitCost = 'Must be a non-negative number';
        hasError = true;
      }
    });
    setErrors(nextErrors);
    if (hasError) return;

    startTransition(async () => {
      try {
        // Normalize loose-form input (".25" → "0.25") so the server's
        // strict decimalString validator accepts what the operator typed.
        const payload = {
          lines: filled.map((d) => ({
            variantId: d.variantId,
            warehouseId: d.warehouseId,
            qtyOrdered: normalizeDecimalForSubmit(d.qtyOrdered.trim()),
            unitCost: normalizeDecimalForSubmit(d.unitCost.trim()),
            ...(d.vendorSku.trim() !== ''
              ? { vendorSku: d.vendorSku.trim() }
              : {}),
            ...(d.manufacturerPartNumber.trim() !== ''
              ? { manufacturerPartNumber: d.manufacturerPartNumber.trim() }
              : {}),
            ...(d.notes.trim() !== '' ? { notes: d.notes.trim() } : {}),
          })),
        };
        const res = await fetch(
          `/api/purchase-orders/${purchaseOrderId}/lines`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          },
        );
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
            issues?: Array<{ message?: string }>;
          };
          const message =
            body.issues?.[0]?.message ??
            body.error ??
            `Failed to add lines (${res.status})`;
          toast.error(message);
          return;
        }
        toast.success(
          `Line${filled.length === 1 ? '' : 's'} added to ${purchaseOrderNumber}.`,
        );
        router.push(`/purchase-orders/${purchaseOrderId}`);
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
              No existing lines on this PO.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/30 hover:bg-muted/30">
                  <TableHead>SKU</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead>Warehouse</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead className="text-right">Unit cost</TableHead>
                  <TableHead className="text-right">Ext.</TableHead>
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
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {l.warehouseCode}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      <div>{stripQtyTrailingZeros(l.qtyOrdered)}</div>
                      {Number(l.qtyReceived) > 0 ? (
                        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                          recv {stripQtyTrailingZeros(l.qtyReceived)}
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatCurrency(l.unitCost)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums font-medium">
                      {formatCurrency(
                        (Number(l.qtyOrdered) * Number(l.unitCost)).toFixed(2),
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
                warehouses={warehouses}
                currency={currency}
                onChange={(p) => patch(d.key, p)}
                onRemove={drafts.length > 1 ? () => remove(d.key) : null}
              />
            ))}
            <Button type="button" variant="outline" size="sm" onClick={add}>
              <Plus />
              Add 10 more
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="flex items-center justify-end gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={() =>
            router.push(`/purchase-orders/${purchaseOrderId}`)
          }
        >
          Cancel
        </Button>
        <Button size="sm" disabled={pending} onClick={submit}>
          {pending ? 'Saving…' : 'Add lines'}
        </Button>
      </div>
    </div>
  );
}

function DraftRow({
  draft,
  errors,
  variants,
  warehouses,
  currency,
  onChange,
  onRemove,
}: {
  draft: DraftLine;
  errors: Partial<Record<keyof DraftLine, string>>;
  variants: AddPoLinesVariant[];
  warehouses: AddPoLinesWarehouse[];
  currency: string;
  onChange: (patch: Partial<DraftLine>) => void;
  onRemove: (() => void) | null;
}) {
  return (
    <div className="rounded-md border border-border p-3">
      <div className="grid grid-cols-12 gap-3">
        <div className="col-span-12 md:col-span-5">
          <Field>
            <FieldLabel htmlFor={`variant-${draft.key}`}>Variant</FieldLabel>
            <Select
              value={draft.variantId}
              onValueChange={(v) => onChange({ variantId: v ?? '' })}
            >
              <SelectTrigger
                id={`variant-${draft.key}`}
                className="w-full"
                aria-invalid={!!errors.variantId}
              >
                <SelectValue placeholder="Pick a product…">
                  {(v) => {
                    if (!v) return null;
                    const variant = variants.find((x) => x.id === v);
                    if (!variant) return v;
                    return (
                      <>
                        <span className="font-mono text-xs text-muted-foreground">
                          {variant.sku}
                        </span>{' '}
                        {variant.productName}
                        {variant.variantName ? ` — ${variant.variantName}` : ''}
                      </>
                    );
                  }}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {variants.length === 0 ? (
                  <div className="px-2 py-1.5 text-xs text-muted-foreground">
                    No active variants.
                  </div>
                ) : (
                  variants.map((v) => (
                    <SelectItem key={v.id} value={v.id}>
                      <span className="font-mono text-xs text-muted-foreground">
                        {v.sku}
                      </span>{' '}
                      {v.productName}
                      {v.variantName ? ` — ${v.variantName}` : ''}
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
            {errors.variantId ? (
              <FieldError errors={[{ message: errors.variantId }]} />
            ) : null}
          </Field>
        </div>
        <div className="col-span-6 md:col-span-3">
          <Field>
            <FieldLabel htmlFor={`warehouse-${draft.key}`}>
              Warehouse
            </FieldLabel>
            <Select
              value={draft.warehouseId}
              onValueChange={(v) => onChange({ warehouseId: v ?? '' })}
            >
              <SelectTrigger
                id={`warehouse-${draft.key}`}
                className="w-full"
                aria-invalid={!!errors.warehouseId}
              >
                <SelectValue placeholder="Pick…">
                  {(v) => {
                    const w = warehouses.find((x) => x.id === v);
                    return w ? (
                      <span className="font-mono text-xs">{w.code}</span>
                    ) : null;
                  }}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {warehouses.map((w) => (
                  <SelectItem key={w.id} value={w.id}>
                    <span className="font-mono text-xs">{w.code}</span>{' '}
                    {w.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {errors.warehouseId ? (
              <FieldError errors={[{ message: errors.warehouseId }]} />
            ) : null}
          </Field>
        </div>
        <div className="col-span-3 md:col-span-2">
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
        <div className="col-span-3 md:col-span-2">
          <Field>
            <FieldLabel htmlFor={`cost-${draft.key}`}>
              Unit cost ({currency})
            </FieldLabel>
            <Input
              id={`cost-${draft.key}`}
              inputMode="decimal"
              placeholder="0.00"
              value={draft.unitCost}
              onChange={(e) => onChange({ unitCost: e.target.value })}
              aria-invalid={!!errors.unitCost}
            />
            {errors.unitCost ? (
              <FieldError errors={[{ message: errors.unitCost }]} />
            ) : null}
          </Field>
        </div>
        <div className="col-span-6 md:col-span-3">
          <Field>
            <FieldLabel htmlFor={`vsku-${draft.key}`}>
              Vendor SKU (optional)
            </FieldLabel>
            <Input
              id={`vsku-${draft.key}`}
              value={draft.vendorSku}
              onChange={(e) => onChange({ vendorSku: e.target.value })}
            />
          </Field>
        </div>
        <div className="col-span-6 md:col-span-3">
          <Field>
            <FieldLabel htmlFor={`mpn-${draft.key}`}>
              Mfr part no. (optional)
            </FieldLabel>
            <Input
              id={`mpn-${draft.key}`}
              value={draft.manufacturerPartNumber}
              onChange={(e) =>
                onChange({ manufacturerPartNumber: e.target.value })
              }
            />
          </Field>
        </div>
        <div className="col-span-12 md:col-span-5">
          <Field>
            <FieldLabel htmlFor={`note-${draft.key}`}>
              Line note (optional)
            </FieldLabel>
            <Input
              id={`note-${draft.key}`}
              value={draft.notes}
              onChange={(e) => onChange({ notes: e.target.value })}
            />
          </Field>
        </div>
        <div className="col-span-12 md:col-span-1 flex items-end justify-end">
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
      </div>
    </div>
  );
}

function stripQtyTrailingZeros(qty: string): string {
  if (!qty.includes('.')) return qty;
  return qty.replace(/\.?0+$/, '');
}
