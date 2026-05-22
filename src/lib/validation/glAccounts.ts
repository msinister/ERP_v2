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

// `code` stays NOT updatable — it's the stable identifier services
// reference (e.g. findByCode('2030'), the AP_ACCOUNT/VENDOR_CREDITS
// constants). `type` IS updatable (reclassify), but the service gates
// it: a type change is refused if any journal-entry line on the account
// falls in a HARD_CLOSED fiscal period, since reclassifying retroactively
// changes how every historical JE on the account is reported. Audited via
// the standard before/after diff.
export const updateGlAccountInputSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  type: accountTypeEnum.optional(),
  active: z.boolean().optional(),
});

export type CreateGlAccountInput = z.infer<typeof createGlAccountInputSchema>;
export type UpdateGlAccountInput = z.infer<typeof updateGlAccountInputSchema>;
