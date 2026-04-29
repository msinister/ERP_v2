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

export type PurchaseOrderLineInput = z.infer<typeof purchaseOrderLineInputSchema>;
export type CreatePurchaseOrderInput = z.infer<typeof createPurchaseOrderInputSchema>;
export type UpdatePurchaseOrderInput = z.infer<typeof updatePurchaseOrderInputSchema>;
export type CancelPurchaseOrderInput = z.infer<typeof cancelPurchaseOrderInputSchema>;
