import { z } from 'zod';
import { Prisma } from '@/generated/tenant';
import { decimalString } from './common';

// =============================================================================
// Account Transfer validation. A transfer moves money between two GL
// accounts (e.g. paying a credit card from a bank account) as a single
// balanced JE: DR <to> / CR <from>. Structural validation only — account
// existence + type (ASSET / LIABILITY) and GL posting live in the service.
// =============================================================================

const positiveAmount = decimalString.refine(
  (v) => new Prisma.Decimal(v).greaterThan(0),
  'Must be greater than 0',
);

export const postAccountTransferInputSchema = z.object({
  fromAccountId: z.string().min(1),
  toAccountId: z.string().min(1),
  amount: positiveAmount,
  date: z.coerce.date().optional(),
  reference: z.string().max(255).optional(),
  notes: z.string().max(2000).optional(),
});

export type PostAccountTransferInput = z.infer<
  typeof postAccountTransferInputSchema
>;
