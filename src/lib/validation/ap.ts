import { z } from 'zod';
import { BillSource, PaymentMethod, Prisma } from '@/generated/tenant';
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
    // Optional at the line level. Required for EXPENSE lines via the
    // parent superRefine on createBillInputSchema (where the bill's
    // source is known). On PRODUCT lines the variant is the primary
    // identifier; description is optional context.
    description: z.string().max(500).optional(),
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
      // EXPENSE lines must carry a description (expense account alone
      // isn't enough context). PRODUCT lines may omit it — variant
      // name already identifies the item.
      if (
        source === BillSource.EXPENSE &&
        (line.description == null || line.description.trim() === '')
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['lines', i, 'description'],
          message: 'description is required on EXPENSE lines',
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

// =============================================================================
// Bill payments
// =============================================================================
//
// APPLIED_CREDIT is NOT a valid method for BillPayment — vendor credit
// applications flow through applyVendorCreditToBill (its own service)
// with their own JE pair, not as a BillPayment row. Restricting at
// validation time prevents accidental misuse.

const billPaymentMethodSchema = z
  .nativeEnum(PaymentMethod)
  .refine((m) => m !== PaymentMethod.APPLIED_CREDIT, {
    message:
      'APPLIED_CREDIT is not valid for bill payments — apply vendor credits via /api/vendor-credits/[id]/apply',
  });

export const recordBillPaymentInputSchema = z.object({
  billId: z.string().min(1),
  amount: decimalString.refine(
    (v) => new Prisma.Decimal(v).greaterThan(0),
    'Must be greater than 0',
  ),
  method: billPaymentMethodSchema,
  // FK to a GlAccount of type=ASSET (typically 1110 Cash/Bank). Service
  // validates type. Optional at the DB level for record-only entries
  // missing bank-account specification, but the service requires it
  // for non-zero amounts because the JE needs an account to credit.
  cashAccountId: z.string().min(1),
  paymentDate: z.coerce.date().optional(),
  reference: z.string().max(255).optional(),
  notes: z.string().max(2000).optional(),
});

export const reverseBillPaymentInputSchema = z.object({
  // Reversals always need a reason — accounting trail requires it.
  reason: z.string().min(1).max(2000),
});

export type RecordBillPaymentInput = z.infer<typeof recordBillPaymentInputSchema>;
export type ReverseBillPaymentInput = z.infer<typeof reverseBillPaymentInputSchema>;

// =============================================================================
// Vendor credits
// =============================================================================
//
// Lines are simple expense-style (description + amount) per pilot Q6.
// Math invariant — SUM(line.amount) === amount — is enforced at the
// SERVICE LAYER, not here (same precedent as createCreditMemoInputSchema).

const vendorCreditLineInputSchema = z.object({
  description: z.string().min(1).max(500),
  amount: decimalString.refine(
    (v) => new Prisma.Decimal(v).greaterThan(0),
    'Must be greater than 0',
  ),
  notes: z.string().max(2000).optional(),
});

export const createVendorCreditInputSchema = z.object({
  vendorId: z.string().min(1),
  // Optional — when omitted, the service derives the amount from
  // SUM(line.amount). The form sends nothing for amount so the
  // total is always exactly the line sum. Direct API callers may
  // still pass amount; the service then validates it matches the
  // line sum (strict-validation path preserved for scripts/imports).
  amount: decimalString
    .refine(
      (v) => new Prisma.Decimal(v).greaterThan(0),
      'Must be greater than 0',
    )
    .optional(),
  creditDate: z.coerce.date().optional(),
  currency: z.string().min(3).max(3).optional(),
  reason: z.string().max(2000).optional(),
  notes: z.string().max(2000).optional(),
  lines: z.array(vendorCreditLineInputSchema).min(1),
});

export const updateVendorCreditInputSchema = z.object({
  amount: decimalString
    .refine((v) => new Prisma.Decimal(v).greaterThan(0), 'Must be greater than 0')
    .optional(),
  creditDate: z.coerce.date().optional(),
  reason: z.string().max(2000).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  lines: z.array(vendorCreditLineInputSchema).min(1).optional(),
});

export const cancelVendorCreditInputSchema = z.object({
  reason: z.string().min(1).max(2000),
});

export const applyVendorCreditInputSchema = z.object({
  billId: z.string().min(1),
  amount: decimalString.refine(
    (v) => new Prisma.Decimal(v).greaterThan(0),
    'Must be greater than 0',
  ),
  notes: z.string().max(2000).optional(),
});

export type VendorCreditLineInput = z.infer<typeof vendorCreditLineInputSchema>;
export type CreateVendorCreditInput = z.infer<typeof createVendorCreditInputSchema>;
export type UpdateVendorCreditInput = z.infer<typeof updateVendorCreditInputSchema>;
export type CancelVendorCreditInput = z.infer<typeof cancelVendorCreditInputSchema>;
export type ApplyVendorCreditInput = z.infer<typeof applyVendorCreditInputSchema>;
