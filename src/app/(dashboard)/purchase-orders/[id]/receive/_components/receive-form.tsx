'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { toast } from 'sonner';
import { AlertTriangle } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
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
import { formatCurrency } from '@/lib/format';

export type WarehouseOption = { id: string; code: string; name: string };

export type ReceiveLineSeed = {
  purchaseOrderLineId: string;
  variantId: string;
  sku: string;
  productName: string;
  variantName: string | null;
  warehouseId: string;
  warehouseCode: string;
  qtyOrdered: string;
  qtyAlreadyReceived: string;
  qtyRemaining: string;
  unitCost: string;
  defaultReceive: boolean;
  defaultQty: string;
};

type LineState = {
  receive: boolean;
  qtyReceived: string;
  unitCost: string;
  notes: string;
  // Per-line validation errors, mapped by field name. Cleared on submit
  // retry.
  errors: Partial<Record<'qtyReceived' | 'unitCost', string>>;
};

const POSITIVE_DECIMAL_RE = /^\d+(\.\d+)?$/;

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

export function ReceiveForm({
  purchaseOrderId,
  purchaseOrderNumber,
  vendor,
  warehouses,
  lines,
}: {
  purchaseOrderId: string;
  purchaseOrderNumber: string;
  vendor: { id: string; code: string; name: string };
  warehouses: WarehouseOption[];
  lines: ReceiveLineSeed[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [topLevelError, setTopLevelError] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [warehouseId, setWarehouseId] = useState<string>(
    warehouses[0]?.id ?? '',
  );
  const [lineStates, setLineStates] = useState<Record<string, LineState>>(
    () => {
      const initial: Record<string, LineState> = {};
      for (const l of lines) {
        initial[l.purchaseOrderLineId] = {
          receive: l.defaultReceive,
          qtyReceived: l.defaultQty,
          unitCost: l.unitCost,
          notes: '',
          errors: {},
        };
      }
      return initial;
    },
  );

  // If the operator switches warehouses, auto-uncheck lines from the
  // other warehouses (they can't be received against the chosen one).
  // Re-checking is allowed if remaining > 0, but the line is hidden
  // from the active table so it amounts to skipping it on this receipt.
  useEffect(() => {
    setLineStates((prev) => {
      const next = { ...prev };
      for (const l of lines) {
        if (l.warehouseId !== warehouseId) {
          next[l.purchaseOrderLineId] = {
            ...next[l.purchaseOrderLineId],
            receive: false,
          };
        }
      }
      return next;
    });
  }, [warehouseId, lines]);

  const activeLines = useMemo(
    () => lines.filter((l) => l.warehouseId === warehouseId),
    [lines, warehouseId],
  );
  const skippedLines = useMemo(
    () => lines.filter((l) => l.warehouseId !== warehouseId),
    [lines, warehouseId],
  );

  function updateLine(
    id: string,
    patch: Partial<LineState>,
  ): void {
    setLineStates((prev) => ({
      ...prev,
      [id]: { ...prev[id], ...patch, errors: {} },
    }));
  }

  // Live total preview — sum across checked lines with valid qty/cost.
  // Skip non-numeric values silently so partial input doesn't NaN out.
  const previewTotal = useMemo(() => {
    let t = 0;
    for (const l of activeLines) {
      const s = lineStates[l.purchaseOrderLineId];
      if (!s?.receive) continue;
      const q = Number(s.qtyReceived);
      const c = Number(s.unitCost);
      if (Number.isFinite(q) && Number.isFinite(c)) t += q * c;
    }
    return t;
  }, [activeLines, lineStates]);

  function validateAndBuildPayload(): {
    ok: boolean;
    body?: Record<string, unknown>;
  } {
    setTopLevelError(null);
    if (!warehouseId) {
      setTopLevelError('Pick a warehouse to receive against.');
      return { ok: false };
    }
    const selected: Array<{
      purchaseOrderLineId: string;
      variantId: string;
      warehouseId: string;
      qtyReceived: string;
      unitCost: string;
      notes?: string;
    }> = [];
    const nextStates = { ...lineStates };
    let hasErrors = false;
    for (const l of activeLines) {
      const s = nextStates[l.purchaseOrderLineId];
      if (!s.receive) continue;
      const errs: LineState['errors'] = {};
      if (!POSITIVE_DECIMAL_RE.test(s.qtyReceived))
        errs.qtyReceived = 'Must be a positive number';
      else if (Number(s.qtyReceived) <= 0)
        errs.qtyReceived = 'Must be greater than 0';
      if (!POSITIVE_DECIMAL_RE.test(s.unitCost))
        errs.unitCost = 'Must be a non-negative number';
      if (Object.keys(errs).length > 0) {
        nextStates[l.purchaseOrderLineId] = { ...s, errors: errs };
        hasErrors = true;
        continue;
      }
      selected.push({
        purchaseOrderLineId: l.purchaseOrderLineId,
        variantId: l.variantId,
        warehouseId: l.warehouseId,
        qtyReceived: s.qtyReceived,
        unitCost: s.unitCost,
        notes: s.notes.trim() || undefined,
      });
    }
    if (hasErrors) {
      setLineStates(nextStates);
      return { ok: false };
    }
    if (selected.length === 0) {
      setTopLevelError('Select at least one line to receive.');
      return { ok: false };
    }
    return {
      ok: true,
      body: {
        vendorId: vendor.id,
        warehouseId,
        notes: notes.trim() || undefined,
        lines: selected,
      },
    };
  }

  async function submit() {
    const result = validateAndBuildPayload();
    if (!result.ok || !result.body) return;
    startTransition(async () => {
      try {
        // Two-step flow: create draft → post. The service auto-drafts a
        // vendor bill on post, so the toast surfaces both the receipt
        // and (when over-received) the warning flag separately.
        const draftRes = await fetch('/api/receipts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(result.body),
        });
        if (!draftRes.ok) {
          toast.error(await readApiError(draftRes));
          return;
        }
        const draft = (await draftRes.json()) as {
          id: string;
          number: string;
        };
        const postRes = await fetch(`/api/receipts/${draft.id}/post`, {
          method: 'POST',
        });
        if (!postRes.ok) {
          // Draft was created but post failed. Surface the post error
          // and route to the draft receipt so the operator can fix the
          // issue and retry the post manually.
          const msg = await readApiError(postRes);
          toast.error(`Draft saved as ${draft.number} but post failed: ${msg}`);
          router.push(`/receipts/${draft.id}`);
          router.refresh();
          return;
        }
        const posted = (await postRes.json()) as {
          id: string;
          number: string;
          wasOverReceived?: boolean;
        };
        if (posted.wasOverReceived) {
          toast.warning(
            `Posted ${posted.number} — note: over-received vs ordered.`,
          );
        } else {
          toast.success(`Posted ${posted.number}`);
        }
        router.push(`/receipts/${posted.id}`);
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
          <CardTitle className="text-sm">Receipt header</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="receive-vendor">Vendor</FieldLabel>
              <Input
                id="receive-vendor"
                value={`${vendor.name} (${vendor.code})`}
                readOnly
                disabled
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="receive-warehouse">Warehouse</FieldLabel>
              <Select
                value={warehouseId}
                onValueChange={(v) => setWarehouseId(v ?? '')}
                disabled={warehouses.length === 1}
              >
                <SelectTrigger id="receive-warehouse" className="w-full">
                  <SelectValue placeholder="Pick a warehouse" />
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
              {warehouses.length > 1 ? (
                <p className="text-xs text-muted-foreground">
                  This PO spans multiple warehouses. Receive each warehouse
                  in its own receipt.
                </p>
              ) : null}
            </Field>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Lines</CardTitle>
        </CardHeader>
        <CardContent>
          {activeLines.length === 0 ? (
            <div className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
              No lines for the selected warehouse.
            </div>
          ) : (
            <div className="space-y-3">
              {activeLines.map((l) => (
                <LineRow
                  key={l.purchaseOrderLineId}
                  line={l}
                  state={lineStates[l.purchaseOrderLineId]}
                  onChange={(patch) =>
                    updateLine(l.purchaseOrderLineId, patch)
                  }
                />
              ))}
              <div className="flex justify-end border-t border-border pt-3">
                <div className="text-right">
                  <div className="text-xs text-muted-foreground">
                    Receipt total
                  </div>
                  <div className="text-lg font-semibold tabular-nums">
                    {formatCurrency(previewTotal.toFixed(2))}
                  </div>
                </div>
              </div>
            </div>
          )}
          {skippedLines.length > 0 ? (
            <div className="mt-4 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs">
              <div className="mb-1 flex items-center gap-1.5 font-medium text-foreground">
                <AlertTriangle className="size-3.5 text-amber-600" />
                {skippedLines.length} line
                {skippedLines.length === 1 ? '' : 's'} skipped (other
                warehouses)
              </div>
              <ul className="space-y-0.5 text-muted-foreground">
                {skippedLines.map((l) => (
                  <li key={l.purchaseOrderLineId}>
                    <span className="font-mono">{l.sku}</span> → {l.warehouseCode}
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-muted-foreground">
                Switch warehouse above or come back to receive these on a
                separate receipt.
              </p>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Notes</CardTitle>
        </CardHeader>
        <CardContent>
          <Field>
            <FieldLabel htmlFor="receive-notes">Receipt notes</FieldLabel>
            <Textarea
              id="receive-notes"
              rows={3}
              placeholder="Optional notes for the receiving team."
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </Field>
        </CardContent>
      </Card>

      {topLevelError ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {topLevelError}
        </div>
      ) : null}

      <div className="flex items-center justify-end gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={pending}
          render={<Link href={`/purchase-orders/${purchaseOrderId}`} />}
        >
          Cancel
        </Button>
        <Button onClick={submit} size="sm" disabled={pending}>
          {pending ? 'Posting…' : `Receive & post ${purchaseOrderNumber}`}
        </Button>
      </div>
    </div>
  );
}

function LineRow({
  line,
  state,
  onChange,
}: {
  line: ReceiveLineSeed;
  state: LineState;
  onChange: (patch: Partial<LineState>) => void;
}) {
  // Visual cue when about to over-receive: qtyReceived > qtyRemaining.
  const overReceiving =
    state.receive &&
    POSITIVE_DECIMAL_RE.test(state.qtyReceived) &&
    Number(state.qtyReceived) > Number(line.qtyRemaining);

  return (
    <div
      className={
        'rounded-md border p-3 ' +
        (state.receive
          ? 'border-border'
          : 'border-dashed border-border bg-muted/20')
      }
    >
      <div className="flex items-start gap-3">
        <div className="pt-2">
          <Checkbox
            id={`recv-${line.purchaseOrderLineId}`}
            checked={state.receive}
            onCheckedChange={(v) => onChange({ receive: v === true })}
          />
        </div>
        <div className="flex-1 space-y-2">
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="font-mono text-xs text-muted-foreground">
              {line.sku}
            </span>
            <span className="font-medium">{line.productName}</span>
            {line.variantName ? (
              <span className="text-xs text-muted-foreground">
                {line.variantName}
              </span>
            ) : null}
          </div>
          <div className="text-xs text-muted-foreground">
            Ordered{' '}
            <span className="font-medium text-foreground">
              {line.qtyOrdered}
            </span>
            <span className="px-1.5 text-muted-foreground/60">·</span>
            Already received{' '}
            <span className="font-medium text-foreground">
              {line.qtyAlreadyReceived}
            </span>
            <span className="px-1.5 text-muted-foreground/60">·</span>
            Remaining{' '}
            <span className="font-medium text-foreground">
              {line.qtyRemaining}
            </span>
          </div>
          {state.receive ? (
            <div className="grid grid-cols-12 gap-3">
              <div className="col-span-6 md:col-span-3">
                <Field>
                  <FieldLabel htmlFor={`qty-${line.purchaseOrderLineId}`}>
                    Qty
                  </FieldLabel>
                  <Input
                    id={`qty-${line.purchaseOrderLineId}`}
                    inputMode="decimal"
                    aria-invalid={!!state.errors.qtyReceived}
                    value={state.qtyReceived}
                    onChange={(e) =>
                      onChange({ qtyReceived: e.target.value })
                    }
                  />
                  <FieldError
                    errors={[
                      state.errors.qtyReceived
                        ? { message: state.errors.qtyReceived }
                        : undefined,
                    ]}
                  />
                  {overReceiving ? (
                    <p className="text-xs text-amber-600">
                      Over-receiving — allowed with warning.
                    </p>
                  ) : null}
                </Field>
              </div>
              <div className="col-span-6 md:col-span-3">
                <Field>
                  <FieldLabel htmlFor={`cost-${line.purchaseOrderLineId}`}>
                    Unit cost
                  </FieldLabel>
                  <Input
                    id={`cost-${line.purchaseOrderLineId}`}
                    inputMode="decimal"
                    aria-invalid={!!state.errors.unitCost}
                    value={state.unitCost}
                    onChange={(e) => onChange({ unitCost: e.target.value })}
                  />
                  <FieldError
                    errors={[
                      state.errors.unitCost
                        ? { message: state.errors.unitCost }
                        : undefined,
                    ]}
                  />
                </Field>
              </div>
              <div className="col-span-12 md:col-span-6">
                <Field>
                  <FieldLabel htmlFor={`note-${line.purchaseOrderLineId}`}>
                    Line notes
                  </FieldLabel>
                  <Input
                    id={`note-${line.purchaseOrderLineId}`}
                    placeholder="Optional — damage, discrepancy, lot info, etc."
                    value={state.notes}
                    onChange={(e) => onChange({ notes: e.target.value })}
                  />
                </Field>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
