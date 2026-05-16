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

// =============================================================================
// Work Order (Build) validation. Mirrors the PO/SO header+lines pattern,
// but the BOM snapshot lines are created by the service from the parent
// product's live BOM at creation time — the caller doesn't supply lines.
// =============================================================================

export const createWorkOrderInputSchema = z.object({
  productId: z.string().min(1),
  // Required — operators pick which variant of the assembled product
  // receives the finished units. Auto-defaulted on the UI when only
  // one variant exists, still passed explicitly.
  variantId: z.string().min(1),
  warehouseId: z.string().min(1),
  qtyToBuild: positiveDecimal,
  // Operator can override the BOM's labor cost at create time. Null
  // explicitly clears (no labor charge); undefined inherits from the
  // parent product's bomLaborCost.
  laborCost: nonNegativeDecimal.nullable().optional(),
  notes: z.string().max(2000).optional(),
  createdById: z.string().optional(),
});

// Operator-edit of an existing DRAFT WO. Labor cost is the only
// editable surface; qty/warehouse/variant changes require cancel +
// re-create (preserves the BOM snapshot semantic).
export const updateWorkOrderInputSchema = z.object({
  laborCost: nonNegativeDecimal.nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});

export const completeWorkOrderInputSchema = z.object({
  // How many finished units to build in this completion event. Must be
  // > 0 and <= remaining (qtyToBuild - qtyCompleted). Partial completions
  // keep the WO in IN_PROGRESS; the final completion (qtyCompleted ==
  // qtyToBuild) flips it to COMPLETED.
  qtyToComplete: positiveDecimal,
});

export const cancelWorkOrderInputSchema = z.object({
  reason: z.string().min(1, 'Reason is required').max(2000),
});

export type CreateWorkOrderInput = z.infer<typeof createWorkOrderInputSchema>;
export type UpdateWorkOrderInput = z.infer<typeof updateWorkOrderInputSchema>;
export type CompleteWorkOrderInput = z.infer<typeof completeWorkOrderInputSchema>;
export type CancelWorkOrderInput = z.infer<typeof cancelWorkOrderInputSchema>;
