'use client';

import { Prisma } from '@/generated/tenant';
import { MessageSquareText, Plus } from 'lucide-react';
import { formatCurrency } from '@/lib/format';
import { InlineEditableCell } from './inline-editable-cell';

// =============================================================================
// Per-field click-to-edit cells for the PO detail table. Each wraps
// InlineEditableCell with the field-specific validator + the right
// PATCH payload. Saves go to PATCH /api/purchase-orders/[poId]/lines/
// [lineId]. Mirrors the SO inline-edit set; differs only in which
// fields are editable (no discount; replace unitPrice with unitCost;
// add vendor SKU + MPN).
//
// Each cell takes `editable`. When false they render as static text
// with no click handlers (DRAFT, CLOSED, CANCELLED on the PO side).
// =============================================================================

const DECIMAL_RE = /^(\d+(\.\d+)?|\.\d+)$/;

type SaveResult = { ok: true } | { ok: false; error: string };

async function patchLineFields(
  poId: string,
  lineId: string,
  body: Record<string, string | null>,
): Promise<SaveResult> {
  const res = await fetch(`/api/purchase-orders/${poId}/lines/${lineId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const parsed = (await res.json().catch(() => ({}))) as {
      error?: string;
      issues?: Array<{ message?: string }>;
    };
    const message =
      parsed.issues?.[0]?.message ??
      parsed.error ??
      `Save failed (${res.status})`;
    return { ok: false, error: message };
  }
  return { ok: true };
}

function formatQty(qty: string): string {
  if (!qty.includes('.')) return qty;
  return qty.replace(/\.?0+$/, '');
}

// ---------------------------------------------------------------------------
// Qty ordered. Server enforces qtyOrdered >= qtyReceived; we also
// reject locally to give a faster failure path. qtyReceived is passed
// in so the client-side check can match what the server would say.
// ---------------------------------------------------------------------------

export function EditableQtyOrderedCell({
  purchaseOrderId,
  lineId,
  qtyOrdered,
  qtyReceived,
  editable,
}: {
  purchaseOrderId: string;
  lineId: string;
  qtyOrdered: string;
  qtyReceived: string;
  editable: boolean;
}) {
  return (
    <InlineEditableCell
      readOnly={!editable}
      displayValue={<span>{formatQty(qtyOrdered)}</span>}
      rawValue={qtyOrdered}
      inputMode="decimal"
      inputClassName="w-20 text-right tabular-nums"
      ariaLabel="Qty ordered"
      validate={(raw) => {
        const v = raw.trim();
        if (v === '' || !DECIMAL_RE.test(v)) {
          return { value: null, error: 'Qty must be a positive number' };
        }
        if (Number(v) <= 0) {
          return { value: null, error: 'Qty must be > 0' };
        }
        if (new Prisma.Decimal(v).lessThan(new Prisma.Decimal(qtyReceived))) {
          return {
            value: null,
            error: `Cannot reduce qty below ${formatQty(qtyReceived)} (already received)`,
          };
        }
        return { value: v, error: null };
      }}
      save={(value) =>
        patchLineFields(purchaseOrderId, lineId, { qtyOrdered: value })
      }
    />
  );
}

// ---------------------------------------------------------------------------
// Unit cost. Cost edits do NOT touch FIFO / already-posted ReceiptLines
// — the unit cost on the PO line is a forward-looking hint for future
// receiving + reporting. The server documents this in the comment on
// updatePurchaseOrderLineFields.
// ---------------------------------------------------------------------------

export function EditableUnitCostCell({
  purchaseOrderId,
  lineId,
  unitCost,
  editable,
}: {
  purchaseOrderId: string;
  lineId: string;
  unitCost: string;
  editable: boolean;
}) {
  return (
    <InlineEditableCell
      readOnly={!editable}
      displayValue={<span>{formatCurrency(unitCost)}</span>}
      rawValue={unitCost}
      inputMode="decimal"
      inputClassName="w-24 text-right tabular-nums"
      ariaLabel="Unit cost"
      validate={(raw) => {
        const v = raw.trim();
        if (v === '' || !DECIMAL_RE.test(v)) {
          return { value: null, error: 'Unit cost must be a number' };
        }
        if (Number(v) < 0) {
          return { value: null, error: 'Unit cost must be ≥ 0' };
        }
        return { value: v, error: null };
      }}
      save={(value) =>
        patchLineFields(purchaseOrderId, lineId, { unitCost: value })
      }
    />
  );
}

// ---------------------------------------------------------------------------
// Vendor SKU + MPN. Free-text fields. Empty string clears the column.
// ---------------------------------------------------------------------------

export function EditableVendorSkuCell({
  purchaseOrderId,
  lineId,
  vendorSku,
  editable,
}: {
  purchaseOrderId: string;
  lineId: string;
  vendorSku: string | null;
  editable: boolean;
}) {
  return <SubscriptTextField
    purchaseOrderId={purchaseOrderId}
    lineId={lineId}
    field="vendorSku"
    label="vendor"
    value={vendorSku}
    editable={editable}
    ariaLabel="Vendor SKU"
  />;
}

export function EditableMpnCell({
  purchaseOrderId,
  lineId,
  manufacturerPartNumber,
  editable,
}: {
  purchaseOrderId: string;
  lineId: string;
  manufacturerPartNumber: string | null;
  editable: boolean;
}) {
  return <SubscriptTextField
    purchaseOrderId={purchaseOrderId}
    lineId={lineId}
    field="manufacturerPartNumber"
    label="mpn"
    value={manufacturerPartNumber}
    editable={editable}
    ariaLabel="Manufacturer part number"
  />;
}

function SubscriptTextField({
  purchaseOrderId,
  lineId,
  field,
  label,
  value,
  editable,
  ariaLabel,
}: {
  purchaseOrderId: string;
  lineId: string;
  field: 'vendorSku' | 'manufacturerPartNumber';
  label: string;
  value: string | null;
  editable: boolean;
  ariaLabel: string;
}) {
  const isEmpty = value == null || value.trim() === '';

  // When empty + read-only we render nothing (current behavior). When
  // empty + editable, render a "+ vendor" / "+ mpn" affordance.
  if (isEmpty && !editable) return null;

  const display = isEmpty ? (
    <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground">
      <Plus className="size-3" aria-hidden />
      {label}
    </span>
  ) : (
    <span className="text-[10px] uppercase tracking-wide">
      {label}: {value}
    </span>
  );

  return (
    <InlineEditableCell
      readOnly={!editable}
      displayValue={display}
      rawValue={value ?? ''}
      inputMode="text"
      inputClassName="h-6 w-full max-w-[16rem] text-xs"
      ariaLabel={ariaLabel}
      validate={(raw) => {
        if (raw.length > 255) {
          return { value: null, error: `${ariaLabel} is too long (255 char max)` };
        }
        return { value: raw, error: null };
      }}
      save={(input) => {
        const next = input.trim() === '' ? null : input;
        return patchLineFields(purchaseOrderId, lineId, { [field]: next });
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Line notes. Single-row editor — POs have just one note (no
// customer/internal split like SO).
// ---------------------------------------------------------------------------

export function EditableLineNotesCell({
  purchaseOrderId,
  lineId,
  notes,
  editable,
}: {
  purchaseOrderId: string;
  lineId: string;
  notes: string | null;
  editable: boolean;
}) {
  const isEmpty = notes == null || notes.trim() === '';

  if (isEmpty && !editable) return null;

  const display = isEmpty ? (
    <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
      <Plus className="size-3" aria-hidden />
      Line note
    </span>
  ) : (
    <span className="inline-flex items-baseline gap-1 text-xs italic text-muted-foreground">
      <MessageSquareText className="size-3 self-center not-italic" aria-hidden />
      “{notes}”
    </span>
  );

  return (
    <InlineEditableCell
      readOnly={!editable}
      displayValue={display}
      rawValue={notes ?? ''}
      inputMode="text"
      inputClassName="w-full max-w-md text-xs"
      ariaLabel="Line note"
      validate={(raw) => {
        if (raw.length > 2000) {
          return { value: null, error: 'Note is too long (2000 char max)' };
        }
        return { value: raw, error: null };
      }}
      save={(input) => {
        const next = input.trim() === '' ? null : input;
        return patchLineFields(purchaseOrderId, lineId, { notes: next });
      }}
    />
  );
}

