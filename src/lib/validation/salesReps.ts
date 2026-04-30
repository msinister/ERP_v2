import { z } from 'zod';
import { decimalString } from './common';

const nonNegativeDecimal = decimalString.refine(
  (v) => Number(v) >= 0,
  'Must be >= 0',
);

export const createSalesRepInputSchema = z.object({
  code: z.string().min(1).max(64),
  name: z.string().min(1).max(255),
  email: z.string().email().max(255).optional(),
  active: z.boolean().optional(),
  // Reserved for future User-model link.
  userId: z.string().min(1).optional(),
  commissionBasis: z.enum(['REVENUE', 'MARGIN']).nullable().optional(),
  commissionPercent: nonNegativeDecimal.nullable().optional(),
  groupId: z.string().min(1).nullable().optional(),
});

export const updateSalesRepInputSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  email: z.string().email().max(255).nullable().optional(),
  active: z.boolean().optional(),
  userId: z.string().min(1).nullable().optional(),
  commissionBasis: z.enum(['REVENUE', 'MARGIN']).nullable().optional(),
  commissionPercent: nonNegativeDecimal.nullable().optional(),
  groupId: z.string().min(1).nullable().optional(),
});

export type CreateSalesRepInput = z.infer<typeof createSalesRepInputSchema>;
export type UpdateSalesRepInput = z.infer<typeof updateSalesRepInputSchema>;
