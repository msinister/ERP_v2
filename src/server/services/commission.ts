import { AuditAction, CommissionBasis, Prisma } from '@/generated/tenant';
import type {
  CommissionAccrual,
  CreditApplication,
  PrismaClient,
} from '@/generated/tenant';
import { audit, type AuditContext } from '@/lib/audit/audit';

// =============================================================================
// Commission engine.
//
// Accrual fires inside recordPayment after each CreditApplication row
// inserts. Reversal fires inside reversePayment after the application
// reversal loop. Both legs run in the same transaction as the parent
// payment mutation — either everything commits or nothing does.
//
// Two basis options per rep:
//   REVENUE: amount = applied × percent / 100
//   MARGIN:  amount = (applied − propCogs) × percent / 100
//            propCogs = (applied / invoice.subtotal) × invoice.cogsAtClose
//
// Reversal writes a negative-amount mirror row (basisAmount and amount
// negate; percent stays positive) and stamps reversedAt on the
// original. Originals are never mutated except for that one field;
// the ledger remains the audit trail.
//
// IMPORTANT — APPLIED_CREDIT skipped: per spec resolution Q1, payments
// of method=APPLIED_CREDIT do NOT accrue commission. The CM that
// funded the credit was almost certainly tied to a refund/return where
// commission was already reversed. Re-accruing on the credit's
// downstream apply would double-count. Caller (recordPayment) is
// responsible for not invoking the accrual function on APPLIED_CREDIT
// applications — this service trusts the gate.
//
// IMPORTANT — GL posting deferred: commission expense JE
// (DR Commission Expense / CR Accrued Commission Payable) is a
// Module 08 follow-up. This slice writes the ledger only; the GL
// integration consumes the ledger when it lands.
// =============================================================================

/**
 * Given a freshly-created CreditApplication of kind PAYMENT_TO_INVOICE,
 * accrue commission for the SO's sales rep if eligible. Returns the
 * accrual row, or null if the rep was ineligible (commissionEnabled
 * false, no percent, no basis) or the invoice has no SO link.
 *
 * Caller MUST gate on application kind: do not invoke for
 * CREDIT_TO_INVOICE applications (APPLIED_CREDIT method path).
 *
 * Input shape avoids re-fetching the application by accepting the
 * fields the caller already has in hand from the just-inserted row.
 */
export async function accrueCommissionForApplicationTx(
  tx: Prisma.TransactionClient,
  app: Pick<CreditApplication, 'id' | 'paymentId' | 'invoiceId' | 'amount'>,
  ctx?: AuditContext,
): Promise<CommissionAccrual | null> {
  if (app.paymentId == null) {
    // Pure CM-to-invoice application (no Payment in the chain) — out
    // of scope for commission accrual.
    return null;
  }

  // Walk Invoice → SO → Customer → SalesRep. Pull cogsAtClose +
  // subtotal in the same query so MARGIN math is one round-trip.
  const invoice = await tx.invoice.findUnique({
    where: { id: app.invoiceId },
    select: {
      id: true,
      subtotal: true,
      cogsAtClose: true,
      salesOrder: {
        select: {
          customer: {
            select: {
              salesRep: {
                select: {
                  id: true,
                  commissionEnabled: true,
                  commissionBasis: true,
                  commissionPercent: true,
                },
              },
            },
          },
        },
      },
    },
  });
  if (!invoice) return null;
  const rep = invoice.salesOrder?.customer?.salesRep;
  if (!rep) return null;
  if (!rep.commissionEnabled) return null;
  if (rep.commissionBasis == null || rep.commissionPercent == null) return null;

  const applied = app.amount; // already Decimal
  const percent = rep.commissionPercent;

  let basisAmount: Prisma.Decimal;
  let amount: Prisma.Decimal;

  if (rep.commissionBasis === CommissionBasis.REVENUE) {
    basisAmount = applied;
    amount = applied.times(percent).dividedBy(100);
  } else {
    // MARGIN: (applied − propCogs) × percent / 100.
    // propCogs = (applied / invoice.subtotal) × invoice.cogsAtClose.
    // Q3 fallback: NULL cogsAtClose treated as 0 for pre-migration
    // closed invoices (test-fixture only).
    const cogsAtClose = invoice.cogsAtClose ?? new Prisma.Decimal(0);
    const subtotal = invoice.subtotal;
    const propCogs = subtotal.greaterThan(0)
      ? applied.dividedBy(subtotal).times(cogsAtClose)
      : new Prisma.Decimal(0);
    basisAmount = applied.minus(propCogs);
    amount = basisAmount.times(percent).dividedBy(100);
  }

  const accrual = await tx.commissionAccrual.create({
    data: {
      salesRepId: rep.id,
      paymentId: app.paymentId,
      invoiceId: app.invoiceId,
      basis: rep.commissionBasis,
      basisAmount,
      percent,
      amount,
      accruedAt: new Date(),
    },
  });

  await audit(tx, {
    action: AuditAction.CREATE,
    entityType: 'CommissionAccrual',
    entityId: accrual.id,
    after: accrual,
    ctx,
  });

  return accrual;
}
