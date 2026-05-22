import { z } from 'zod';
import { Prisma } from '@/generated/tenant';
import { decimalString } from './common';

// =============================================================================
// Quick Expense Logger validation. An "expense" is sugar over the AP flow:
// it creates an EXPENSE-source bill (auto-confirmed) and records a payment
// against a chosen GL account in one atomic step. Structural validation
// only — vendor resolution, GL posting, and balance math live in the
// service (services/expenses.ts).
// =============================================================================

const positiveAmount = decimalString.refine(
  (v) => new Prisma.Decimal(v).greaterThan(0),
  'Must be greater than 0',
);

export const logExpenseInputSchema = z
  .object({
    // Exactly one vendor identifier is required:
    //   vendorId   — single-entry form (picked / inline-created via the
    //                VendorPicker, already resolved to an id)
    //   vendorName — bulk paste (free-text from a spreadsheet → the
    //                service find-or-creates a SERVICE vendor by name)
    vendorId: z.string().min(1).optional(),
    vendorName: z.string().min(1).max(255).optional(),
    amount: positiveAmount,
    expenseAccountId: z.string().min(1),
    paymentAccountId: z.string().min(1),
    date: z.coerce.date().optional(),
    notes: z.string().max(2000).optional(),
  })
  .refine(
    (d) =>
      (d.vendorId != null && d.vendorId.trim() !== '') ||
      (d.vendorName != null && d.vendorName.trim() !== ''),
    { message: 'Provide a vendor', path: ['vendorName'] },
  );

export type LogExpenseInput = z.infer<typeof logExpenseInputSchema>;

// Bulk paste: a shared payment account for every row (selected once at the
// top of the bulk UI) plus the per-row data. The service expands each row
// into a full LogExpenseInput with the shared paymentAccountId.
export const logExpenseBatchInputSchema = z.object({
  paymentAccountId: z.string().min(1),
  rows: z
    .array(
      z.object({
        vendorName: z.string().min(1).max(255),
        amount: positiveAmount,
        expenseAccountId: z.string().min(1),
        date: z.coerce.date().optional(),
        notes: z.string().max(2000).optional(),
      }),
    )
    .min(1, 'At least one row is required')
    // Pilot ceiling — a pasted bank statement won't realistically exceed
    // this, and it caps the single-transaction batch size.
    .max(500, 'Too many rows in one batch (max 500)'),
});

export type LogExpenseBatchInput = z.infer<typeof logExpenseBatchInputSchema>;
