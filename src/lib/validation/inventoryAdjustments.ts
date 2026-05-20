import { z } from 'zod';
import { AdjustmentCategory } from '@/generated/tenant';
import { decimalString } from './common';

export const adjustmentCategorySchema = z.nativeEnum(AdjustmentCategory);

// Signed quantity change: positive = add stock (gain), negative = remove
// (loss). Zero is rejected — an adjustment with no quantity change is a no-op.
const nonZeroDecimal = decimalString.refine(
  (v) => Number(v) !== 0,
  'Quantity change cannot be zero',
);

export const quickAdjustmentInputSchema = z.object({
  variantId: z.string().min(1),
  warehouseId: z.string().min(1),
  qtyChange: nonZeroDecimal,
  category: adjustmentCategorySchema,
  reason: z.string().min(1).max(2000),
  notes: z.string().max(2000).optional(),
  adjustmentDate: z.coerce.date().optional(),
});

export const voidAdjustmentInputSchema = z.object({
  reason: z.string().min(1).max(2000),
});

export type QuickAdjustmentInput = z.infer<typeof quickAdjustmentInputSchema>;
export type VoidAdjustmentInput = z.infer<typeof voidAdjustmentInputSchema>;
