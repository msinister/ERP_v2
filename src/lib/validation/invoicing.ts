import { z } from 'zod';
import { Prisma, PaymentMethod, RmaStatus } from '@/generated/tenant';
import { decimalString } from './common';

// Re-export existing schemas from the credit-memo categories and
// settings/restocking-fee files so callers have one place to import
// invoicing validation from. Don't duplicate definitions — these are
// the canonical schemas.
export {
  createCreditMemoCategoryInputSchema,
  updateCreditMemoCategoryInputSchema,
  type CreateCreditMemoCategoryInput,
  type UpdateCreditMemoCategoryInput,
} from './creditMemoCategories';
export {
  restockingFeeDefaultValueSchema,
  type RestockingFeeDefaultOnDisk,
} from './settings';

// =============================================================================
// Decimal helpers — all comparisons use Prisma.Decimal, NEVER JS Number.
// =============================================================================

const positiveDecimal = decimalString.refine(
  (v) => new Prisma.Decimal(v).greaterThan(0),
  'Must be greater than 0',
);
const nonNegativeDecimal = decimalString.refine(
  (v) => new Prisma.Decimal(v).greaterThanOrEqualTo(0),
  'Must be >= 0',
);
const percentDecimal = decimalString.refine(
  (v) => {
    const d = new Prisma.Decimal(v);
    return d.greaterThanOrEqualTo(0) && d.lessThanOrEqualTo(100);
  },
  'Must be between 0 and 100',
);

// =============================================================================
// Payments
// =============================================================================

const paymentApplicationInputSchema = z.object({
  invoiceId: z.string().min(1),
  amount: positiveDecimal,
});

export const recordPaymentInputSchema = z
  .object({
    customerId: z.string().min(1),
    method: z.nativeEnum(PaymentMethod),
    amount: positiveDecimal,
    currency: z.string().min(3).max(3).optional(),
    receivedAt: z.coerce.date().optional(),
    reference: z.string().max(255).optional(),
    notes: z.string().max(2000).optional(),
    applications: z.array(paymentApplicationInputSchema).optional(),
  })
  .superRefine((data, ctx) => {
    // Sum of application amounts may not exceed the payment amount.
    // Underapplication (sum < amount) is allowed — the remainder
    // becomes unapplied credit on the customer. Overapplication is
    // not — that would mean we're applying more than we received.
    if (data.applications && data.applications.length > 0) {
      const sum = data.applications.reduce(
        (acc, a) => acc.plus(new Prisma.Decimal(a.amount)),
        new Prisma.Decimal(0),
      );
      if (sum.greaterThan(new Prisma.Decimal(data.amount))) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['applications'],
          message: `Sum of applications (${sum.toString()}) exceeds payment amount (${data.amount})`,
        });
      }
    }
    // APPLIED_CREDIT means "consume some of the customer's existing
    // unapplied credit balance and apply it to invoice(s)". An
    // unapplied APPLIED_CREDIT is nonsensical — the whole point is
    // the application.
    if (data.method === PaymentMethod.APPLIED_CREDIT) {
      if (!data.applications || data.applications.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['applications'],
          message:
            "Method APPLIED_CREDIT requires at least one application — applied-credit payments must consume credit by applying to invoices",
        });
      }
    }
  });

export const applyCreditInputSchema = z
  .object({
    paymentId: z.string().min(1).optional(),
    creditMemoId: z.string().min(1).optional(),
    invoiceId: z.string().min(1),
    amount: positiveDecimal,
    notes: z.string().max(2000).optional(),
  })
  .superRefine((data, ctx) => {
    const hasPayment = data.paymentId != null;
    const hasCreditMemo = data.creditMemoId != null;
    if (hasPayment && hasCreditMemo) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['creditMemoId'],
        message: 'Set paymentId OR creditMemoId, not both',
      });
    }
    if (!hasPayment && !hasCreditMemo) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['paymentId'],
        message: 'Exactly one of paymentId or creditMemoId is required',
      });
    }
  });

export const reversePaymentInputSchema = z.object({
  paymentId: z.string().min(1),
  // Reversals always need a reason — accounting trail requires it.
  reason: z.string().min(1).max(2000),
});

// =============================================================================
// Credit memos
// =============================================================================
//
// Math invariant — SUM(line.qty × line.unitPrice) === amount — is
// enforced at the SERVICE LAYER, not here. Same precedent as the SO
// slice: src/lib/validation/sales.ts validates structure only, and
// the service computes / asserts totals. Keeping cross-record math
// out of validation makes the schema testable in isolation and lets
// the service emit specific business errors (e.g., "line totals
// $123 don't match memo amount $122; difference $1") rather than
// generic Zod issues.

const creditMemoLineInputSchema = z.object({
  invoiceLineId: z.string().min(1).optional(),
  variantId: z.string().min(1),
  qty: positiveDecimal,
  unitPrice: nonNegativeDecimal,
  description: z.string().min(1).max(500),
});

export const createCreditMemoInputSchema = z.object({
  customerId: z.string().min(1),
  invoiceId: z.string().min(1).optional(), // omitted for goodwill / bad-debt / standalone
  categoryId: z.string().min(1),
  amount: positiveDecimal,
  restockingFee: nonNegativeDecimal.optional(),
  currency: z.string().min(3).max(3).optional(),
  reason: z.string().max(2000).optional(),
  lines: z.array(creditMemoLineInputSchema).min(1),
});

// DRAFT-only edit input. Mirrors the create schema minus `customerId`
// (immutable after creation — same precedent as VC). Lines, when
// present, replace the existing set wholesale; restockingFee + reason
// + currency + categoryId + invoiceId update in place. The service
// re-validates SUM(line.qty × line.unitPrice) === amount.
export const updateCreditMemoInputSchema = z.object({
  invoiceId: z.string().min(1).nullable().optional(),
  categoryId: z.string().min(1).optional(),
  amount: positiveDecimal.optional(),
  restockingFee: nonNegativeDecimal.optional(),
  currency: z.string().min(3).max(3).optional(),
  reason: z.string().max(2000).nullable().optional(),
  lines: z.array(creditMemoLineInputSchema).min(1).optional(),
});

export const confirmCreditMemoInputSchema = z.object({
  creditMemoId: z.string().min(1),
});

export const voidCreditMemoInputSchema = z.object({
  creditMemoId: z.string().min(1),
  reason: z.string().min(1).max(2000),
});

// =============================================================================
// RMAs
// =============================================================================

const rmaLineInputSchema = z.object({
  invoiceLineId: z.string().min(1),
  qty: positiveDecimal,
  reason: z.string().max(2000).optional(),
});

export const createRmaInputSchema = z
  .object({
    customerId: z.string().min(1),
    invoiceId: z.string().min(1),
    returnless: z.boolean().optional(),
    reason: z.string().max(2000).optional(),
    restockingFeePercent: percentDecimal.optional(),
    restockingFeeFlat: nonNegativeDecimal.optional(),
    lines: z.array(rmaLineInputSchema).min(1),
  })
  .superRefine((data, ctx) => {
    if (data.restockingFeePercent != null && data.restockingFeeFlat != null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['restockingFeeFlat'],
        message: 'Set restockingFeePercent OR restockingFeeFlat, not both',
      });
    }
  });

export const creditFromRmaInputSchema = z.object({
  // Per-line quantities to credit. Each invoiceLineId must match an
  // RmaLine on the RMA, and qty must be <= the matching RmaLine.qty.
  // The service enforces this; the schema is structural only.
  lines: z
    .array(
      z.object({
        invoiceLineId: z.string().min(1),
        qty: positiveDecimal,
        unitPrice: nonNegativeDecimal,
        description: z.string().min(1).max(500),
      }),
    )
    .min(1),
  reason: z.string().max(2000).optional(),
  // Part 3.5: optional CM category. Defaults to RETURN at the service
  // layer for backward compatibility with pre-3.5 callers. Set to
  // SHIPPING_DAMAGE / MANUFACTURER_DEFECT / DAMAGED to drive the loss-
  // reclassification reversal path (DR Loss / CR COGS, no inventory
  // restoration). The service resolves the categoryId from this code.
  categoryId: z.string().min(1).optional(),
});

export const transitionRmaInputSchema = z
  .object({
    rmaId: z.string().min(1),
    to: z.nativeEnum(RmaStatus),
    reason: z.string().max(2000).optional(),
  })
  .superRefine((data, ctx) => {
    // REJECTED is a terminal status with operational consequences
    // (no credit, no inventory effect) — require a reason. Other
    // transitions can carry an optional reason but don't require it.
    if (data.to === RmaStatus.REJECTED) {
      if (!data.reason || data.reason.trim().length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['reason'],
          message: 'Transitioning to REJECTED requires a non-empty reason',
        });
      }
    }
  });

// =============================================================================
// Inferred types
// =============================================================================

export type RecordPaymentInput = z.infer<typeof recordPaymentInputSchema>;
export type ApplyCreditInput = z.infer<typeof applyCreditInputSchema>;
export type ReversePaymentInput = z.infer<typeof reversePaymentInputSchema>;
export type CreateCreditMemoInput = z.infer<typeof createCreditMemoInputSchema>;
export type UpdateCreditMemoInput = z.infer<typeof updateCreditMemoInputSchema>;
export type ConfirmCreditMemoInput = z.infer<typeof confirmCreditMemoInputSchema>;
export type VoidCreditMemoInput = z.infer<typeof voidCreditMemoInputSchema>;
export type CreateRmaInput = z.infer<typeof createRmaInputSchema>;
export type TransitionRmaInput = z.infer<typeof transitionRmaInputSchema>;
export type CreditFromRmaInput = z.infer<typeof creditFromRmaInputSchema>;
