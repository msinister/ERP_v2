import { z } from 'zod';

// Code is immutable post-creation: service-layer logic (e.g., the
// credit-memo-confirmation path that checks affectsInventory) doesn't
// reference codes directly today, but seed rows + future imports +
// admin-managed JE rules will. Allowing rename retroactively would
// break the link between historical memos and category-driven rules.
const codeRegex = /^[A-Z0-9_]+$/;

export const createCreditMemoCategoryInputSchema = z.object({
  code: z
    .string()
    .min(1)
    .max(50)
    .regex(codeRegex, 'Code must be uppercase alphanumeric + underscore'),
  label: z.string().min(1).max(255),
  affectsInventory: z.boolean().optional(),
  active: z.boolean().optional(),
});

// `code` intentionally NOT in the update shape — immutable.
export const updateCreditMemoCategoryInputSchema = z.object({
  label: z.string().min(1).max(255).optional(),
  affectsInventory: z.boolean().optional(),
  active: z.boolean().optional(),
});

export type CreateCreditMemoCategoryInput = z.infer<typeof createCreditMemoCategoryInputSchema>;
export type UpdateCreditMemoCategoryInput = z.infer<typeof updateCreditMemoCategoryInputSchema>;
