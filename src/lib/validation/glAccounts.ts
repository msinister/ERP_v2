import { z } from 'zod';

const accountTypeEnum = z.enum(['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE']);

export const createGlAccountInputSchema = z.object({
  // Numeric account code per the spec (1000–9999). Stored as string
  // for consistency with future hierarchy / sub-account codes.
  code: z.string().min(1).max(32),
  name: z.string().min(1).max(255),
  type: accountTypeEnum,
  active: z.boolean().optional(),
});

// type and code intentionally NOT updatable. Type changes have GL
// classification implications; code is the stable identifier services
// reference. The full GL slice will add a permissioned reclassify
// path.
export const updateGlAccountInputSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  active: z.boolean().optional(),
});

export type CreateGlAccountInput = z.infer<typeof createGlAccountInputSchema>;
export type UpdateGlAccountInput = z.infer<typeof updateGlAccountInputSchema>;
