import { AuditAction, CommissionBasis, Prisma } from '@/generated/tenant';
import type {
  CommissionAccrual,
  CreditApplication,
  PrismaClient,
} from '@/generated/tenant';
import { audit, type AuditContext } from '@/lib/audit/audit';
import {
  SETTING_KEYS,
  commissionPayoutCycleValueSchema,
  type CommissionPayoutCycleOnDisk,
} from '@/lib/validation/settings';

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
 * Resolve the EFFECTIVE rep for commission on a sales order: the
 * per-order override (SalesOrder.salesRepId) when set, otherwise the
 * customer's default rep. Pure + generic over the rep shape so it's unit-
 * testable without a DB. Returns null when there's no SO or no rep.
 */
export function pickEffectiveCommissionRep<R>(
  so:
    | {
        salesRepId: string | null;
        salesRep: R | null;
        customer: { salesRep: R | null };
      }
    | null
    | undefined,
): R | null {
  if (!so) return null;
  return so.salesRepId ? so.salesRep : so.customer.salesRep;
}

/**
 * Given a freshly-created CreditApplication of kind PAYMENT_TO_INVOICE,
 * accrue commission for the SO's EFFECTIVE sales rep if eligible (the
 * per-order override when set, else the customer's default — see
 * pickEffectiveCommissionRep). Returns the accrual row, or null if the
 * rep was ineligible (commissionEnabled false, no percent, no basis) or
 * the invoice has no SO link.
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

  // Walk Invoice → SO → effective rep (per-order override, else the
  // customer's default). Pull both rep candidates + cogsAtClose +
  // subtotal in the same query so MARGIN math is one round-trip.
  const repSelect = {
    select: {
      id: true,
      commissionEnabled: true,
      commissionBasis: true,
      commissionPercent: true,
    },
  } as const;
  const invoice = await tx.invoice.findUnique({
    where: { id: app.invoiceId },
    select: {
      id: true,
      subtotal: true,
      cogsAtClose: true,
      salesOrder: {
        select: {
          salesRepId: true,
          salesRep: repSelect,
          customer: { select: { salesRep: repSelect } },
        },
      },
    },
  });
  if (!invoice) return null;
  const rep = pickEffectiveCommissionRep(invoice.salesOrder);
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

// ---------------------------------------------------------------------------
// Reversal
// ---------------------------------------------------------------------------

/**
 * For every non-reversed CommissionAccrual rooted at sourcePaymentId,
 * write a negative-amount mirror row pointing back via
 * reversedByPaymentId, and stamp reversedAt on the original. Original
 * rows are NEVER mutated except for that one field — the audit trail
 * is the sequence of rows.
 *
 * Per Q5: amount and basisAmount negate; percent stays positive; basis
 * carries from the original. Mirror rows are NEVER candidates for
 * further reversal — their reversedAt stays NULL by construction.
 *
 * `triggeringPaymentId` is the payment whose reversal triggered this
 * call. For self-payment reversals (the only path today) it's the
 * same as `sourcePaymentId`. Future RMA-driven reversals will pass a
 * different id (out of scope this slice — flagged in commission.ts
 * header).
 *
 * Returns the mirror rows created (zero if no live accruals to
 * reverse — idempotent against re-call).
 */
export async function reverseCommissionForPaymentTx(
  tx: Prisma.TransactionClient,
  sourcePaymentId: string,
  triggeringPaymentId: string,
  ctx?: AuditContext,
): Promise<CommissionAccrual[]> {
  const live = await tx.commissionAccrual.findMany({
    where: {
      paymentId: sourcePaymentId,
      reversedAt: null,
      // A reversal mirror row points back via reversedByPaymentId. We
      // only want originals; mirror rows have a non-null
      // reversedByPaymentId that disqualifies them from being
      // reversed in turn.
      reversedByPaymentId: null,
    },
  });
  if (live.length === 0) return [];

  const now = new Date();
  const mirrors: CommissionAccrual[] = [];
  for (const orig of live) {
    const mirror = await tx.commissionAccrual.create({
      data: {
        salesRepId: orig.salesRepId,
        paymentId: orig.paymentId,
        invoiceId: orig.invoiceId,
        basis: orig.basis,
        basisAmount: orig.basisAmount.negated(),
        percent: orig.percent,
        amount: orig.amount.negated(),
        accruedAt: now,
        reversedByPaymentId: triggeringPaymentId,
      },
    });
    await tx.commissionAccrual.update({
      where: { id: orig.id },
      data: { reversedAt: now },
    });
    await audit(tx, {
      action: AuditAction.REVERSE,
      entityType: 'CommissionAccrual',
      entityId: orig.id,
      before: { reversedAt: null },
      after: {
        reversedAt: now,
        mirrorAccrualId: mirror.id,
        triggeringPaymentId,
      },
      ctx,
    });
    mirrors.push(mirror);
  }
  return mirrors;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export type CommissionReportRow = {
  salesRepId: string;
  salesRepCode: string;
  salesRepName: string;
  earned: Prisma.Decimal;   // sum positive accruedAt < cycle window start
  pending: Prisma.Decimal;  // sum positive accruedAt >= cycle window start
  reversed: Prisma.Decimal; // sum of negative mirror amounts (always <= 0)
  net: Prisma.Decimal;      // earned + pending + reversed
};

export type CommissionReportFilters = {
  salesRepId?: string;
  from?: Date; // accruedAt >= from (inclusive)
  to?: Date;   // accruedAt <  to (exclusive)
};

/**
 * Per-rep aggregation across the date window. The earned/pending split
 * is driven by the commission_payout_cycle Setting:
 *
 *   - Setting missing or schema-invalid → graceful no-op: every
 *     positive accrual counts as `earned`; pending = 0.
 *   - Setting present → compute the start of the current open cycle
 *     window (relative to `now()` at call time). Accruals inside
 *     [openCycleStart, +∞) are pending; accruals before are earned.
 *
 * The `from` / `to` filter applies BEFORE the earned/pending split,
 * so callers can scope a report to a specific period independently
 * of the payout cycle.
 *
 * Reversed column: positive accruals' reversedAt is informational
 * only — they still appear in `earned`/`pending` per their accruedAt.
 * The negative mirror rows are summed into `reversed`. `net` is the
 * arithmetic sum of all three columns.
 *
 * Salaried reps (commissionEnabled=false) appear ONLY if they have
 * accruals in the window. Reps with no accruals are omitted entirely.
 */
export async function getCommissionReport(
  db: PrismaClient,
  filters: CommissionReportFilters = {},
): Promise<CommissionReportRow[]> {
  const dateWhere: { gte?: Date; lt?: Date } = {};
  if (filters.from) dateWhere.gte = filters.from;
  if (filters.to) dateWhere.lt = filters.to;

  const accruals = await db.commissionAccrual.findMany({
    where: {
      ...(filters.salesRepId ? { salesRepId: filters.salesRepId } : {}),
      ...(filters.from || filters.to ? { accruedAt: dateWhere } : {}),
    },
    include: {
      salesRep: { select: { id: true, code: true, name: true } },
    },
  });

  const cycleStart = await loadOpenCycleStart(db, new Date());

  // Bucket per salesRepId.
  type Bucket = {
    salesRepId: string;
    code: string;
    name: string;
    earned: Prisma.Decimal;
    pending: Prisma.Decimal;
    reversed: Prisma.Decimal;
  };
  const byRep = new Map<string, Bucket>();
  for (const a of accruals) {
    let bucket = byRep.get(a.salesRepId);
    if (!bucket) {
      bucket = {
        salesRepId: a.salesRepId,
        code: a.salesRep.code,
        name: a.salesRep.name,
        earned: new Prisma.Decimal(0),
        pending: new Prisma.Decimal(0),
        reversed: new Prisma.Decimal(0),
      };
      byRep.set(a.salesRepId, bucket);
    }
    if (a.amount.lessThan(0)) {
      bucket.reversed = bucket.reversed.plus(a.amount);
      continue;
    }
    if (cycleStart != null && a.accruedAt.getTime() >= cycleStart.getTime()) {
      bucket.pending = bucket.pending.plus(a.amount);
    } else {
      bucket.earned = bucket.earned.plus(a.amount);
    }
  }

  const rows: CommissionReportRow[] = Array.from(byRep.values()).map((b) => ({
    salesRepId: b.salesRepId,
    salesRepCode: b.code,
    salesRepName: b.name,
    earned: b.earned,
    pending: b.pending,
    reversed: b.reversed,
    net: b.earned.plus(b.pending).plus(b.reversed),
  }));
  rows.sort((a, b) => a.salesRepCode.localeCompare(b.salesRepCode));
  return rows;
}

// Compute the start of the current open payout cycle (the boundary
// between `earned` and `pending`). Returns null when the setting is
// missing OR fails schema validation — caller treats null as "no
// cycle, everything is earned." Mirrors the resolver's tier-discount
// graceful-no-op pattern (Q2 = option c).
async function loadOpenCycleStart(
  db: PrismaClient,
  now: Date,
): Promise<Date | null> {
  const row = await db.setting.findUnique({
    where: { key: SETTING_KEYS.COMMISSION_PAYOUT_CYCLE },
  });
  if (!row) return null;
  const parsed = commissionPayoutCycleValueSchema.safeParse(row.value);
  if (!parsed.success) return null;
  const cfg: CommissionPayoutCycleOnDisk = parsed.data;
  return computeOpenCycleStart(cfg, now);
}

// Pure function — exported for tests if needed; not in the module's
// public API surface.
function computeOpenCycleStart(
  cfg: CommissionPayoutCycleOnDisk,
  now: Date,
): Date {
  const today = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  if (cfg.kind === 'MONTHLY') {
    const anchor = cfg.anchorDay ?? 1;
    // Open cycle starts on the most recent anchor day that is <= today.
    const candidate = new Date(
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), anchor),
    );
    if (candidate.getTime() > today.getTime()) {
      return new Date(
        Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, anchor),
      );
    }
    return candidate;
  }
  // WEEKLY / BI_WEEKLY share the same week-anchor walk; BI_WEEKLY just
  // doubles the cycle length. Anchor = day-of-week 0..6 (Sunday=0).
  const anchorDow = cfg.anchorDay ?? 1; // default Monday
  const todayDow = today.getUTCDay();
  const daysSinceAnchor = (todayDow - anchorDow + 7) % 7;
  const lastAnchor = new Date(today);
  lastAnchor.setUTCDate(today.getUTCDate() - daysSinceAnchor);
  if (cfg.kind === 'BI_WEEKLY') {
    // Snap to the most recent EVEN-week anchor by epoch-week parity.
    // Two-week period = 14 days = 14*ONE_DAY_MS.
    const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000;
    const periodIndex = Math.floor(lastAnchor.getTime() / TWO_WEEKS_MS);
    const evenAnchor = new Date(periodIndex * TWO_WEEKS_MS);
    return evenAnchor;
  }
  return lastAnchor;
}
