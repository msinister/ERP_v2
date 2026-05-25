'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from '@/lib/toast';

import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Field, FieldError, FieldLabel } from '@/components/ui/field';
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  isNonNegativeDecimalInput,
  isPositiveDecimalInput,
  normalizeDecimalForSubmit,
} from '@/lib/decimal-input';

type Variant = { id: string; sku: string; name: string | null };
type Warehouse = { id: string; code: string; name: string };
type BomLineRow = {
  componentVariantSku: string;
  componentProductName: string;
  componentVariantName: string | null;
  qtyRequiredPerUnit: string;
};

export function NewWorkOrderForm({
  product,
  variants,
  warehouses,
  bomLines,
}: {
  product: { id: string; sku: string; name: string; bomLaborCost: string | null };
  variants: Variant[];
  warehouses: Warehouse[];
  bomLines: BomLineRow[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  // Auto-default to the only variant/warehouse when there's one — the
  // common single-warehouse, single-variant case for an Assembled
  // product just needs qty + Build.
  const [variantId, setVariantId] = useState<string>(
    variants.length === 1 ? variants[0].id : '',
  );
  const [warehouseId, setWarehouseId] = useState<string>(
    warehouses.length === 1 ? warehouses[0].id : '',
  );
  const [qtyToBuild, setQtyToBuild] = useState('1');
  const [laborMode, setLaborMode] = useState<'inherit' | 'override'>('inherit');
  const [laborOverride, setLaborOverride] = useState<string>(
    product.bomLaborCost ?? '',
  );
  const [notes, setNotes] = useState('');
  const [errors, setErrors] = useState<Partial<Record<string, string>>>({});

  // Keep the override field in sync with the inherited value when the
  // operator toggles modes.
  useEffect(() => {
    if (laborMode === 'inherit') {
      setLaborOverride(product.bomLaborCost ?? '');
    }
  }, [laborMode, product.bomLaborCost]);

  function submit() {
    const next: Partial<Record<string, string>> = {};
    if (!variantId) next.variantId = 'Pick a variant';
    if (!warehouseId) next.warehouseId = 'Pick a warehouse';
    if (!isPositiveDecimalInput(qtyToBuild.trim())) {
      next.qtyToBuild = 'Must be > 0';
    }
    if (laborMode === 'override' && laborOverride.trim() !== '') {
      if (!isNonNegativeDecimalInput(laborOverride.trim())) {
        next.laborOverride = 'Must be a non-negative number';
      }
    }
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    // laborCost payload:
    //   inherit → omit (service inherits from product.bomLaborCost)
    //   override + blank → null (clear labor)
    //   override + value → normalized decimal
    const laborCost =
      laborMode === 'inherit'
        ? undefined
        : laborOverride.trim() === ''
          ? null
          : normalizeDecimalForSubmit(laborOverride.trim());

    startTransition(async () => {
      try {
        const res = await fetch('/api/work-orders', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            productId: product.id,
            variantId,
            warehouseId,
            qtyToBuild: normalizeDecimalForSubmit(qtyToBuild.trim()),
            ...(laborCost !== undefined ? { laborCost } : {}),
            ...(notes.trim() !== '' ? { notes: notes.trim() } : {}),
          }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
            issues?: Array<{ message?: string }>;
          };
          toast.error(
            body.issues?.[0]?.message ??
              body.error ??
              `Create failed (${res.status})`,
          );
          return;
        }
        const wo = (await res.json()) as { id: string; number: string };
        toast.success(`Created ${wo.number}`);
        router.push(`/work-orders/${wo.id}`);
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
          <CardTitle className="text-sm">Build details</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-12 gap-4">
            <div className="col-span-12 md:col-span-6">
              <Field>
                <FieldLabel htmlFor="variantId">Variant to build</FieldLabel>
                <Select
                  value={variantId}
                  onValueChange={(v) => setVariantId(v ?? '')}
                >
                  <SelectTrigger
                    id="variantId"
                    className="w-full"
                    aria-invalid={!!errors.variantId}
                  >
                    <SelectValue placeholder="Pick a variant…">
                      {(v) => {
                        const x = variants.find((vx) => vx.id === v);
                        if (!x) return null;
                        return (
                          <>
                            <span className="font-mono text-xs text-muted-foreground">
                              {x.sku}
                            </span>{' '}
                            {x.name ?? product.name}
                          </>
                        );
                      }}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {variants.map((v) => (
                      <SelectItem key={v.id} value={v.id}>
                        <span className="font-mono text-xs text-muted-foreground">
                          {v.sku}
                        </span>{' '}
                        {v.name ?? product.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {errors.variantId ? (
                  <FieldError errors={[{ message: errors.variantId }]} />
                ) : null}
              </Field>
            </div>
            <div className="col-span-12 md:col-span-6">
              <Field>
                <FieldLabel htmlFor="warehouseId">Warehouse</FieldLabel>
                <Select
                  value={warehouseId}
                  onValueChange={(v) => setWarehouseId(v ?? '')}
                >
                  <SelectTrigger
                    id="warehouseId"
                    className="w-full"
                    aria-invalid={!!errors.warehouseId}
                  >
                    <SelectValue placeholder="Pick…">
                      {(v) => {
                        const w = warehouses.find((wx) => wx.id === v);
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
            <div className="col-span-6 md:col-span-3">
              <Field>
                <FieldLabel htmlFor="qty">Qty to build</FieldLabel>
                <Input
                  id="qty"
                  inputMode="decimal"
                  value={qtyToBuild}
                  onChange={(e) => setQtyToBuild(e.target.value)}
                  aria-invalid={!!errors.qtyToBuild}
                />
                {errors.qtyToBuild ? (
                  <FieldError errors={[{ message: errors.qtyToBuild }]} />
                ) : null}
              </Field>
            </div>
            <div className="col-span-12 md:col-span-9">
              <Field>
                <FieldLabel>Labor cost per unit</FieldLabel>
                <div className="flex flex-wrap items-end gap-3">
                  <Select
                    value={laborMode}
                    onValueChange={(v) =>
                      setLaborMode((v as 'inherit' | 'override') ?? 'inherit')
                    }
                  >
                    <SelectTrigger className="w-44">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="inherit">
                        Inherit from BOM (
                        {product.bomLaborCost ?? 'no labor'})
                      </SelectItem>
                      <SelectItem value="override">Override</SelectItem>
                    </SelectContent>
                  </Select>
                  {laborMode === 'override' ? (
                    <Input
                      inputMode="decimal"
                      placeholder="0.00 (blank = no labor)"
                      value={laborOverride}
                      onChange={(e) => setLaborOverride(e.target.value)}
                      aria-invalid={!!errors.laborOverride}
                      className="max-w-[10rem]"
                    />
                  ) : null}
                </div>
                {errors.laborOverride ? (
                  <FieldError errors={[{ message: errors.laborOverride }]} />
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Rolled into each finished unit&apos;s FIFO cost. Frozen
                    when you Start the build.
                  </p>
                )}
              </Field>
            </div>
            <div className="col-span-12">
              <Field>
                <FieldLabel htmlFor="notes">Notes (optional)</FieldLabel>
                <Textarea
                  id="notes"
                  rows={2}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />
              </Field>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">BOM snapshot (preview)</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/30 hover:bg-muted/30">
                <TableHead>SKU</TableHead>
                <TableHead>Component</TableHead>
                <TableHead className="text-right">Qty per unit</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {bomLines.map((l, i) => (
                <TableRow key={i}>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {l.componentVariantSku}
                  </TableCell>
                  <TableCell>
                    <div className="font-medium">{l.componentProductName}</div>
                    {l.componentVariantName ? (
                      <div className="text-xs text-muted-foreground">
                        {l.componentVariantName}
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {l.qtyRequiredPerUnit}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <div className="flex items-center justify-end gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={() => router.push(`/products/${product.id}`)}
        >
          Cancel
        </Button>
        <Button size="sm" disabled={pending} onClick={submit}>
          {pending ? 'Creating…' : 'Create work order'}
        </Button>
      </div>
    </div>
  );
}
