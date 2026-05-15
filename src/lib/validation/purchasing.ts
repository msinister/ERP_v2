import { z } from 'zod';
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

export type PurchaseOrderLineInput = z.infer<typeof purchaseOrderLineInputSchema>;
export type CreatePurchaseOrderInput = z.infer<typeof createPurchaseOrderInputSchema>;
export type UpdatePurchaseOrderInput = z.infer<typeof updatePurchaseOrderInputSchema>;
export type CancelPurchaseOrderInput = z.infer<typeof cancelPurchaseOrderInputSchema>;
export type ClosePurchaseOrderInput = z.infer<typeof closePurchaseOrderInputSchema>;
export type ReopenPurchaseOrderInput = z.infer<typeof reopenPurchaseOrderInputSchema>;
