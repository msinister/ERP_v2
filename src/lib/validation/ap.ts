import { z } from 'zod';
import { BillSource, Prisma } from '@/generated/tenant';
import { decimalString } from './common';

// =============================================================================
// AP / Bills validation. Structural validation only — cross-record math
// (lineSum === subtotal, GL post correctness, etc.) lives in the service
// per the precedent set by sales.ts and invoicing.ts.
// =============================================================================

const positiveDecimal = decimalString.refine(
  (v) => new Prisma.Decimal(v).greaterThan(0),
  'Must be greater than 0',
);
const nonNegativeDecimal = decimalString.refine(
  (v) => new Prisma.Decimal(v).greaterThanOrEqualTo(0),
  'Must be >= 0',
);

// PRODUCT-source line: variantId required, expenseAccountId forbidden,
// receiptLineId optional. EXPENSE-source line: expenseAccountId
// required, variantId + receiptLineId forbidden. The discriminator is
// the parent bill's source — service-layer enforces consistency
// (line shape must match bill.source). DB CHECK constraint
// (BillLine_source_xor) provides defense-in-depth.
const billLineInputSchema = z
  .object({
    variantId: z.string().min(1).optional(),
    receiptLineId: z.string().min(1).optional(),
    expenseAccountId: z.string().min(1).optional(),
    description: z.string().min(1).max(500),
    qty: positiveDecimal,
    unitCost: nonNegativeDecimal,
    notes: z.string().max(2000).optional(),
  })
  .superRefine((data, ctx) => {
    const hasVariant = data.variantId != null;
    const hasExpense = data.expenseAccountId != null;
    if (hasVariant && hasExpense) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expenseAccountId'],
        message: 'Set variantId OR expenseAccountId, not both',
      });
    }
    if (!hasVariant && !hasExpense) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['variantId'],
        message: 'Exactly one of variantId or expenseAccountId is required',
      });
    }
    if (data.receiptLineId != null && hasExpense) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['receiptLineId'],
        message: 'receiptLineId is only valid on PRODUCT lines',
      });
    }
  });

export const createBillInputSchema = z
  .object({
    vendorId: z.string().min(1),
    source: z.nativeEnum(BillSource).optional(), // defaults to PRODUCT
    vendorReference: z.string().max(255).optional(),
    billDate: z.coerce.date().optional(),
    currency: z.string().min(3).max(3).optional(),
    // Pilot scope: header-level freight/tax must be 0. Per-line landed
    // cost ships in landedCost.ts; header freight/tax handling lands in
    // a future slice with a default-GL-account setting.
    freight: nonNegativeDecimal.optional(),
    tax: nonNegativeDecimal.optional(),
    notes: z.string().max(2000).optional(),
    lines: z.array(billLineInputSchema).min(1),
  })
  .superRefine((data, ctx) => {
    const source = data.source ?? BillSource.PRODUCT;
    for (let i = 0; i < data.lines.length; i++) {
      const line = data.lines[i];
      if (source === BillSource.PRODUCT && line.expenseAccountId != null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['lines', i, 'expenseAccountId'],
          message: 'EXPENSE lines not allowed on a PRODUCT bill',
        });
      }
      if (source === BillSource.EXPENSE && line.variantId != null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['lines', i, 'variantId'],
          message: 'PRODUCT lines not allowed on an EXPENSE bill',
        });
      }
    }
  });

export const updateBillInputSchema = z.object({
  vendorReference: z.string().max(255).nullable().optional(),
  billDate: z.coerce.date().optional(),
  currency: z.string().min(3).max(3).optional(),
  freight: nonNegativeDecimal.optional(),
  tax: nonNegativeDecimal.optional(),
  notes: z.string().max(2000).nullable().optional(),
  // Lines are replace-all when present (not partial patch). Omit to
  // leave existing lines untouched.
  lines: z.array(billLineInputSchema).min(1).optional(),
});

export const cancelBillInputSchema = z.object({
  reason: z.string().min(1).max(2000),
});

export type BillLineInput = z.infer<typeof billLineInputSchema>;
export type CreateBillInput = z.infer<typeof createBillInputSchema>;
export type UpdateBillInput = z.infer<typeof updateBillInputSchema>;
export type CancelBillInput = z.infer<typeof cancelBillInputSchema>;
