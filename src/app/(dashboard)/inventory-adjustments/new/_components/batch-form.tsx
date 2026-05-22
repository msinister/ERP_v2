'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  VariantPicker,
  type CreatedProduct,
  type VariantPickerOption,
} from '@/components/shared/variant-picker';
import { useAutoAppendLine } from '@/lib/forms/useAutoAppendLine';
import { CATEGORY_OPTIONS } from '../../_components/categories';

type WarehouseOption = { id: string; code: string; name: string };

type LineState = {
  key: string;
  variantId: string | null;
  qty: string;
  notes: string;
};

const DECIMAL_RE = /^-?(\d+(\.\d+)?|\.\d+)$/;
let keyCounter = 0;
const newLine = (): LineState => ({
  key: `l${keyCounter++}`,
  variantId: null,
  qty: '',
  notes: '',
});

export function BatchAdjustmentForm({
  warehouses,
  variants,
}: {
  warehouses: WarehouseOption[];
  variants: VariantPickerOption[];
}) {
  const router = useRouter();
  const [warehouseId, setWarehouseId] = useState(warehouses[0]?.id ?? '');
  const [category, setCategory] = useState('CYCLE_COUNT');
  const [reason, setReason] = useState('');
  const [internalNotes, setInternalNotes] = useState('');
  const [lines, setLines] = useState<LineState[]>([newLine()]);
  const [pending, setPending] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<string, string>>>({});
  // Shadow the variants prop so an inline-created product appears across
  // all lines, not just the one it was created on.
  const [variantList, setVariantList] = useState(variants);

  function onProductCreated(created: CreatedProduct) {
    setVariantList((prev) =>
      prev.some((v) => v.id === created.variantId)
        ? prev
        : [
            ...prev,
            {
              id: created.variantId,
              sku: created.sku,
              productName: created.productName,
              variantName: created.variantName,
              shortDescription: created.shortDescription,
            },
          ],
    );
  }

  // Pick a variant on the last line → a fresh blank line appears below it.
  useAutoAppendLine(
    lines[lines.length - 1]?.variantId,
    () => setLines((prev) => [...prev, newLine()]),
  );

  function updateLine(key: string, patch: Partial<LineState>) {
    setLines((prev) =>
      prev.map((l) => (l.key === key ? { ...l, ...patch } : l)),
    );
  }
  function addLine() {
    setLines((prev) => [...prev, newLine()]);
  }
  function removeLine(key: string) {
    setLines((prev) =>
      prev.length === 1 ? prev : prev.filter((l) => l.key !== key),
    );
  }

  function submit() {
    const next: Partial<Record<string, string>> = {};
    if (!warehouseId) next.warehouseId = 'Pick a warehouse';
    if (!reason.trim()) next.reason = 'Reason is required';
    const validLines = lines.filter(
      (l) => l.variantId && l.qty.trim() !== '',
    );
    if (validLines.length === 0) {
      next.lines = 'Add at least one line with a variant and quantity';
    }
    for (const l of validLines) {
      if (!DECIMAL_RE.test(l.qty.trim()) || Number(l.qty.trim()) === 0) {
        next.lines = 'Each quantity must be a non-zero number';
        break;
      }
    }
    if (Object.keys(next).length > 0) {
      setErrors(next);
      return;
    }
    setErrors({});
    setPending(true);
    void (async () => {
      try {
        const res = await fetch('/api/inventory-adjustments/batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            warehouseId,
            category,
            reason: reason.trim(),
            internalNotes: internalNotes.trim() || undefined,
            lines: validLines.map((l) => ({
              variantId: l.variantId,
              qtyChange: l.qty.trim(),
              notes: l.notes.trim() || undefined,
            })),
          }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          toast.error(body.error ?? `Post failed (${res.status})`);
          return;
        }
        const adj = (await res.json()) as { id: string; number: string };
        toast.success(`Posted ${adj.number}.`);
        router.push(`/inventory-adjustments/${adj.id}`);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Network error');
      } finally {
        setPending(false);
      }
    })();
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Adjustment</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="batch-warehouse">Warehouse</FieldLabel>
              <Select
                value={warehouseId}
                onValueChange={(v) => setWarehouseId(v ?? '')}
              >
                <SelectTrigger
                  id="batch-warehouse"
                  className="w-full"
                  aria-invalid={!!errors.warehouseId}
                >
                  <SelectValue placeholder="Select…">
                    {(v) => {
                      const w = warehouses.find((x) => x.id === v);
                      return w ? `${w.code} — ${w.name}` : 'Select…';
                    }}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {warehouses.map((w) => (
                    <SelectItem key={w.id} value={w.id}>
                      {w.code} — {w.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldError
                errors={[
                  errors.warehouseId ? { message: errors.warehouseId } : undefined,
                ]}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="batch-category">Category</FieldLabel>
              <Select
                value={category}
                onValueChange={(v) => setCategory(v ?? 'CYCLE_COUNT')}
              >
                <SelectTrigger id="batch-category" className="w-full">
                  <SelectValue>
                    {(v) =>
                      CATEGORY_OPTIONS.find((c) => c.value === v)?.label ?? v
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {CATEGORY_OPTIONS.map((c) => (
                    <SelectItem key={c.value} value={c.value}>
                      {c.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field className="md:col-span-2">
              <FieldLabel htmlFor="batch-reason">Reason</FieldLabel>
              <Input
                id="batch-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. Q2 cycle count"
                aria-invalid={!!errors.reason}
              />
              <FieldError
                errors={[errors.reason ? { message: errors.reason } : undefined]}
              />
            </Field>
            <Field className="md:col-span-2">
              <FieldLabel htmlFor="batch-notes">Internal notes</FieldLabel>
              <Textarea
                id="batch-notes"
                rows={2}
                placeholder="optional"
                value={internalNotes}
                onChange={(e) => setInternalNotes(e.target.value)}
              />
            </Field>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <CardTitle className="text-sm">Lines</CardTitle>
          <Button variant="outline" size="sm" onClick={addLine}>
            <Plus />
            Add line
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {errors.lines ? (
            <p className="text-xs text-destructive">{errors.lines}</p>
          ) : null}
          {lines.map((line) => (
            <div
              key={line.key}
              className="flex flex-col gap-2 rounded-md border border-border p-3 sm:flex-row sm:items-start"
            >
              <div className="min-w-0 flex-1">
                <VariantPicker
                  value={line.variantId}
                  onValueChange={(id) => updateLine(line.key, { variantId: id })}
                  variants={variantList}
                  onCreated={onProductCreated}
                  placeholder="Search SKU or product…"
                />
              </div>
              <Input
                inputMode="decimal"
                placeholder="+/- qty"
                value={line.qty}
                onChange={(e) => updateLine(line.key, { qty: e.target.value })}
                className="w-28"
              />
              <Input
                placeholder="note (optional)"
                value={line.notes}
                onChange={(e) => updateLine(line.key, { notes: e.target.value })}
                className="w-40"
              />
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Remove line"
                disabled={lines.length === 1}
                onClick={() => removeLine(line.key)}
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          ))}
          <p className="text-xs text-muted-foreground">
            Positive quantity adds stock (gain, costed at WAC); negative
            removes (loss, FIFO-costed). Posts immediately on submit.
          </p>
        </CardContent>
      </Card>

      <div className="flex items-center justify-end gap-2">
        <Button
          variant="outline"
          onClick={() => router.push('/inventory-adjustments')}
          disabled={pending}
        >
          Cancel
        </Button>
        <Button onClick={submit} disabled={pending}>
          {pending ? 'Posting…' : 'Post adjustment'}
        </Button>
      </div>
    </div>
  );
}
