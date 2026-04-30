import { z } from 'zod';

export const createPaymentTermInputSchema = z.object({
  // Short stable identifier (e.g. "NET30"). Uppercased + trimmed by service.
  code: z.string().min(1).max(64),
  label: z.string().min(1).max(255),
  // Net X days for the standard "net" terms; null for COD / Prepay / etc.
  netDays: z.number().int().min(0).max(365).nullable().optional(),
  active: z.boolean().optional(),
});

export const updatePaymentTermInputSchema = z.object({
  label: z.string().min(1).max(255).optional(),
  netDays: z.number().int().min(0).max(365).nullable().optional(),
  active: z.boolean().optional(),
});

export type CreatePaymentTermInput = z.infer<typeof createPaymentTermInputSchema>;
export type UpdatePaymentTermInput = z.infer<typeof updatePaymentTermInputSchema>;
