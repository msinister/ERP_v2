'use client';

import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Lock, MessageSquareText, Plus } from 'lucide-react';
import { formatCurrency } from '@/lib/format';
import { InlineEditableCell } from './inline-editable-cell';

// =============================================================================
// Per-field click-to-edit cells for the SO detail table. Each wraps
// InlineEditableCell with the field-specific validator + the right
// PATCH payload. Client-side only — they wire the API closures that
// can't cross the server/client boundary.
//
// All cells take an `editable` flag from the parent. When false, they
// render their display value with no click handlers (current static
// behavior preserved on DISPATCHED / CLOSED / CANCELLED).
//
// Saves go to PATCH /api/sales-orders/[soId]/lines/[lineId]. The route
// dispatches by payload shape — these cells always carry one of the
// field-edit keys (never qtyShipped) so the route routes correctly.
// =============================================================================

const DECIMAL_RE = /^(\d+(\.\d+)?|\.\d+)$/;

type SaveResult = { ok: true } | { ok: false; error: string };

async function patchLineFields(
  soId: string,
  lineId: string,
  body: Record<string, string | null>,
): Promise<SaveResult> {
  const res = await fetch(`/api/sales-orders/${soId}/lines/${lineId}`, {
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
  // Strip trailing zeros to match the read-only renderer's format.
  if (!qty.includes('.')) return qty;
  return qty.replace(/\.?0+$/, '');
}

// ---------------------------------------------------------------------------
// Qty ordered
// ---------------------------------------------------------------------------

export function EditableQtyCell({
  salesOrderId,
  lineId,
  qtyOrdered,
  editable,
}: {
  salesOrderId: string;
  lineId: string;
  qtyOrdered: string;
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
        return { value: v, error: null };
      }}
      save={(value) =>
        patchLineFields(salesOrderId, lineId, { qtyOrdered: value })
      }
    />
  );
}

// ---------------------------------------------------------------------------
// Unit price
// ---------------------------------------------------------------------------

export function EditableUnitPriceCell({
  salesOrderId,
  lineId,
  unitPrice,
  editable,
}: {
  salesOrderId: string;
  lineId: string;
  unitPrice: string;
  editable: boolean;
}) {
  return (
    <InlineEditableCell
      readOnly={!editable}
      displayValue={<span>{formatCurrency(unitPrice)}</span>}
      rawValue={unitPrice}
      inputMode="decimal"
      inputClassName="w-24 text-right tabular-nums"
      ariaLabel="Unit price"
      validate={(raw) => {
        const v = raw.trim();
        if (v === '' || !DECIMAL_RE.test(v)) {
          return { value: null, error: 'Unit price must be a number' };
        }
        if (Number(v) < 0) {
          return { value: null, error: 'Unit price must be ≥ 0' };
        }
        return { value: v, error: null };
      }}
      save={(value) =>
        patchLineFields(salesOrderId, lineId, { unitPrice: value })
      }
    />
  );
}

// ---------------------------------------------------------------------------
// Discount (percent OR amount). Click-to-edit retains whichever side
// is currently set; clearing the field clears the discount. Empty state
// (both null) defaults to percent mode per the agreed UX.
// ---------------------------------------------------------------------------

export function EditableDiscountCell({
  salesOrderId,
  lineId,
  discountPercent,
  discountAmount,
  editable,
}: {
  salesOrderId: string;
  lineId: string;
  discountPercent: string | null;
  discountAmount: string | null;
  editable: boolean;
}) {
  const mode: 'percent' | 'amount' =
    discountAmount != null ? 'amount' : 'percent';
  const raw =
    mode === 'amount' ? (discountAmount ?? '') : (discountPercent ?? '');
  const displayValue =
    discountAmount != null ? (
      <span>−{formatCurrency(discountAmount)}</span>
    ) : discountPercent != null ? (
      <span>−{Number(discountPercent)}%</span>
    ) : (
      <span className="text-muted-foreground">—</span>
    );

  return (
    <InlineEditableCell
      readOnly={!editable}
      displayValue={displayValue}
      rawValue={raw}
      inputMode="decimal"
      inputClassName="w-20 text-right tabular-nums"
      ariaLabel={mode === 'amount' ? 'Discount amount' : 'Discount percent'}
      emptyPlaceholder={<span className="text-muted-foreground">—</span>}
      validate={(input) => {
        const v = input.trim();
        if (v === '') {
          // Empty = clear discount. Send the sentinel "" which the
          // save closure translates to null. Indicate validity by
          // returning v itself; the save function handles the null
          // translation for the payload.
          return { value: '', error: null };
        }
        if (!DECIMAL_RE.test(v)) {
          return { value: null, error: 'Discount must be a number' };
        }
        if (Number(v) < 0) {
          return { value: null, error: 'Discount must be ≥ 0' };
        }
        if (mode === 'percent' && Number(v) > 100) {
          return { value: null, error: 'Percent must be ≤ 100' };
        }
        return { value: v, error: null };
      }}
      save={(value) => {
        const key = mode === 'amount' ? 'discountAmount' : 'discountPercent';
        const payload: Record<string, string | null> = {
          [key]: value === '' ? null : value,
        };
        return patchLineFields(salesOrderId, lineId, payload);
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Description cell with editable customer + internal notes. The cell
// itself stays static for product name / variant — those are master-
// data fields, not free-text. Notes get click-to-edit affordances
// underneath: customer note prints on documents (italic), internal
// note is staff-only (lock icon).
// ---------------------------------------------------------------------------

export function EditableNotesBlock({
  salesOrderId,
  lineId,
  customerNote,
  internalNote,
  editable,
}: {
  salesOrderId: string;
  lineId: string;
  customerNote: string | null;
  internalNote: string | null;
  editable: boolean;
}) {
  // The internal note row is hidden by default when empty + read-only.
  // When editable it stays visible (the "+ internal note" affordance)
  // so operators don't need to discover an entry point.
  const showInternal = editable || (internalNote != null && internalNote !== '');

  return (
    <div className="mt-1 space-y-1">
      <NoteRow
        salesOrderId={salesOrderId}
        lineId={lineId}
        field="customerNote"
        value={customerNote}
        editable={editable}
        kind="customer"
      />
      {showInternal ? (
        <NoteRow
          salesOrderId={salesOrderId}
          lineId={lineId}
          field="internalNote"
          value={internalNote}
          editable={editable}
          kind="internal"
        />
      ) : null}
    </div>
  );
}

function NoteRow({
  salesOrderId,
  lineId,
  field,
  value,
  editable,
  kind,
}: {
  salesOrderId: string;
  lineId: string;
  field: 'customerNote' | 'internalNote';
  value: string | null;
  editable: boolean;
  kind: 'customer' | 'internal';
}) {
  const isEmpty = value == null || value.trim() === '';

  // Customer note prints on the SO and invoice — italic + quote
  // styling. Internal note never prints; uses a "Internal" badge +
  // lock icon so operators can tell at a glance which is which.
  const display = isEmpty ? (
    editable ? (
      <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
        {kind === 'customer' ? (
          <>
            <Plus className="size-3" aria-hidden />
            Customer note
          </>
        ) : (
          <>
            <Plus className="size-3" aria-hidden />
            <Lock className="size-3" aria-hidden />
            Internal note
          </>
        )}
      </span>
    ) : null
  ) : kind === 'customer' ? (
    <span className="inline-flex items-baseline gap-1 text-xs italic text-muted-foreground">
      <MessageSquareText className="size-3 self-center not-italic" aria-hidden />
      “{value}”
    </span>
  ) : (
    <span className="inline-flex items-baseline gap-1.5 text-xs text-muted-foreground">
      <Badge variant="outline" className="gap-1 px-1 py-0 text-[9px]">
        <Lock className="size-2.5" aria-hidden />
        Internal
      </Badge>
      {value}
    </span>
  );

  if (isEmpty && !editable) return null;

  return (
    <InlineEditableCell
      readOnly={!editable}
      displayValue={display}
      rawValue={value ?? ''}
      inputMode="text"
      inputClassName="w-full max-w-md text-xs"
      ariaLabel={kind === 'customer' ? 'Customer note' : 'Internal note'}
      validate={(raw) => {
        if (raw.length > 2000) {
          return { value: null, error: 'Note is too long (2000 char max)' };
        }
        return { value: raw, error: null };
      }}
      save={(input) => {
        // Empty string clears the field — send null so the server
        // unsets the column rather than storing an empty string.
        const next = input.trim() === '' ? null : input;
        return patchLineFields(salesOrderId, lineId, { [field]: next });
      }}
    />
  );
}

// Surface this so the lines-table can read the same fixed flag from
// the wrapper without duplicating the status-window logic.
export function isLineFieldsEditable(status: string): boolean {
  return status === 'DRAFT' || status === 'CONFIRMED';
}
