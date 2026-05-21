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
const percentDecimal = decimalString.refine(
  (v) => {
    const n = Number(v);
    return n >= 0 && n <= 100;
  },
  'Must be between 0 and 100',
);

// At most one of (discountPercent, discountAmount) may be set on a line or
// at the order level. Spec calls this out as "% or fixed price override".
function discountExclusive<T extends { discountPercent?: unknown; discountAmount?: unknown }>(
  data: T,
  ctx: z.RefinementCtx,
): void {
  if (data.discountPercent != null && data.discountAmount != null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['discountAmount'],
      message: 'Set discountPercent OR discountAmount, not both',
    });
  }
}

function orderDiscountExclusive<T extends { orderDiscountPercent?: unknown; orderDiscountAmount?: unknown }>(
  data: T,
  ctx: z.RefinementCtx,
): void {
  if (data.orderDiscountPercent != null && data.orderDiscountAmount != null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['orderDiscountAmount'],
      message: 'Set orderDiscountPercent OR orderDiscountAmount, not both',
    });
  }
}

export const salesOrderLineInputSchema = z
  .object({
    variantId: z.string().min(1),
    warehouseId: z.string().min(1),
    qtyOrdered: positiveDecimal,
    // Optional manual override. When omitted, the pricing resolver falls
    // back to the product's basePrice. Every line goes through resolvePrice
    // — never bypass it.
    manualUnitPrice: nonNegativeDecimal.optional(),
    discountPercent: percentDecimal.optional(),
    discountAmount: nonNegativeDecimal.optional(),
    customerNote: z.string().max(2000).optional(),
    internalNote: z.string().max(2000).optional(),
  })
  .superRefine(discountExclusive);

export const createSalesOrderInputSchema = z
  .object({
    customerId: z.string().min(1),
    warehouseId: z.string().min(1),
    source: z.enum(['STAFF', 'PORTAL', 'SHOPIFY']).optional(),
    currency: z.string().min(3).max(3).optional(),
    customerPo: z.string().max(255).optional(),
    promisedShipDate: z.coerce.date().optional(),
    orderDate: z.coerce.date().optional(),
    orderDiscountPercent: percentDecimal.optional(),
    orderDiscountAmount: nonNegativeDecimal.optional(),
    shippingAmount: nonNegativeDecimal.optional(),
    handlingAmount: nonNegativeDecimal.optional(),
    shippingAddress: z.string().max(2000).optional(),
    customerNotes: z.string().max(2000).optional(),
    internalNotes: z.string().max(2000).optional(),
    createdById: z.string().optional(),
    lines: z.array(salesOrderLineInputSchema).min(1),
  })
  .superRefine(orderDiscountExclusive);

export const updateSalesOrderInputSchema = z
  .object({
    warehouseId: z.string().min(1).optional(),
    currency: z.string().min(3).max(3).optional(),
    customerPo: z.string().max(255).nullable().optional(),
    promisedShipDate: z.coerce.date().nullable().optional(),
    orderDate: z.coerce.date().optional(),
    orderDiscountPercent: percentDecimal.nullable().optional(),
    orderDiscountAmount: nonNegativeDecimal.nullable().optional(),
    shippingAmount: nonNegativeDecimal.nullable().optional(),
    handlingAmount: nonNegativeDecimal.nullable().optional(),
    shippingAddress: z.string().max(2000).nullable().optional(),
    customerNotes: z.string().max(2000).nullable().optional(),
    internalNotes: z.string().max(2000).nullable().optional(),
    // Per-order rep override. null = clear the override (inherit the
    // customer's rep). Absent = leave unchanged. DRAFT path only — the
    // detail-page inline edit (Confirmed/Dispatched too) uses
    // setSalesOrderSalesRepInputSchema instead.
    salesRepId: z.string().min(1).nullable().optional(),
    lines: z.array(salesOrderLineInputSchema).min(1).optional(),
  })
  .superRefine(orderDiscountExclusive);

// Dedicated sales-rep change for the SO detail inline edit. Allowed on
// any status (incl. Closed); not retroactive to already-accrued
// commission. null = inherit the customer's rep.
export const setSalesOrderSalesRepInputSchema = z.object({
  salesRepId: z.string().min(1).nullable(),
});

export const cancelSalesOrderInputSchema = z.object({
  reason: z.string().min(1).max(2000),
});

// Per-line qtyShipped on close. When omitted, every line ships its full
// qtyOrdered (the historic behavior). When provided, every entry maps a
// SalesOrderLine.id → the qty actually shipped; service-side enforces
// qtyShipped ≤ qtyOrdered, IDs belong to the SO, and no duplicates.
export const closeSalesOrderLineInputSchema = z.object({
  id: z.string().min(1),
  qtyShipped: positiveDecimal,
});

// Inline per-line qtyShipped update. Used by the SO detail page's
// editable Qty shipped column while the SO is CONFIRMED or DISPATCHED
// — operators record what actually went out before clicking Close.
// Service-side enforces 0 < qtyShipped ≤ line.qtyOrdered.
export const updateSalesOrderLineQtyShippedInputSchema = z.object({
  qtyShipped: positiveDecimal,
});

// Inline per-field SO line edits. Allowed while the order is DRAFT or
// CONFIRMED. Each field is independently optional — operators edit one
// cell at a time and the route sends only what changed. discountPercent
// and discountAmount are mutually exclusive (service-side flips the
// counterpart to null when the operator supplies one). On CONFIRMED:
//   - qty changes update qtyReserved + recompute the bin counter.
//   - any total-changing edit re-runs the credit-limit + AR-hold gate.
// Notes are nullable so an empty string from the input clears them.
export const updateSalesOrderLineFieldsInputSchema = z
  .object({
    qtyOrdered: positiveDecimal.optional(),
    unitPrice: nonNegativeDecimal.optional(),
    discountPercent: percentDecimal.nullable().optional(),
    discountAmount: nonNegativeDecimal.nullable().optional(),
    customerNote: z.string().max(2000).nullable().optional(),
    internalNote: z.string().max(2000).nullable().optional(),
  })
  .superRefine((data, ctx) => {
    // Same exclusivity rule as the create/update line schemas — both
    // discount fields set is a contract error from the client.
    if (data.discountPercent != null && data.discountAmount != null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['discountAmount'],
        message: 'Set discountPercent OR discountAmount, not both',
      });
    }
    // At least one field must be present — empty payload = no-op the
    // client shouldn't be sending.
    const hasAny =
      data.qtyOrdered !== undefined ||
      data.unitPrice !== undefined ||
      data.discountPercent !== undefined ||
      data.discountAmount !== undefined ||
      data.customerNote !== undefined ||
      data.internalNote !== undefined;
    if (!hasAny) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message: 'At least one field is required',
      });
    }
  });

// reopenSalesOrder — corrections workflow: CLOSED → CONFIRMED,
// DISPATCHED, or CANCELLED. paymentDecision must be 'unapply' when
// the linked invoice has any non-reversed CreditApplication rows; the
// service throws SalesOrderReopenBlockedError otherwise so the UI can
// prompt the operator. 'none' is the default for invoices that never
// had a payment recorded.
export const reopenSalesOrderInputSchema = z.object({
  targetStatus: z.enum(['CONFIRMED', 'DISPATCHED', 'CANCELLED']),
  paymentDecision: z.enum(['none', 'unapply']).default('none'),
  unapplyReason: z.string().max(2000).optional(),
});

// Add-line on CONFIRMED. Re-uses the per-line shape from
// salesOrderLineInputSchema (variant + warehouse + qty + price hints).
// The service ensures bin reservation + credit-limit re-check happens
// atomically with the inserts.
export const addSalesOrderLinesInputSchema = z.object({
  lines: z.array(salesOrderLineInputSchema).min(1),
});

export const closeSalesOrderInputSchema = z.object({
  shippingAmount: nonNegativeDecimal.optional(),
  handlingAmount: nonNegativeDecimal.optional(),
  lines: z.array(closeSalesOrderLineInputSchema).optional(),
});

// Per-line remove on DRAFT / CONFIRMED. `removeBundleGroup` opt-in
// removes every line that shares the targeted line's bundleGroupId
// (the operator chose "Remove bundle" in the confirm dialog); the
// default removes just the one line, leaving sibling component lines
// in place — useful when a customer drops one item from a bundle.
export const removeSalesOrderLineInputSchema = z.object({
  removeBundleGroup: z.boolean().optional().default(false),
});

export type SalesOrderLineInput = z.infer<typeof salesOrderLineInputSchema>;
export type CreateSalesOrderInput = z.infer<typeof createSalesOrderInputSchema>;
export type UpdateSalesOrderInput = z.infer<typeof updateSalesOrderInputSchema>;
export type SetSalesOrderSalesRepInput = z.infer<
  typeof setSalesOrderSalesRepInputSchema
>;
export type CancelSalesOrderInput = z.infer<typeof cancelSalesOrderInputSchema>;
export type CloseSalesOrderInput = z.infer<typeof closeSalesOrderInputSchema>;
export type CloseSalesOrderLineInput = z.infer<
  typeof closeSalesOrderLineInputSchema
>;
export type UpdateSalesOrderLineQtyShippedInput = z.infer<
  typeof updateSalesOrderLineQtyShippedInputSchema
>;
export type UpdateSalesOrderLineFieldsInput = z.infer<
  typeof updateSalesOrderLineFieldsInputSchema
>;
export type ReopenSalesOrderInput = z.infer<
  typeof reopenSalesOrderInputSchema
>;
export type AddSalesOrderLinesInput = z.infer<
  typeof addSalesOrderLinesInputSchema
>;
export type RemoveSalesOrderLineInput = z.infer<
  typeof removeSalesOrderLineInputSchema
>;
// Customer stub validation moved to src/lib/validation/customers.ts as
// part of the Customer master expansion slice — see that file for the
// full master schemas + the transition-phase stub shim.
