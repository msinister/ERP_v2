import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AccountType,
  AuditAction,
  Prisma,
} from '@/generated/tenant';
import type { GlAccount, PrismaClient } from '@/generated/tenant';
import { post } from '@/lib/gl/post';
import {
  getOrCreatePeriodForDate,
  hardClosePeriod,
  reopenPeriod,
} from '@/server/services/fiscalPeriods';
import {
  listReconChecksForPeriod,
  runAllReconChecks,
} from '@/server/services/reconciliation';
import { hasTenantDb, makeClient } from '../helpers/db';

const suite = hasTenantDb ? describe : describe.skip;

// Test isolation: dedicated TEST GL accounts (different ones from
// reports.financial.test.ts to avoid cross-suite cross-talk under
// parallel execution) + test year 2097 (also distinct from other test
// suites at 2098/2099).
const TEST_YEAR = 2097;
const ENTITY_TYPE = 'TestRecon';
const ACCT_AR = '1210'; // recon hardcodes 1210 for AR_CONTROL
const ACCT_AP = '2010';
const ACCT_CASH = '1110';
const ACCT_ACCRUED = '2020';
// Recon checks against these system accounts. We can't use isolated
// codes — the recon service hardcodes them per spec.

function dateInMonth(month: number, day: number = 15): Date {
  return new Date(Date.UTC(TEST_YEAR, month - 1, day, 12));
}

const FORCE_CLOSE = {
  forceCloseWithDiscrepancies: { reason: 'recon-test bypass' },
};

suite('Reconciliation checks (slice D)', () => {
  let db: PrismaClient;
  // GlAccount fixtures captured for ID-level lookups in assertions.
  let arAccount: GlAccount;
  let apAccount: GlAccount;
  let cashAccount: GlAccount;
  let accruedAccount: GlAccount;

  beforeAll(async () => {
    db = makeClient();
    arAccount = await db.glAccount.findFirstOrThrow({ where: { code: ACCT_AR } });
    apAccount = await db.glAccount.findFirstOrThrow({ where: { code: ACCT_AP } });
    cashAccount = await db.glAccount.findFirstOrThrow({ where: { code: ACCT_CASH } });
    accruedAccount = await db.glAccount.findFirstOrThrow({
      where: { code: ACCT_ACCRUED },
    });
    void arAccount;
    void apAccount;
    void cashAccount;
    void accruedAccount;
  });

  beforeEach(async () => {
    await wipe();
  });

  afterAll(async () => {
    await wipe();
    await db.$disconnect();
  });

  // -------------------------------------------------------------------------
  // runAllReconChecks structural shape + persistence + audit
  // -------------------------------------------------------------------------

  it('runAllReconChecks returns one row per check, persists them, writes RECONCILIATION_RUN audit', async () => {
    const period = await getOrCreatePeriodForDate(db, dateInMonth(6));
    const results = await runAllReconChecks(db, period.id);

    // Canonical order: AR, AP, INVENTORY*, CASH, ACCRUED_RECEIPTS.
    expect(results[0].checkType).toBe('AR_CONTROL');
    expect(results[1].checkType).toBe('AP_CONTROL');
    // Last two should be CASH then ACCRUED_RECEIPTS.
    expect(results[results.length - 2].checkType).toBe('CASH');
    expect(results[results.length - 1].checkType).toBe('ACCRUED_RECEIPTS');
    // Inventory checks (zero or more, depending on warehouses with
    // inventoryAccountId set) sit in between.
    const middleTypes = results
      .slice(2, results.length - 2)
      .map((r) => r.checkType);
    for (const t of middleTypes) {
      expect(t).toMatch(/^INVENTORY_/);
    }

    // Each persisted as a PeriodReconciliationCheck row.
    const persisted = await db.periodReconciliationCheck.findMany({
      where: { fiscalPeriodId: period.id },
    });
    expect(persisted.length).toBe(results.length);
    for (const row of persisted) {
      expect(typeof row.passed).toBe('boolean');
      expect(row.glBalance).toBeDefined();
      expect(row.subledgerBalance).toBeDefined();
    }

    // Audit row.
    const audits = await db.auditLog.findMany({
      where: {
        entityType: 'FiscalPeriod',
        entityId: period.id,
        action: AuditAction.RECONCILIATION_RUN,
      },
    });
    expect(audits.length).toBeGreaterThanOrEqual(1);
  });

  it('every check has glBalance, subledgerBalance, difference, and difference === gl − sub', async () => {
    const period = await getOrCreatePeriodForDate(db, dateInMonth(6));
    const results = await runAllReconChecks(db, period.id);
    for (const r of results) {
      const computed = r.glBalance.minus(r.subledgerBalance);
      expect(r.difference.toString()).toBe(computed.toString());
    }
  });

  // -------------------------------------------------------------------------
  // ACCRUED_RECEIPTS check — easiest to verify in isolation since it
  // expects 0 and we can drive non-zero by posting directly to 2020.
  // -------------------------------------------------------------------------

  it('ACCRUED_RECEIPTS passes when GL 2020 is at zero (assuming no orphan accruals)', async () => {
    const period = await getOrCreatePeriodForDate(db, dateInMonth(7));
    const results = await runAllReconChecks(db, period.id);
    const accrued = results.find((r) => r.checkType === 'ACCRUED_RECEIPTS')!;
    // GL 2020 may or may not be at zero depending on whether any test
    // has un-billed receipts — we just verify the check ran and the
    // formula is correct (subledgerBalance always 0).
    expect(accrued.subledgerBalance.toString()).toBe(
      new Prisma.Decimal('0').toString(),
    );
    // passed flag matches the gl-vs-zero test.
    expect(accrued.passed).toBe(
      accrued.glBalance.abs().lessThanOrEqualTo(new Prisma.Decimal('0.001')),
    );
  });

  it('ACCRUED_RECEIPTS surfaces an unbalanced GL when a manual JE imbalances 2020', async () => {
    // Post a JE that DR's 2020 (offset against 2010 AP) — simulates a
    // bookkeeping error or the pre-bill receipt state. periods are 2097,
    // far enough from any other test's posts that the asOf includes our
    // JE. Scope by entityType so wipe sweeps it.
    const period = await getOrCreatePeriodForDate(db, dateInMonth(8));
    await db.$transaction((tx) =>
      post(tx, {
        entityType: ENTITY_TYPE,
        entityId: 'orphan-accrual',
        description: 'Test orphan accrual — non-cancelling',
        postedAt: dateInMonth(8, 1),
        lines: [
          { accountCode: ACCT_AR, debit: '17.50' },
          { accountCode: ACCT_ACCRUED, credit: '17.50' },
        ],
      }),
    );

    const results = await runAllReconChecks(db, period.id);
    const accrued = results.find((r) => r.checkType === 'ACCRUED_RECEIPTS')!;
    // Our JE adds $17.50 to the LIABILITY side (CR). Total GL balance
    // increases by 17.50, but other concurrent test activity may also
    // touch 2020, so just verify our delta is >= 17.50.
    expect(accrued.glBalance.greaterThanOrEqualTo(new Prisma.Decimal('17.50'))).toBe(true);
    // And the check fails because subledger is 0 but glBalance is non-zero.
    expect(accrued.passed).toBe(false);
  });

  // -------------------------------------------------------------------------
  // hardClosePeriod gate behavior
  // -------------------------------------------------------------------------

  it('hardClosePeriod runs recon and refuses when checks fail without override', async () => {
    const period = await getOrCreatePeriodForDate(db, dateInMonth(9));
    // Force a recon failure by posting an orphan accrual (same trick as above).
    await db.$transaction((tx) =>
      post(tx, {
        entityType: ENTITY_TYPE,
        entityId: 'orphan-for-gate-test',
        description: 'Orphan accrual to break ACCRUED_RECEIPTS',
        postedAt: dateInMonth(9, 1),
        lines: [
          { accountCode: ACCT_AR, debit: '5' },
          { accountCode: ACCT_ACCRUED, credit: '5' },
        ],
      }),
    );

    await expect(hardClosePeriod(db, period.id)).rejects.toThrow(
      /reconciliation check.*failed/i,
    );
  });

  it('hardClosePeriod with forceCloseWithDiscrepancies succeeds even when checks fail; persists snapshot', async () => {
    const period = await getOrCreatePeriodForDate(db, dateInMonth(10));
    // Force a recon failure.
    await db.$transaction((tx) =>
      post(tx, {
        entityType: ENTITY_TYPE,
        entityId: 'orphan-for-force-close',
        description: 'Orphan accrual for force-close test',
        postedAt: dateInMonth(10, 1),
        lines: [
          { accountCode: ACCT_AR, debit: '8' },
          { accountCode: ACCT_ACCRUED, credit: '8' },
        ],
      }),
    );

    const closed = await hardClosePeriod(db, period.id, {
      forceCloseWithDiscrepancies: { reason: 'auditor accepts variance' },
    });
    expect(closed.status).toBe('HARD_CLOSED');

    // The recon snapshot persisted from the gate run (separate Tx) plus
    // the close audit row both exist.
    const persisted = await db.periodReconciliationCheck.findMany({
      where: { fiscalPeriodId: period.id },
    });
    expect(persisted.length).toBeGreaterThanOrEqual(4); // AR, AP, CASH, ACCRUED at minimum
    const closeAudit = await db.auditLog.findFirst({
      where: {
        entityType: 'FiscalPeriod',
        entityId: period.id,
        action: AuditAction.PERIOD_CLOSED,
      },
      orderBy: { createdAt: 'desc' },
    });
    expect(closeAudit?.reason).toBe('auditor accepts variance');
  });

  it('hardClosePeriod runs recon snapshot even when close fails — independent transaction', async () => {
    const period = await getOrCreatePeriodForDate(db, dateInMonth(11));
    // Cause recon failure to make the close fail.
    await db.$transaction((tx) =>
      post(tx, {
        entityType: ENTITY_TYPE,
        entityId: 'orphan-for-snapshot-persistence',
        description: 'Orphan accrual',
        postedAt: dateInMonth(11, 1),
        lines: [
          { accountCode: ACCT_AR, debit: '3' },
          { accountCode: ACCT_ACCRUED, credit: '3' },
        ],
      }),
    );

    await expect(hardClosePeriod(db, period.id)).rejects.toThrow(/failed/i);

    // Recon snapshot rows exist even though close threw — the recon Tx
    // committed independently before the gate decision.
    const persisted = await db.periodReconciliationCheck.findMany({
      where: { fiscalPeriodId: period.id },
    });
    expect(persisted.length).toBeGreaterThan(0);
  });

  it('reopenPeriod after force-close works (lifecycle still intact post-recon-wiring)', async () => {
    const period = await getOrCreatePeriodForDate(db, dateInMonth(12));
    await hardClosePeriod(db, period.id, FORCE_CLOSE);
    const reopened = await reopenPeriod(db, period.id, 'late adjustment');
    expect(reopened.status).toBe('OPEN');
  });

  // -------------------------------------------------------------------------
  // listReconChecksForPeriod
  // -------------------------------------------------------------------------

  it('listReconChecksForPeriod with latestPerCheckType filters duplicates', async () => {
    const period = await getOrCreatePeriodForDate(db, dateInMonth(2));
    // Run twice so we have two sets of snapshots.
    await runAllReconChecks(db, period.id);
    await runAllReconChecks(db, period.id);

    const all = await listReconChecksForPeriod(db, period.id);
    const latest = await listReconChecksForPeriod(db, period.id, {
      latestPerCheckType: true,
    });
    expect(all.length).toBe(latest.length * 2);
    // Each checkType appears exactly once in latest.
    const latestTypes = new Set(latest.map((c) => c.checkType));
    expect(latestTypes.size).toBe(latest.length);
  });

  // -------------------------------------------------------------------------
  // Sanity: after our delta JE, AR_CONTROL difference moves
  // -------------------------------------------------------------------------

  it('AR_CONTROL difference moves predictably with an inline AR JE delta', async () => {
    // Snapshot recon state before.
    const period = await getOrCreatePeriodForDate(db, dateInMonth(3));
    const before = await runAllReconChecks(db, period.id);
    const arBefore = before.find((r) => r.checkType === 'AR_CONTROL')!;

    // Post a fresh AR DR of $11.11 (to a totally separate fictional
    // entity) — no matching subledger entry, so the AR_CONTROL difference
    // should grow by exactly +$11.11 on the GL side.
    await db.$transaction((tx) =>
      post(tx, {
        entityType: ENTITY_TYPE,
        entityId: 'ar-delta-only',
        description: 'AR delta-only sanity check',
        postedAt: dateInMonth(3, 5),
        lines: [
          { accountCode: ACCT_AR, debit: '11.11' },
          { accountCode: ACCT_ACCRUED, credit: '11.11' }, // offsetting on a non-AR account so AR moves only
        ],
      }),
    );

    const after = await runAllReconChecks(db, period.id);
    const arAfter = after.find((r) => r.checkType === 'AR_CONTROL')!;
    // GL_AR moved up by 11.11 (DR). Subledger unchanged. Difference grows by 11.11.
    const glDelta = arAfter.glBalance.minus(arBefore.glBalance);
    expect(glDelta.toString()).toBe(new Prisma.Decimal('11.11').toString());
    const diffDelta = arAfter.difference.minus(arBefore.difference);
    expect(diffDelta.toString()).toBe(new Prisma.Decimal('11.11').toString());
  });

  // Suppress unused warnings for AccountType import (used in other test
  // files; kept for forward-compat if we add fixture-creation helpers).
  void AccountType;
});

async function wipe(): Promise<void> {
  const db = makeClient();
  try {
    // Sweep all PeriodReconciliationCheck snapshots tied to test periods.
    const periods = await db.fiscalPeriod.findMany({
      where: { code: { startsWith: `${TEST_YEAR}-` } },
      select: { id: true },
    });
    const periodIds = periods.map((p) => p.id);
    if (periodIds.length > 0) {
      await db.periodReconciliationCheck.deleteMany({
        where: { fiscalPeriodId: { in: periodIds } },
      });
      await db.auditLog.deleteMany({
        where: { entityType: 'FiscalPeriod', entityId: { in: periodIds } },
      });
      await db.fiscalPeriod.deleteMany({ where: { id: { in: periodIds } } });
    }

    // Sweep our test JEs (and their lines) by entityType.
    const jes = await db.journalEntry.findMany({
      where: { entityType: ENTITY_TYPE },
      select: { id: true },
    });
    if (jes.length > 0) {
      const jeIds = jes.map((j) => j.id);
      await db.journalEntryLine.deleteMany({
        where: { journalEntryId: { in: jeIds } },
      });
      await db.journalEntry.deleteMany({ where: { id: { in: jeIds } } });
    }
  } finally {
    await db.$disconnect();
  }
}
