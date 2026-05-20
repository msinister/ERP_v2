import { z } from 'zod';
import { decimalString } from './common';

const nonNegativeDecimal = decimalString.refine(
  (v) => Number(v) >= 0,
  'Must be >= 0',
);

// The User ↔ SalesRep link is owned by User.salesRepId, not by a column
// on SalesRep. To attach a user to a sales rep, update the User row.
// (The orphan SalesRep.userId placeholder column was dropped in the
// auth-tables migration.)
export const createSalesRepInputSchema = z.object({
  code: z.string().min(1).max(64),
  name: z.string().min(1).max(255),
  email: z.string().email().max(255).optional(),
  active: z.boolean().optional(),
  // Per-rep commission gate. When false the commission engine skips the
  // rep entirely (salaried reps); basis/percent are only meaningful when on.
  commissionEnabled: z.boolean().optional(),
  commissionBasis: z.enum(['REVENUE', 'MARGIN']).nullable().optional(),
  commissionPercent: nonNegativeDecimal.nullable().optional(),
  groupId: z.string().min(1).nullable().optional(),
});

export const updateSalesRepInputSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  email: z.string().email().max(255).nullable().optional(),
  active: z.boolean().optional(),
  commissionEnabled: z.boolean().optional(),
  commissionBasis: z.enum(['REVENUE', 'MARGIN']).nullable().optional(),
  commissionPercent: nonNegativeDecimal.nullable().optional(),
  groupId: z.string().min(1).nullable().optional(),
});

export type CreateSalesRepInput = z.infer<typeof createSalesRepInputSchema>;
export type UpdateSalesRepInput = z.infer<typeof updateSalesRepInputSchema>;
