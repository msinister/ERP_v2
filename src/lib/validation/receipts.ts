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

export const receiptLineInputSchema = z.object({
  purchaseOrderLineId: z.string().min(1).nullable().optional(),
  variantId: z.string().min(1),
  warehouseId: z.string().min(1),
  qtyReceived: positiveDecimal,
  unitCost: nonNegativeDecimal,
  notes: z.string().max(2000).optional(),
});

export const createReceiptInputSchema = z.object({
  vendorId: z.string().min(1),
  warehouseId: z.string().min(1),
  notes: z.string().max(2000).optional(),
  createdById: z.string().optional(),
  lines: z.array(receiptLineInputSchema).min(1),
});

export const updateReceiptInputSchema = z.object({
  notes: z.string().max(2000).nullable().optional(),
  lines: z.array(receiptLineInputSchema).min(1).optional(),
});

export const cancelReceiptInputSchema = z.object({
  reason: z.string().max(2000).optional(),
});

export type ReceiptLineInput = z.infer<typeof receiptLineInputSchema>;
export type CreateReceiptInput = z.infer<typeof createReceiptInputSchema>;
export type UpdateReceiptInput = z.infer<typeof updateReceiptInputSchema>;
export type CancelReceiptInput = z.infer<typeof cancelReceiptInputSchema>;
