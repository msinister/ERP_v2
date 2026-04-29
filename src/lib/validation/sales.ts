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
    lines: z.array(salesOrderLineInputSchema).min(1).optional(),
  })
  .superRefine(orderDiscountExclusive);

export const cancelSalesOrderInputSchema = z.object({
  reason: z.string().min(1).max(2000),
});

export const closeSalesOrderInputSchema = z.object({
  shippingAmount: nonNegativeDecimal.optional(),
  handlingAmount: nonNegativeDecimal.optional(),
});

export type SalesOrderLineInput = z.infer<typeof salesOrderLineInputSchema>;
export type CreateSalesOrderInput = z.infer<typeof createSalesOrderInputSchema>;
export type UpdateSalesOrderInput = z.infer<typeof updateSalesOrderInputSchema>;
export type CancelSalesOrderInput = z.infer<typeof cancelSalesOrderInputSchema>;
export type CloseSalesOrderInput = z.infer<typeof closeSalesOrderInputSchema>;

// Customer stub validation — mirrors the Vendor stub pattern.
export const createCustomerInputSchema = z.object({
  code: z.string().min(1).max(64),
  name: z.string().min(1).max(255),
  active: z.boolean().optional(),
});

export const updateCustomerInputSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  active: z.boolean().optional(),
});

export type CreateCustomerInput = z.infer<typeof createCustomerInputSchema>;
export type UpdateCustomerInput = z.infer<typeof updateCustomerInputSchema>;
