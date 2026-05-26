import { z } from 'zod';

// Tag name — trimmed, 1..64 chars. The OrderTag.name column is CITEXT, so
// case-insensitive uniqueness is enforced at the DB level; we just normalize
// whitespace here. Mirrors productTagNameSchema (lib/validation/product.ts).
export const orderTagNameSchema = z
  .string()
  .transform((s) => s.trim())
  .pipe(z.string().min(1).max(64));

// Batch add/remove by name. Used by all per-entity tag PATCH routes
// (currently only /api/sales-orders/[id]/tags — PO/Bill/CM/RMA/WO/VC will
// reuse this same shape when they get tag UIs).
export const orderTagsPatchSchema = z.object({
  add: z.array(z.string()).optional(),
  remove: z.array(z.string()).optional(),
});

export type OrderTagsPatchInput = z.infer<typeof orderTagsPatchSchema>;
