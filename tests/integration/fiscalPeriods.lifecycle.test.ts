import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AuditAction,
  FiscalPeriodStatus,
  Prisma,
} from '@/generated/tenant';
import type { PrismaClient } from '@/generated/tenant';
import {
  assertPostingAllowedTx,
  getOrCreatePeriodForDate,
  getOrCreatePeriodForDateTx,
  hardClosePeriod,
  listPeriods,
  periodBoundsForDate,
  periodCodeForDate,
  reopenPeriod,
  softClosePeriod,
} from '@/server/services/fiscalPeriods';
import { post } from '@/lib/gl/post';
import { hasTenantDb, makeClient } from '../helpers/db';

const suite = hasTenantDb ? describe : describe.skip;

// Test slice uses YEAR 2099 to avoid colliding with periods auto-created
// by other tests' JE posts (which use new Date() = 2026 or so). 2099-01,
// 2099-02, 2099-12 give us deterministic period codes that no other test
// will materialize.
const TEST_YEAR = 2099;

function dateInMonth(month: number, day: number = 15): Date {
  return new Date(Date.UTC(TEST_YEAR, month - 1, day, 12));
}

// Slice A lifecycle tests focus on close/reopen mechanics, not on recon
// outcomes. The recon gate added in slice D would otherwise fail these
// tests because the cumulative ledger state at TEST_YEAR-09-01 includes
// activity from concurrent test files. Bypass via the explicit override
// (the same operator path an admin would use to close a known-imperfect
// period). Slice D tests exercise the gate behavior on its own.
const FORCE_CLOSE = {
  forceCloseWithDiscrepancies: { reason: 'lifecycle test bypass' },
};

suite('FiscalPeriod lifecycle (slice A)', () => {
  let db: PrismaClient;

  beforeAll(async () => {
    db = makeClient();
  });

  beforeEach(async () => {
    await wipe();
  });

  afterAll(async () => {
    await wipe();
    await db.$disconnect();
  });

  // ---------- Date math ----------

  it('periodCodeForDate yields YYYY-MM in UTC', () => {
    expect(periodCodeForDate(new Date(Date.UTC(2099, 0, 15)))).toBe('2099-01');
    expect(periodCodeForDate(new Date(Date.UTC(2099, 11, 31, 23)))).toBe('2099-12');
    // Edge: 2099-02-28T23:59:59Z → still Feb in UTC.
    expect(periodCodeForDate(new Date(Date.UTC(2099, 1, 28, 23, 59, 59)))).toBe('2099-02');
  });

  it('periodBoundsForDate returns half-open [start, end) and handles December → next-year January', () => {
    const dec = periodBoundsForDate(dateInMonth(12, 5));
    expect(dec.startDate.toISOString()).toBe(`${TEST_YEAR}-12-01T00:00:00.000Z`);
    expect(dec.endDate.toISOString()).toBe(`${TEST_YEAR + 1}-01-01T00:00:00.000Z`);

    const feb = periodBoundsForDate(dateInMonth(2, 15));
    expect(feb.startDate.toISOString()).toBe(`${TEST_YEAR}-02-01T00:00:00.000Z`);
    expect(feb.endDate.toISOString()).toBe(`${TEST_YEAR}-03-01T00:00:00.000Z`);
  });

  // ---------- getOrCreatePeriodForDate ----------

  it('getOrCreatePeriodForDate auto-creates a period the first time it is called for a month', async () => {
    const code = `${TEST_YEAR}-01`;
    const before = await db.fiscalPeriod.findUnique({ where: { code } });
    expect(before).toBeNull();
    const period = await getOrCreatePeriodForDate(db, dateInMonth(1));
    expect(period.code).toBe(code);
    expect(period.status).toBe(FiscalPeriodStatus.OPEN);
    expect(period.startDate.toISOString()).toBe(`${TEST_YEAR}-01-01T00:00:00.000Z`);
    expect(period.endDate.toISOString()).toBe(`${TEST_YEAR}-02-01T00:00:00.000Z`);
  });

  it('getOrCreatePeriodForDate is idempotent (same row returned on repeat call)', async () => {
    const a = await getOrCreatePeriodForDate(db, dateInMonth(3, 5));
    const b = await getOrCreatePeriodForDate(db, dateInMonth(3, 28));
    expect(a.id).toBe(b.id);
    expect(a.code).toBe(`${TEST_YEAR}-03`);
  });

  it('getOrCreatePeriodForDate is race-safe: concurrent calls for same month land on the unique code', async () => {
    const date = dateInMonth(4);
    // Hit it 5 times in parallel.
    const periods = await Promise.all(
      Array.from({ length: 5 }, () => getOrCreatePeriodForDate(db, date)),
    );
    const ids = new Set(periods.map((p) => p.id));
    expect(ids.size).toBe(1); // all five resolved to the same row
  });

  // ---------- listPeriods ----------

  it('listPeriods filters by status and year', async () => {
    await getOrCreatePeriodForDate(db, dateInMonth(5));
    await getOrCreatePeriodForDate(db, dateInMonth(6));
    const p7 = await getOrCreatePeriodForDate(db, dateInMonth(7));
    await softClosePeriod(db, p7.id);

    const all = await listPeriods(db, { year: TEST_YEAR });
    const ourCodes = all.map((p) => p.code);
    expect(ourCodes).toContain(`${TEST_YEAR}-05`);
    expect(ourCodes).toContain(`${TEST_YEAR}-06`);
    expect(ourCodes).toContain(`${TEST_YEAR}-07`);

    const closedOnly = await listPeriods(db, {
      year: TEST_YEAR,
      status: FiscalPeriodStatus.SOFT_CLOSED,
    });
    expect(closedOnly.map((p) => p.code)).toEqual([`${TEST_YEAR}-07`]);
  });

  // ---------- soft close ----------

  it('softClosePeriod: OPEN → SOFT_CLOSED, audit row written', async () => {
    const p = await getOrCreatePeriodForDate(db, dateInMonth(2));
    const after = await softClosePeriod(db, p.id);
    expect(after.status).toBe(FiscalPeriodStatus.SOFT_CLOSED);
    expect(after.closedAt).not.toBeNull();
    const audits = await db.auditLog.findMany({
      where: { entityType: 'FiscalPeriod', entityId: p.id, action: AuditAction.PERIOD_CLOSED },
    });
    expect(audits).toHaveLength(1);
  });

  it('softClosePeriod refuses re-soft on already-soft period', async () => {
    const p = await getOrCreatePeriodForDate(db, dateInMonth(2));
    await softClosePeriod(db, p.id);
    await expect(softClosePeriod(db, p.id)).rejects.toThrow(/already SOFT_CLOSED/);
  });

  it('softClosePeriod refuses on HARD_CLOSED period', async () => {
    const p = await getOrCreatePeriodForDate(db, dateInMonth(2));
    await hardClosePeriod(db, p.id, FORCE_CLOSE);
    await expect(softClosePeriod(db, p.id)).rejects.toThrow(/HARD_CLOSED.*Reopen first/);
  });

  // ---------- hard close ----------

  it('hardClosePeriod: OPEN → HARD_CLOSED', async () => {
    const p = await getOrCreatePeriodForDate(db, dateInMonth(8));
    const after = await hardClosePeriod(db, p.id, FORCE_CLOSE);
    expect(after.status).toBe(FiscalPeriodStatus.HARD_CLOSED);
  });

  it('hardClosePeriod: SOFT_CLOSED → HARD_CLOSED is allowed', async () => {
    const p = await getOrCreatePeriodForDate(db, dateInMonth(8));
    await softClosePeriod(db, p.id);
    const after = await hardClosePeriod(db, p.id, FORCE_CLOSE);
    expect(after.status).toBe(FiscalPeriodStatus.HARD_CLOSED);
  });

  it('hardClosePeriod refuses re-hard on already-hard period', async () => {
    const p = await getOrCreatePeriodForDate(db, dateInMonth(8));
    await hardClosePeriod(db, p.id, FORCE_CLOSE);
    await expect(hardClosePeriod(db, p.id, FORCE_CLOSE)).rejects.toThrow(/already HARD_CLOSED/);
  });

  // ---------- reopen ----------

  it('reopenPeriod: SOFT_CLOSED → OPEN, audit row written, reopen fields populated', async () => {
    const p = await getOrCreatePeriodForDate(db, dateInMonth(9));
    await softClosePeriod(db, p.id);
    const after = await reopenPeriod(db, p.id, 'late adjustment needed');
    expect(after.status).toBe(FiscalPeriodStatus.OPEN);
    expect(after.reopenedAt).not.toBeNull();
    expect(after.reopenReason).toBe('late adjustment needed');
    expect(after.closedAt).toBeNull();
    const audits = await db.auditLog.findMany({
      where: { entityType: 'FiscalPeriod', entityId: p.id, action: AuditAction.PERIOD_REOPENED },
    });
    expect(audits).toHaveLength(1);
  });

  it('reopenPeriod: HARD_CLOSED → OPEN allowed with reason', async () => {
    const p = await getOrCreatePeriodForDate(db, dateInMonth(9));
    await hardClosePeriod(db, p.id, FORCE_CLOSE);
    const after = await reopenPeriod(db, p.id, 'auditor request');
    expect(after.status).toBe(FiscalPeriodStatus.OPEN);
  });

  it('reopenPeriod requires non-empty reason', async () => {
    const p = await getOrCreatePeriodForDate(db, dateInMonth(9));
    await hardClosePeriod(db, p.id, FORCE_CLOSE);
    await expect(reopenPeriod(db, p.id, '')).rejects.toThrow(/non-empty reason/);
    await expect(reopenPeriod(db, p.id, '   ')).rejects.toThrow(/non-empty reason/);
  });

  it('reopenPeriod refuses already-OPEN period', async () => {
    const p = await getOrCreatePeriodForDate(db, dateInMonth(9));
    await expect(reopenPeriod(db, p.id, 'pointless')).rejects.toThrow(/already OPEN/);
  });

  // ---------- assertPostingAllowedTx ----------

  it('assertPostingAllowedTx auto-creates the period if missing', async () => {
    const date = dateInMonth(10);
    const code = `${TEST_YEAR}-10`;
    expect(await db.fiscalPeriod.findUnique({ where: { code } })).toBeNull();
    const period = await db.$transaction((tx) =>
      assertPostingAllowedTx(tx, date),
    );
    expect(period.code).toBe(code);
    expect(period.status).toBe(FiscalPeriodStatus.OPEN);
  });

  it('assertPostingAllowedTx allows OPEN and SOFT_CLOSED (per Q4)', async () => {
    const p = await getOrCreatePeriodForDate(db, dateInMonth(11));
    // OPEN — passes.
    await db.$transaction((tx) => assertPostingAllowedTx(tx, dateInMonth(11)));
    // SOFT_CLOSED — passes per Q4 sign-off.
    await softClosePeriod(db, p.id);
    await db.$transaction((tx) => assertPostingAllowedTx(tx, dateInMonth(11)));
  });

  it('assertPostingAllowedTx blocks HARD_CLOSED without override', async () => {
    const p = await getOrCreatePeriodForDate(db, dateInMonth(11));
    await hardClosePeriod(db, p.id, FORCE_CLOSE);
    await expect(
      db.$transaction((tx) => assertPostingAllowedTx(tx, dateInMonth(11))),
    ).rejects.toThrow(/HARD_CLOSED.*Reopen the period or supply/);
  });

  it('assertPostingAllowedTx allows HARD_CLOSED with override + writes MANUAL_JE_POSTED audit', async () => {
    const p = await getOrCreatePeriodForDate(db, dateInMonth(11));
    await hardClosePeriod(db, p.id, FORCE_CLOSE);
    await db.$transaction((tx) =>
      assertPostingAllowedTx(tx, dateInMonth(11), {
        reason: 'auditor adjustment',
        userId: null,
      }),
    );
    const audits = await db.auditLog.findMany({
      where: {
        entityType: 'FiscalPeriod',
        entityId: p.id,
        action: AuditAction.MANUAL_JE_POSTED,
      },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0].reason).toBe('auditor adjustment');
  });

  it('assertPostingAllowedTx rejects override with empty reason', async () => {
    const p = await getOrCreatePeriodForDate(db, dateInMonth(11));
    await hardClosePeriod(db, p.id, FORCE_CLOSE);
    await expect(
      db.$transaction((tx) =>
        assertPostingAllowedTx(tx, dateInMonth(11), { reason: '   ' }),
      ),
    ).rejects.toThrow(/HARD_CLOSED.*non-empty reason/);
  });

  // ---------- post() integration ----------

  it('post() into HARD_CLOSED period throws and does NOT consume a JE sequence', async () => {
    const p = await getOrCreatePeriodForDate(db, dateInMonth(12));
    await hardClosePeriod(db, p.id, FORCE_CLOSE);

    // Snapshot the JE sequence before the failed post.
    const seqBefore = await db.sequence.findUnique({
      where: { name: 'journal_entry' },
    });
    const jeCountBefore = await db.journalEntry.count();

    const apAccount = await db.glAccount.findFirstOrThrow({ where: { code: '2010' } });
    const cashAccount = await db.glAccount.findFirstOrThrow({ where: { code: '1110' } });

    await expect(
      db.$transaction((tx) =>
        post(tx, {
          entityType: 'TestEntity',
          entityId: 'test-block-id',
          description: `block test ${Date.now()}`,
          postedAt: dateInMonth(12),
          lines: [
            { accountCode: apAccount.code, debit: '10' },
            { accountCode: cashAccount.code, credit: '10' },
          ],
        }),
      ),
    ).rejects.toThrow(/HARD_CLOSED/);

    // Sequence number unchanged + no new JE row.
    const seqAfter = await db.sequence.findUnique({
      where: { name: 'journal_entry' },
    });
    expect(seqAfter?.currentValue).toBe(seqBefore?.currentValue);
    const jeCountAfter = await db.journalEntry.count();
    expect(jeCountAfter).toBe(jeCountBefore);
  });

  it('post() into HARD_CLOSED period with closedPeriodOverride succeeds + writes both JE and override audit', async () => {
    const p = await getOrCreatePeriodForDate(db, dateInMonth(12));
    await hardClosePeriod(db, p.id, FORCE_CLOSE);

    const apAccount = await db.glAccount.findFirstOrThrow({ where: { code: '2010' } });
    const cashAccount = await db.glAccount.findFirstOrThrow({ where: { code: '1110' } });

    const description = `override test ${Date.now()}`;
    const je = await db.$transaction((tx) =>
      post(tx, {
        entityType: 'TestEntity',
        entityId: 'test-override-id',
        description,
        postedAt: dateInMonth(12),
        closedPeriodOverride: { reason: 'auditor allowed', userId: null },
        lines: [
          { accountCode: apAccount.code, debit: '7' },
          { accountCode: cashAccount.code, credit: '7' },
        ],
      }),
    );
    expect(je.number).toMatch(/^JE-\d{4}-\d{5}$/);

    const overrideAudit = await db.auditLog.findFirst({
      where: {
        entityType: 'FiscalPeriod',
        entityId: p.id,
        action: AuditAction.MANUAL_JE_POSTED,
        reason: 'auditor allowed',
      },
    });
    expect(overrideAudit).not.toBeNull();

    // Cleanup the test JE — its (entityType, entityId) is fictional, so
    // sweep by JE id to avoid leaving an orphan.
    await db.journalEntryLine.deleteMany({ where: { journalEntryId: je.id } });
    await db.journalEntry.delete({ where: { id: je.id } });
  });

  // ---------- Tx variant ----------

  it('getOrCreatePeriodForDateTx works inside an existing transaction', async () => {
    const period = await db.$transaction((tx) =>
      getOrCreatePeriodForDateTx(tx, dateInMonth(1, 1)),
    );
    expect(period.code).toBe(`${TEST_YEAR}-01`);
    // Decimal not used here, but suppress the unused-import warning by
    // referencing Prisma at least once.
    void Prisma;
  });
});

async function wipe(): Promise<void> {
  const db = makeClient();
  try {
    // Find all FiscalPeriods for our test year and clean up:
    // - audit rows pointing at them
    // - any test JEs we created
    // - the periods themselves
    const periods = await db.fiscalPeriod.findMany({
      where: { code: { startsWith: `${TEST_YEAR}-` } },
      select: { id: true },
    });
    const periodIds = periods.map((p) => p.id);
    if (periodIds.length > 0) {
      await db.auditLog.deleteMany({
        where: { entityType: 'FiscalPeriod', entityId: { in: periodIds } },
      });
      // PeriodReconciliationCheck rows (slice D will exercise these;
      // sweep proactively).
      await db.periodReconciliationCheck.deleteMany({
        where: { fiscalPeriodId: { in: periodIds } },
      });
      await db.fiscalPeriod.deleteMany({ where: { id: { in: periodIds } } });
    }
    // Sweep test JEs created by the post() integration test.
    const testJes = await db.journalEntry.findMany({
      where: { entityType: 'TestEntity' },
      select: { id: true },
    });
    if (testJes.length > 0) {
      const jeIds = testJes.map((j) => j.id);
      await db.journalEntryLine.deleteMany({
        where: { journalEntryId: { in: jeIds } },
      });
      await db.journalEntry.deleteMany({ where: { id: { in: jeIds } } });
    }
  } finally {
    await db.$disconnect();
  }
}
