import {
  AuditAction,
  FiscalPeriodStatus,
  Prisma,
} from '@/generated/tenant';
import type {
  FiscalPeriod,
  PrismaClient,
} from '@/generated/tenant';
import { audit, type AuditContext } from '@/lib/audit/audit';

// =============================================================================
// FiscalPeriod service. Spec: docs/08-gl-costing-reporting.md#period-close.
//
// Pilot: monthly periods only. Quarterly/yearly aggregations come from
// monthly rollups at report time, not stored as separate records.
//
// Lifecycle:
//   OPEN         — accepts JE posts freely.
//   SOFT_CLOSED  — still accepts posts (tightened later by permissions
//                  slice). Marks the month as "closed for normal users."
//   HARD_CLOSED  — assertPostingAllowedTx blocks unless caller supplies
//                  override with reason. Override fires MANUAL_JE_POSTED
//                  audit row tied to the period.
//
// Auto-creation: getOrCreatePeriodForDateTx creates the period the first
// time a JE is posted into that month. UPSERT on the unique `code` is
// race-safe across concurrent posts.
// =============================================================================

type ClientLike = PrismaClient | Prisma.TransactionClient;

// ---------------------------------------------------------------------------
// Date math
// ---------------------------------------------------------------------------

/** Returns the YYYY-MM code for a Date (UTC). */
export function periodCodeForDate(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

/** Half-open [startDate, endDate) for the month containing `date`. */
export function periodBoundsForDate(date: Date): { startDate: Date; endDate: Date } {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth(); // 0-indexed
  const startDate = new Date(Date.UTC(y, m, 1));
  // Date.UTC handles the year-rollover when m=11 → Date.UTC(y, 12, 1) = y+1-Jan-01.
  const endDate = new Date(Date.UTC(y, m + 1, 1));
  return { startDate, endDate };
}

// ---------------------------------------------------------------------------
// getOrCreatePeriodForDate
// ---------------------------------------------------------------------------

/**
 * Lazy auto-creation. Returns the period containing `date`, creating it
 * via UPSERT if missing. Race-safe: concurrent calls for the same month
 * land on the unique `code` index — one wins the create, the others
 * read the existing row.
 *
 * Tx variant — used by assertPostingAllowedTx (which runs inside the
 * caller's post() transaction). Public wrapper opens its own tx.
 */
export async function getOrCreatePeriodForDateTx(
  tx: Prisma.TransactionClient,
  date: Date,
): Promise<FiscalPeriod> {
  const code = periodCodeForDate(date);
  const { startDate, endDate } = periodBoundsForDate(date);
  // upsert by unique code is the simplest race-safe path. update is a
  // no-op (only `updatedAt` shifts when Prisma writes the empty data
  // block) — we don't want to flip status or any other field on every
  // post that lands in the same period.
  return tx.fiscalPeriod.upsert({
    where: { code },
    create: { code, startDate, endDate },
    update: {},
  });
}

export async function getOrCreatePeriodForDate(
  db: PrismaClient,
  date: Date,
): Promise<FiscalPeriod> {
  return db.$transaction((tx) => getOrCreatePeriodForDateTx(tx, date));
}

// ---------------------------------------------------------------------------
// assertPostingAllowedTx — gate helper called from lib/gl/post.ts
// ---------------------------------------------------------------------------

export type PostingOverride = {
  reason: string;
  userId?: string | null;
};

/**
 * Validates that a JE may be posted into the period containing `postedAt`.
 *
 *   OPEN         — allowed.
 *   SOFT_CLOSED  — allowed (per Q4 sign-off; permissions slice tightens).
 *   HARD_CLOSED  — blocked unless `override` is supplied. When override
 *                  fires, a MANUAL_JE_POSTED audit row is written tied
 *                  to the FiscalPeriod, capturing reason + userId.
 *
 * Returns the resolved (and possibly auto-created) period for caller
 * convenience. Auto-creates via getOrCreatePeriodForDateTx so a fresh
 * tenant DB doesn't need a period-bootstrap step.
 */
export async function assertPostingAllowedTx(
  tx: Prisma.TransactionClient,
  postedAt: Date,
  override?: PostingOverride,
): Promise<FiscalPeriod> {
  const period = await getOrCreatePeriodForDateTx(tx, postedAt);

  if (period.status === FiscalPeriodStatus.HARD_CLOSED) {
    if (!override || !override.reason || override.reason.trim().length === 0) {
      throw new Error(
        `Cannot post to HARD_CLOSED period ${period.code}. Reopen the period or supply a closedPeriodOverride with a non-empty reason.`,
      );
    }
    await audit(tx, {
      action: AuditAction.MANUAL_JE_POSTED,
      entityType: 'FiscalPeriod',
      entityId: period.id,
      after: {
        periodCode: period.code,
        postedAt: postedAt.toISOString(),
        reason: override.reason,
      },
      ctx: {
        userId: override.userId ?? null,
        reason: override.reason,
      },
    });
  }

  return period;
}

// ---------------------------------------------------------------------------
// listPeriods
// ---------------------------------------------------------------------------

export type ListPeriodsFilters = {
  status?: FiscalPeriodStatus;
  year?: number; // filters by code prefix YYYY-
  skip?: number;
  take?: number;
};

export async function listPeriods(
  db: PrismaClient,
  filters: ListPeriodsFilters = {},
): Promise<FiscalPeriod[]> {
  const { status, year, skip = 0, take = 100 } = filters;
  return db.fiscalPeriod.findMany({
    where: {
      ...(status ? { status } : {}),
      ...(year ? { code: { startsWith: `${year}-` } } : {}),
    },
    orderBy: { startDate: 'desc' },
    skip,
    take: Math.min(take, 500),
  });
}

export async function getPeriod(
  db: PrismaClient,
  periodId: string,
): Promise<FiscalPeriod | null> {
  return db.fiscalPeriod.findUnique({ where: { id: periodId } });
}

// ---------------------------------------------------------------------------
// softClosePeriod
// ---------------------------------------------------------------------------

/**
 * OPEN → SOFT_CLOSED. SOFT_CLOSED still accepts posts in pilot scope;
 * the status is informational until the permissions slice gates it.
 */
export async function softClosePeriod(
  db: PrismaClient,
  periodId: string,
  ctx?: AuditContext,
): Promise<FiscalPeriod> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT 1 FROM "FiscalPeriod" WHERE "id" = ${periodId} FOR UPDATE`;
    const before = await tx.fiscalPeriod.findUnique({ where: { id: periodId } });
    if (!before) throw new Error(`FiscalPeriod not found: ${periodId}`);
    if (before.status === FiscalPeriodStatus.SOFT_CLOSED) {
      throw new Error(`Period ${before.code} is already SOFT_CLOSED`);
    }
    if (before.status === FiscalPeriodStatus.HARD_CLOSED) {
      throw new Error(
        `Period ${before.code} is HARD_CLOSED — cannot soft-close (already past soft). Reopen first.`,
      );
    }
    const now = new Date();
    const after = await tx.fiscalPeriod.update({
      where: { id: periodId },
      data: {
        status: FiscalPeriodStatus.SOFT_CLOSED,
        closedAt: now,
        closedById: ctx?.userId ?? null,
        // Reopen fields stay as-is — the prior reopen history (if any)
        // is in the audit log, not on the row.
      },
    });
    await audit(tx, {
      action: AuditAction.PERIOD_CLOSED,
      entityType: 'FiscalPeriod',
      entityId: periodId,
      before: { status: before.status },
      after: { status: after.status, closedAt: after.closedAt },
      ctx,
    });
    return after;
  });
}

// ---------------------------------------------------------------------------
// hardClosePeriod
// ---------------------------------------------------------------------------

export type HardCloseOptions = {
  // When supplied, recon discrepancies do NOT block the close. Reason
  // is mandatory and recorded in the audit row. Slice D adds the recon
  // gate; for slice A, this option is wired for forward compatibility
  // but no recon is run yet.
  forceCloseWithDiscrepancies?: { reason: string };
};

/**
 * OPEN | SOFT_CLOSED → HARD_CLOSED. From here, posting requires an
 * override. Slice D will add a reconciliation-checks gate that this
 * function calls before flipping status.
 */
export async function hardClosePeriod(
  db: PrismaClient,
  periodId: string,
  options: HardCloseOptions = {},
  ctx?: AuditContext,
): Promise<FiscalPeriod> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT 1 FROM "FiscalPeriod" WHERE "id" = ${periodId} FOR UPDATE`;
    const before = await tx.fiscalPeriod.findUnique({ where: { id: periodId } });
    if (!before) throw new Error(`FiscalPeriod not found: ${periodId}`);
    if (before.status === FiscalPeriodStatus.HARD_CLOSED) {
      throw new Error(`Period ${before.code} is already HARD_CLOSED`);
    }

    // Slice-D hook: runAllReconChecksTx + gate goes here. Calling code
    // already passes `options.forceCloseWithDiscrepancies` for forward
    // compatibility; the gate isn't enforced yet.
    void options;

    const now = new Date();
    const after = await tx.fiscalPeriod.update({
      where: { id: periodId },
      data: {
        status: FiscalPeriodStatus.HARD_CLOSED,
        closedAt: now,
        closedById: ctx?.userId ?? null,
      },
    });
    await audit(tx, {
      action: AuditAction.PERIOD_CLOSED,
      entityType: 'FiscalPeriod',
      entityId: periodId,
      before: { status: before.status },
      after: { status: after.status, closedAt: after.closedAt },
      ctx,
    });
    return after;
  });
}

// ---------------------------------------------------------------------------
// reopenPeriod
// ---------------------------------------------------------------------------

/**
 * SOFT_CLOSED | HARD_CLOSED → OPEN. Reason is mandatory.
 */
export async function reopenPeriod(
  db: PrismaClient,
  periodId: string,
  reason: string,
  ctx?: AuditContext,
): Promise<FiscalPeriod> {
  if (!reason || reason.trim().length === 0) {
    throw new Error('reopenPeriod requires a non-empty reason');
  }
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT 1 FROM "FiscalPeriod" WHERE "id" = ${periodId} FOR UPDATE`;
    const before = await tx.fiscalPeriod.findUnique({ where: { id: periodId } });
    if (!before) throw new Error(`FiscalPeriod not found: ${periodId}`);
    if (before.status === FiscalPeriodStatus.OPEN) {
      throw new Error(`Period ${before.code} is already OPEN`);
    }
    const now = new Date();
    const after = await tx.fiscalPeriod.update({
      where: { id: periodId },
      data: {
        status: FiscalPeriodStatus.OPEN,
        // Clear closedAt so the next close re-stamps cleanly. Audit log
        // preserves the prior close timestamp.
        closedAt: null,
        closedById: null,
        reopenedAt: now,
        reopenedById: ctx?.userId ?? null,
        reopenReason: reason,
      },
    });
    await audit(tx, {
      action: AuditAction.PERIOD_REOPENED,
      entityType: 'FiscalPeriod',
      entityId: periodId,
      before: { status: before.status, closedAt: before.closedAt },
      after: { status: after.status, reopenedAt: after.reopenedAt },
      ctx: { ...ctx, reason },
    });
    return after;
  });
}
