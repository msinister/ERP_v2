import { z } from 'zod';
import { PaymentMethod, PoShipmentStatus } from '@/generated/tenant';
import { decimalString } from './common';

const positiveDecimal = decimalString.refine(
  (v) => Number(v) > 0,
  'Must be greater than 0',
);
const nonNegativeDecimal = decimalString.refine(
  (v) => Number(v) >= 0,
  'Must be >= 0',
);

export const purchaseOrderLineInputSchema = z.object({
  variantId: z.string().min(1),
  warehouseId: z.string().min(1),
  qtyOrdered: positiveDecimal,
  unitCost: nonNegativeDecimal,
  vendorSku: z.string().max(255).optional(),
  manufacturerPartNumber: z.string().max(255).optional(),
  notes: z.string().max(2000).optional(),
});

export const createPurchaseOrderInputSchema = z.object({
  vendorId: z.string().min(1),
  expectedReceiveDate: z.coerce.date().optional(),
  currency: z.string().min(3).max(3).optional(),
  notes: z.string().max(2000).optional(),
  createdById: z.string().optional(),
  lines: z.array(purchaseOrderLineInputSchema).min(1),
});

export const updatePurchaseOrderInputSchema = z.object({
  expectedReceiveDate: z.coerce.date().nullable().optional(),
  currency: z.string().min(3).max(3).optional(),
  notes: z.string().max(2000).nullable().optional(),
  lines: z.array(purchaseOrderLineInputSchema).min(1).optional(),
});

export const cancelPurchaseOrderInputSchema = z.object({
  reason: z.string().max(2000).optional(),
});

// Manual close — reason required (unlike cancel, where it's optional).
// Operators reach this when no further receipts are expected: short
// shipment, vendor cancellation, damaged goods. The reason persists
// on PurchaseOrder.closeReason and shows on the PO detail page.
export const closePurchaseOrderInputSchema = z.object({
  reason: z.string().min(1, 'Reason is required').max(2000),
});

// Manual reopen of a CLOSED PO. Reason required so the audit trail
// captures why the operator undid the close. The service clears
// closeReason + closedAt and reverts the status to either
// PARTIALLY_RECEIVED (some receipts already exist) or CONFIRMED
// (none).
export const reopenPurchaseOrderInputSchema = z.object({
  reason: z.string().min(1, 'Reason is required').max(2000),
});

// Inline per-field PO line edits. Allowed on CONFIRMED + PARTIALLY_
// RECEIVED. Each field is independently optional — operators edit one
// cell at a time and the route sends only what changed. The service
// enforces qtyOrdered >= qtyReceived so an edit cannot create a
// logical inconsistency with what's already been received. Cost edits
// do NOT touch FIFO / already-posted ReceiptLines — those are frozen
// at receipt time. Notes / vendor SKU / MPN are nullable so an empty
// payload clears them.
export const updatePurchaseOrderLineFieldsInputSchema = z
  .object({
    qtyOrdered: positiveDecimal.optional(),
    unitCost: nonNegativeDecimal.optional(),
    vendorSku: z.string().max(255).nullable().optional(),
    manufacturerPartNumber: z.string().max(255).nullable().optional(),
    notes: z.string().max(2000).nullable().optional(),
  })
  .superRefine((data, ctx) => {
    const hasAny =
      data.qtyOrdered !== undefined ||
      data.unitCost !== undefined ||
      data.vendorSku !== undefined ||
      data.manufacturerPartNumber !== undefined ||
      data.notes !== undefined;
    if (!hasAny) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message: 'At least one field is required',
      });
    }
  });

// Add-lines on CONFIRMED + PARTIALLY_RECEIVED. New lines start at
// qtyReceived = 0 by default. Re-uses the per-line shape from
// purchaseOrderLineInputSchema.
export const addPurchaseOrderLinesInputSchema = z.object({
  lines: z.array(purchaseOrderLineInputSchema).min(1),
});

// =============================================================================
// PO shipments — physical-logistics tracking. No GL/inventory effect.
// trackingUrl is a free-form string (carrier deep-links vary); the UI
// renders it as a link when present. cartonCount coerces from the form's
// string input; totalWeight is decimalString so it shares the project-wide
// money/decimal precision rules even though it's a weight.
// =============================================================================

const shipmentStatusSchema = z.nativeEnum(PoShipmentStatus);

export const createPoShipmentInputSchema = z.object({
  shipmentStatus: shipmentStatusSchema,
  trackingNumber: z.string().max(255).nullable().optional(),
  carrierName: z.string().max(255).nullable().optional(),
  trackingUrl: z.string().max(2000).nullable().optional(),
  cartonCount: z.coerce.number().int().min(0).nullable().optional(),
  totalWeight: nonNegativeDecimal.nullable().optional(),
  weightUnit: z.string().max(16).optional(),
  estimatedArrival: z.coerce.date().nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});

// All fields optional — the inline editor sends only what changed. A
// no-op payload is rejected by the service (mirrors the PO line editor).
export const updatePoShipmentInputSchema = z.object({
  shipmentStatus: shipmentStatusSchema.optional(),
  trackingNumber: z.string().max(255).nullable().optional(),
  carrierName: z.string().max(255).nullable().optional(),
  trackingUrl: z.string().max(2000).nullable().optional(),
  cartonCount: z.coerce.number().int().min(0).nullable().optional(),
  totalWeight: nonNegativeDecimal.nullable().optional(),
  weightUnit: z.string().max(16).optional(),
  estimatedArrival: z.coerce.date().nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});

// =============================================================================
// PO direct payments (prepay / import deposits).
//
// method reuses the PaymentMethod enum but is OPTIONAL — a deposit can be
// logged before the method is known. APPLIED_CREDIT makes no sense as a
// cash-out source, so it's rejected (mirrors the bill-payment validator).
// cashAccountId is required: the deposit JE needs a bank/asset (or
// credit-card liability) account to credit.
// =============================================================================

const poPaymentMethodSchema = z
  .nativeEnum(PaymentMethod)
  .refine((m) => m !== PaymentMethod.APPLIED_CREDIT, {
    message: 'APPLIED_CREDIT is not a valid deposit source',
  });

export const recordPoPaymentInputSchema = z.object({
  amount: positiveDecimal,
  paymentDate: z.coerce.date().optional(),
  method: poPaymentMethodSchema.optional(),
  cashAccountId: z.string().min(1),
  reference: z.string().max(255).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});

export const voidPoPaymentInputSchema = z.object({
  // Reversals always need a reason — the accounting trail requires it.
  reason: z.string().min(1).max(2000),
});

export type CreatePoShipmentInput = z.infer<typeof createPoShipmentInputSchema>;
export type UpdatePoShipmentInput = z.infer<typeof updatePoShipmentInputSchema>;
export type RecordPoPaymentInput = z.infer<typeof recordPoPaymentInputSchema>;
export type VoidPoPaymentInput = z.infer<typeof voidPoPaymentInputSchema>;

export type PurchaseOrderLineInput = z.infer<typeof purchaseOrderLineInputSchema>;
export type CreatePurchaseOrderInput = z.infer<typeof createPurchaseOrderInputSchema>;
export type UpdatePurchaseOrderInput = z.infer<typeof updatePurchaseOrderInputSchema>;
export type CancelPurchaseOrderInput = z.infer<typeof cancelPurchaseOrderInputSchema>;
export type ClosePurchaseOrderInput = z.infer<typeof closePurchaseOrderInputSchema>;
export type ReopenPurchaseOrderInput = z.infer<typeof reopenPurchaseOrderInputSchema>;
export type UpdatePurchaseOrderLineFieldsInput = z.infer<
  typeof updatePurchaseOrderLineFieldsInputSchema
>;
export type AddPurchaseOrderLinesInput = z.infer<typeof addPurchaseOrderLinesInputSchema>;
