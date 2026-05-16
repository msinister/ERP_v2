'use client';

import { useMemo, useState, useTransition } from 'react';
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
import { Textarea } from '@/components/ui/textarea';
import { formatCurrency } from '@/lib/format';
import {
  isNonNegativeDecimalInput,
  isPositiveDecimalInput,
  normalizeDecimalForSubmit,
} from '@/lib/decimal-input';

// =============================================================================
// BOM (Bill of Materials) tab — visible on SIMPLE and ASSEMBLED
// products. The BOM is a template: it lists the component variants and
// per-build quantities required to produce one finished unit, plus an
// optional flat-dollar labor cost rolled into every build.
//
// Read state: table of components + summary row showing labor + a
// "ready-to-build" hint. Edit state: same draft-rows pattern as the
// add-lines forms (10 blank rows per click, variant select + qty +
// notes). Wholesale-replace on save via PUT /api/products/[id]/bom.
//
// Non-buildable types (DROP_SHIP / SERVICE) get a soft notice instead
// of the editor — the page-level wrapper hides the tab entirely on
// those types, so this fallback is defensive only.
// =============================================================================

export type BomComponentOption = {
  variantId: string;
  variantSku: string;
  variantName: string | null;
  productName: string;
  productSku: string;
};

export type BomTabExistingLine = {
  id: string;
  componentVariantId: string;
  qtyRequired: string;
  sortOrder: number;
  notes: string | null;
  // Pre-joined display fields so the read view doesn't need a second
  // lookup against the variant catalog.
  componentVariantSku: string;
  componentVariantName: string | null;
  componentProductName: string;
};

type DraftLine = {
  key: string;
  componentVariantId: string;
  qtyRequired: string;
  notes: string;
};

function emptyDraft(): DraftLine {
  return {
    key:
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    componentVariantId: '',
    qtyRequired: '1',
    notes: '',
  };
}

export function BomTab({
  productId,
  productType,
  laborCost,
  existingLines,
  componentOptions,
}: {
  productId: string;
  productType: string;
  laborCost: string | null;
  existingLines: BomTabExistingLine[];
  componentOptions: BomComponentOption[];
}) {
  if (productType !== 'SIMPLE' && productType !== 'ASSEMBLED') {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">BOM not applicable</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Bills of materials are only supported on Simple and Assembled
            products. To build assemblies from this product, change its
            type on the Overview tab.
          </p>
        </CardContent>
      </Card>
    );
  }
  return (
    <BomEditor
      productId={productId}
      laborCost={laborCost}
      existingLines={existingLines}
      componentOptions={componentOptions}
    />
  );
}

function BomEditor({
  productId,
  laborCost: initialLaborCost,
  existingLines,
  componentOptions,
}: {
  productId: string;
  laborCost: string | null;
  existingLines: BomTabExistingLine[];
  componentOptions: BomComponentOption[];
}) {
  const router = useRouter();
  const [mode, setMode] = useState<'view' | 'edit'>('view');
  const [pending, startTransition] = useTransition();

  // Edit-mode state. Initialized from the existing lines when the
  // operator enters edit; ".5" / ".25" friendly via the shared decimal
  // helpers.
  const [drafts, setDrafts] = useState<DraftLine[]>([]);
  const [laborCost, setLaborCost] = useState<string>(initialLaborCost ?? '');
  const [errors, setErrors] = useState<
    Array<Partial<Record<keyof DraftLine, string>>>
  >([]);
  const [laborError, setLaborError] = useState<string | null>(null);

  function enterEdit() {
    setMode('edit');
    setLaborCost(initialLaborCost ?? '');
    setLaborError(null);
    setErrors([]);
    if (existingLines.length === 0) {
      setDrafts([emptyDraft()]);
    } else {
      setDrafts(
        existingLines.map((l) => ({
          key: l.id,
          componentVariantId: l.componentVariantId,
          qtyRequired: l.qtyRequired,
          notes: l.notes ?? '',
        })),
      );
    }
  }

  function cancelEdit() {
    setMode('view');
    setDrafts([]);
    setErrors([]);
    setLaborError(null);
  }

  function patch(key: string, partial: Partial<DraftLine>) {
    setDrafts((ds) =>
      ds.map((d) => (d.key === key ? { ...d, ...partial } : d)),
    );
  }
  function add() {
    setDrafts((ds) => [...ds, ...Array.from({ length: 10 }, emptyDraft)]);
  }
  function remove(key: string) {
    setDrafts((ds) => ds.filter((d) => d.key !== key));
  }

  function submit() {
    // Drop blank draft rows so the operator can leave the extras alone.
    const filled = drafts.filter(
      (d) =>
        d.componentVariantId.trim() !== '' ||
        d.qtyRequired.trim() !== '1' ||
        d.notes.trim() !== '',
    );
    const nextErrors: Array<Partial<Record<keyof DraftLine, string>>> =
      drafts.map(() => ({}));
    let hasError = false;
    drafts.forEach((d, i) => {
      if (!filled.includes(d)) return;
      if (!d.componentVariantId.trim()) {
        nextErrors[i].componentVariantId = 'Pick a component';
        hasError = true;
      }
      if (!isPositiveDecimalInput(d.qtyRequired.trim())) {
        nextErrors[i].qtyRequired = 'Must be > 0';
        hasError = true;
      }
    });
    setErrors(nextErrors);

    let laborErr: string | null = null;
    if (laborCost.trim() !== '' && !isNonNegativeDecimalInput(laborCost.trim())) {
      laborErr = 'Must be a non-negative number';
    }
    setLaborError(laborErr);
    if (hasError || laborErr) return;

    startTransition(async () => {
      try {
        const payload = {
          lines: filled.map((d, i) => ({
            componentVariantId: d.componentVariantId,
            qtyRequired: normalizeDecimalForSubmit(d.qtyRequired.trim()),
            sortOrder: i,
            ...(d.notes.trim() !== '' ? { notes: d.notes.trim() } : {}),
          })),
          laborCost:
            laborCost.trim() === ''
              ? null
              : normalizeDecimalForSubmit(laborCost.trim()),
        };
        const res = await fetch(`/api/products/${productId}/bom`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
            issues?: Array<{ message?: string }>;
          };
          const message =
            body.issues?.[0]?.message ??
            body.error ??
            `Save failed (${res.status})`;
          toast.error(message);
          return;
        }
        toast.success('BOM saved');
        setMode('view');
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Network error');
      }
    });
  }

  if (mode === 'view') {
    return (
      <BomReadView
        laborCost={initialLaborCost}
        existingLines={existingLines}
        onEdit={enterEdit}
      />
    );
  }
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Components</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {drafts.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No components. Click &ldquo;Add 10 more&rdquo; to start
                adding lines.
              </p>
            ) : (
              drafts.map((d, i) => (
                <DraftRow
                  key={d.key}
                  draft={d}
                  errors={errors[i] ?? {}}
                  componentOptions={componentOptions}
                  onChange={(p) => patch(d.key, p)}
                  onRemove={drafts.length > 1 ? () => remove(d.key) : null}
                />
              ))
            )}
            <Button type="button" variant="outline" size="sm" onClick={add}>
              <Plus />
              Add 10 more
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Labor cost per build</CardTitle>
        </CardHeader>
        <CardContent>
          <Field>
            <FieldLabel htmlFor="bom-labor">
              Flat $ added to each finished unit (optional)
            </FieldLabel>
            <Input
              id="bom-labor"
              inputMode="decimal"
              placeholder="0.00"
              value={laborCost}
              onChange={(e) => setLaborCost(e.target.value)}
              aria-invalid={!!laborError}
              className="max-w-[12rem]"
            />
            {laborError ? (
              <FieldError errors={[{ message: laborError }]} />
            ) : (
              <p className="text-xs text-muted-foreground">
                Leave blank for no labor charge. Rolled into the FIFO cost
                of every built unit.
              </p>
            )}
          </Field>
        </CardContent>
      </Card>

      <div className="flex items-center justify-end gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={cancelEdit}
        >
          Cancel
        </Button>
        <Button size="sm" disabled={pending} onClick={submit}>
          {pending ? 'Saving…' : 'Save BOM'}
        </Button>
      </div>
    </div>
  );
}

function BomReadView({
  laborCost,
  existingLines,
  onEdit,
}: {
  laborCost: string | null;
  existingLines: BomTabExistingLine[];
  onEdit: () => void;
}) {
  const totalComponents = existingLines.length;
  // Highlight duplicate component variants in the read view — the
  // schema allows them but it's almost always a typo worth noticing.
  const dupeIds = useMemo(() => {
    const seen = new Set<string>();
    const dupes = new Set<string>();
    for (const l of existingLines) {
      if (seen.has(l.componentVariantId)) dupes.add(l.componentVariantId);
      seen.add(l.componentVariantId);
    }
    return dupes;
  }, [existingLines]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {totalComponents === 0
            ? 'No components defined. Add components and a labor cost to enable builds.'
            : `${totalComponents} component${totalComponents === 1 ? '' : 's'} per finished unit${
                laborCost != null
                  ? ` · labor ${formatCurrency(laborCost)} / build`
                  : ''
              }`}
        </p>
        <Button size="sm" onClick={onEdit}>
          Edit BOM
        </Button>
      </div>
      {totalComponents === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-12 text-center text-sm text-muted-foreground">
          No components on this BOM.
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/30 hover:bg-muted/30">
                <TableHead>Component SKU</TableHead>
                <TableHead>Description</TableHead>
                <TableHead className="text-right">Qty per build</TableHead>
                <TableHead>Notes</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {existingLines.map((l) => (
                <TableRow key={l.id}>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {l.componentVariantSku}
                    {dupeIds.has(l.componentVariantId) ? (
                      <span className="ml-1 text-[10px] uppercase tracking-wide text-amber-600 dark:text-amber-500">
                        dup
                      </span>
                    ) : null}
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
                    {formatQtyDisplay(l.qtyRequired)}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {l.notes ? `“${l.notes}”` : '—'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

function DraftRow({
  draft,
  errors,
  componentOptions,
  onChange,
  onRemove,
}: {
  draft: DraftLine;
  errors: Partial<Record<keyof DraftLine, string>>;
  componentOptions: BomComponentOption[];
  onChange: (patch: Partial<DraftLine>) => void;
  onRemove: (() => void) | null;
}) {
  return (
    <div className="rounded-md border border-border p-3">
      <div className="grid grid-cols-12 gap-3">
        <div className="col-span-12 md:col-span-7">
          <Field>
            <FieldLabel htmlFor={`comp-${draft.key}`}>Component</FieldLabel>
            <Select
              value={draft.componentVariantId}
              onValueChange={(v) => onChange({ componentVariantId: v ?? '' })}
            >
              <SelectTrigger
                id={`comp-${draft.key}`}
                className="w-full"
                aria-invalid={!!errors.componentVariantId}
              >
                <SelectValue placeholder="Pick a component…">
                  {(v) => {
                    if (!v) return null;
                    const opt = componentOptions.find((x) => x.variantId === v);
                    if (!opt) return v;
                    return (
                      <>
                        <span className="font-mono text-xs text-muted-foreground">
                          {opt.variantSku}
                        </span>{' '}
                        {opt.productName}
                        {opt.variantName ? ` — ${opt.variantName}` : ''}
                      </>
                    );
                  }}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {componentOptions.length === 0 ? (
                  <div className="px-2 py-1.5 text-xs text-muted-foreground">
                    No active variants available.
                  </div>
                ) : (
                  componentOptions.map((opt) => (
                    <SelectItem key={opt.variantId} value={opt.variantId}>
                      <span className="font-mono text-xs text-muted-foreground">
                        {opt.variantSku}
                      </span>{' '}
                      {opt.productName}
                      {opt.variantName ? ` — ${opt.variantName}` : ''}
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
            {errors.componentVariantId ? (
              <FieldError errors={[{ message: errors.componentVariantId }]} />
            ) : null}
          </Field>
        </div>
        <div className="col-span-6 md:col-span-3">
          <Field>
            <FieldLabel htmlFor={`qty-${draft.key}`}>
              Qty per build
            </FieldLabel>
            <Input
              id={`qty-${draft.key}`}
              inputMode="decimal"
              value={draft.qtyRequired}
              onChange={(e) => onChange({ qtyRequired: e.target.value })}
              aria-invalid={!!errors.qtyRequired}
            />
            {errors.qtyRequired ? (
              <FieldError errors={[{ message: errors.qtyRequired }]} />
            ) : null}
          </Field>
        </div>
        <div className="col-span-6 md:col-span-2 flex items-end justify-end">
          {onRemove ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Remove component"
              onClick={onRemove}
            >
              <Trash2 />
            </Button>
          ) : null}
        </div>
        <div className="col-span-12">
          <Field>
            <FieldLabel htmlFor={`note-${draft.key}`}>
              Note (optional)
            </FieldLabel>
            <Textarea
              id={`note-${draft.key}`}
              rows={2}
              value={draft.notes}
              onChange={(e) => onChange({ notes: e.target.value })}
              placeholder="e.g. step 3 — install after cap"
            />
          </Field>
        </div>
      </div>
    </div>
  );
}

function formatQtyDisplay(qty: string): string {
  // Strip trailing zeros for clean display (parallels the existing
  // formatQty used on PO/SO line tables).
  if (!qty.includes('.')) return qty;
  return qty.replace(/\.?0+$/, '');
}
