import { z } from 'zod';
import { decimalString } from './common';

const positiveDecimal = decimalString.refine(
  (v) => Number(v) > 0,
  'Must be greater than 0',
);

const nonNegativeDecimal = decimalString.refine(
  (v) => Number(v) >= 0,
  'Must be greater than or equal to 0',
);

const nonZeroDecimal = decimalString.refine(
  (v) => Number(v) !== 0,
  'Must not be zero',
);

const baseFields = {
  variantId: z.string().min(1),
  warehouseId: z.string().min(1),
  reference: z.string().max(255).optional(),
  notes: z.string().max(2000).optional(),
  createdById: z.string().optional(),
};

export const adjustmentInputSchema = z.object({
  ...baseFields,
  qty: nonZeroDecimal,
  // unitCost: REQUIRED. Caller commits to a per-unit cost at adjustment
  // time (UI pre-fills from current WAC; service does not pull it). Used
  // for movement.unitCost AND the GL leg amount = abs(qty) × unitCost.
  // Zero is allowed (e.g., found stock with no cost basis recorded);
  // negative is not.
  unitCost: nonNegativeDecimal,
  // reason: REQUIRED. Spec (docs/08-gl-costing-reporting.md:97) requires
  // a reason on every adjustment. Routed into audit ctx.reason — not
  // stored as a column on InventoryMovement (audit log is the
  // system-of-record for reasons). Distinct from the optional `notes`
  // free-text on baseFields.
  reason: z.string().min(1).max(2000),
});

export const receiveInputSchema = z.object({
  ...baseFields,
  qty: positiveDecimal,
});

export const consumeInputSchema = z.object({
  ...baseFields,
  qty: positiveDecimal,
});

// reverseReceive accepts a positive qty (the amount to reverse) and writes a
// movement with signed quantity = -qty under type RECEIVE_REVERSE.
export const reverseReceiveInputSchema = z.object({
  ...baseFields,
  qty: positiveDecimal,
});

export const transferInputSchema = z
  .object({
    variantId: z.string().min(1),
    fromWarehouseId: z.string().min(1),
    toWarehouseId: z.string().min(1),
    qty: positiveDecimal,
    reference: z.string().max(255).optional(),
    notes: z.string().max(2000).optional(),
    createdById: z.string().optional(),
  })
  .refine((v) => v.fromWarehouseId !== v.toWarehouseId, {
    message: 'fromWarehouseId and toWarehouseId must differ',
    path: ['toWarehouseId'],
  });

export type AdjustmentInput = z.infer<typeof adjustmentInputSchema>;
export type ReceiveInput = z.infer<typeof receiveInputSchema>;
export type ConsumeInput = z.infer<typeof consumeInputSchema>;
export type TransferInput = z.infer<typeof transferInputSchema>;
export type ReverseReceiveInput = z.infer<typeof reverseReceiveInputSchema>;
