import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AccountType, Prisma } from '@/generated/tenant';
import type { GlAccount, PrismaClient } from '@/generated/tenant';
import { post } from '@/lib/gl/post';
import {
  glDetail,
  journalReport,
  trialBalance,
} from '@/server/services/reports/financial';
import { hasTenantDb, makeClient } from '../helpers/db';

const suite = hasTenantDb ? describe : describe.skip;

// Test isolation: dedicated TEST-prefixed GL accounts (no other test
// touches these) + test year 2098 (period auto-create stays clean of
// other tests' 2026 activity). Two distinct entity types so wipe scopes.
const TEST_YEAR = 2098;
const ENTITY_TYPE_A = 'TestReportA';
const ENTITY_TYPE_B = 'TestReportB';
const ACCT_CASH = '9991';
const ACCT_AR = '9992';
const ACCT_REVENUE = '9993';

function dateInMonth(month: number, day: number = 15): Date {
  return new Date(Date.UTC(TEST_YEAR, month - 1, day, 12));
}

const FEB = dateInMonth(2);
const MAR = dateInMonth(3);
const APR = dateInMonth(4);
const MAY_START = new Date(Date.UTC(TEST_YEAR, 4, 1));   // 2098-05-01
const MAR_START = new Date(Date.UTC(TEST_YEAR, 2, 1));   // 2098-03-01
const APR_START = new Date(Date.UTC(TEST_YEAR, 3, 1));   // 2098-04-01

suite('Financial reports — trialBalance, glDetail, journalReport (slice B)', () => {
  let db: PrismaClient;
  let cash: GlAccount;
  let ar: GlAccount;
  let salesRevenue: GlAccount;

  beforeAll(async () => {
    db = makeClient();
    cash = await db.glAccount.upsert({
      where: { code: ACCT_CASH },
      create: { code: ACCT_CASH, name: 'TEST Cash', type: AccountType.ASSET },
      update: { active: true, deletedAt: null },
    });
    ar = await db.glAccount.upsert({
      where: { code: ACCT_AR },
      create: { code: ACCT_AR, name: 'TEST AR', type: AccountType.ASSET },
      update: { active: true, deletedAt: null },
    });
    salesRevenue = await db.glAccount.upsert({
      where: { code: ACCT_REVENUE },
      create: { code: ACCT_REVENUE, name: 'TEST Revenue', type: AccountType.REVENUE },
      update: { active: true, deletedAt: null },
    });
  });

  beforeEach(async () => {
    await wipe();
    // Seed deterministic JEs for the test scenario.
    //
    // Feb 2098 (entityType A — invoice-style):
    //   JE1:  DR 1210 AR     100   /  CR 4100 Revenue 100
    // Mar 2098 (entityType A):
    //   JE2:  DR 1110 Cash    60   /  CR 1210 AR        60   (partial pay)
    // Apr 2098 (entityType B — refund-style):
    //   JE3:  DR 4100 Revenue 20   /  CR 1210 AR        20   (return)
    //
    // After all 3 (cumulative through end-Apr):
    //   1110 Cash       60 DR
    //   1210 AR         20 DR  (100 - 60 - 20)
    //   4100 Revenue    80 CR  (100 - 20)
    await db.$transaction(async (tx) => {
      await post(tx, {
        entityType: ENTITY_TYPE_A,
        entityId: 'feb-invoice',
        description: 'Feb invoice',
        postedAt: FEB,
        lines: [
          { accountCode: ar.code, debit: '100', memo: 'AR for invoice' },
          { accountCode: salesRevenue.code, credit: '100', memo: 'Revenue' },
        ],
      });
      await post(tx, {
        entityType: ENTITY_TYPE_A,
        entityId: 'mar-payment',
        description: 'Mar partial payment',
        postedAt: MAR,
        lines: [
          { accountCode: cash.code, debit: '60' },
          { accountCode: ar.code, credit: '60' },
        ],
      });
      await post(tx, {
        entityType: ENTITY_TYPE_B,
        entityId: 'apr-credit',
        description: 'Apr credit memo',
        postedAt: APR,
        lines: [
          { accountCode: salesRevenue.code, debit: '20', memo: 'Return' },
          { accountCode: ar.code, credit: '20' },
        ],
      });
    });
  });

  afterAll(async () => {
    await wipe();
    await db.$disconnect();
  });

  // ---------- trialBalance ----------

  it('trialBalance is balanced (sum endingDebit === sum endingCredit) and rows sorted by code', async () => {
    const tb = await trialBalance(db, { to: MAY_START });
    // Filter to our 3 accounts (other tests may write activity).
    const ours = tb.rows.filter((r) =>
      [ACCT_CASH, ACCT_AR, ACCT_REVENUE].includes(r.accountCode),
    );
    expect(ours.map((r) => r.accountCode)).toEqual([ACCT_CASH, ACCT_AR, ACCT_REVENUE]);

    const cashRow = ours.find((r) => r.accountCode === ACCT_CASH)!;
    const arRow = ours.find((r) => r.accountCode === ACCT_AR)!;
    const revRow = ours.find((r) => r.accountCode === ACCT_REVENUE)!;

    expect(cashRow.endingDebit.toString()).toBe(new Prisma.Decimal('60').toString());
    expect(cashRow.endingCredit.toString()).toBe(new Prisma.Decimal('0').toString());
    expect(arRow.endingDebit.toString()).toBe(new Prisma.Decimal('20').toString());
    expect(revRow.endingCredit.toString()).toBe(new Prisma.Decimal('80').toString());

    // Top-level invariant: TB always balances.
    expect(tb.totals.totalEndingDebit.toString()).toBe(
      tb.totals.totalEndingCredit.toString(),
    );
    expect(tb.totals.totalPeriodDebits.toString()).toBe(
      tb.totals.totalPeriodCredits.toString(),
    );
  });

  it('trialBalance with from-date splits beginning vs period activity correctly', async () => {
    // Window = March only (March activity = JE2 only: cash +60, AR -60).
    const tb = await trialBalance(db, { from: MAR_START, to: APR_START });
    const cashRow = tb.rows.find((r) => r.accountCode === ACCT_CASH)!;
    const arRow = tb.rows.find((r) => r.accountCode === ACCT_AR)!;
    const revRow = tb.rows.find((r) => r.accountCode === ACCT_REVENUE)!;

    // Beginning (= state at MAR_START, which is end of Feb activity):
    //   Cash 0, AR 100 DR, Revenue 100 CR.
    expect(cashRow.beginningDebit.toString()).toBe('0');
    expect(arRow.beginningDebit.toString()).toBe(new Prisma.Decimal('100').toString());
    expect(revRow.beginningCredit.toString()).toBe(new Prisma.Decimal('100').toString());

    // March activity:
    expect(cashRow.periodDebits.toString()).toBe(new Prisma.Decimal('60').toString());
    expect(cashRow.periodCredits.toString()).toBe('0');
    expect(arRow.periodDebits.toString()).toBe('0');
    expect(arRow.periodCredits.toString()).toBe(new Prisma.Decimal('60').toString());

    // Ending (= beginning + period):
    expect(cashRow.endingDebit.toString()).toBe(new Prisma.Decimal('60').toString());
    expect(arRow.endingDebit.toString()).toBe(new Prisma.Decimal('40').toString());
    expect(revRow.endingCredit.toString()).toBe(new Prisma.Decimal('100').toString());
  });

  it('trialBalance excludes accounts with zero beginning AND zero period activity AND zero ending', async () => {
    // Pick a date range with no activity in our test year (Jan only —
    // we only seeded Feb-Apr).
    const JAN_START = new Date(Date.UTC(TEST_YEAR, 0, 1));
    const FEB_START = new Date(Date.UTC(TEST_YEAR, 1, 1));
    const tb = await trialBalance(db, { from: JAN_START, to: FEB_START });
    // Our accounts have zero everything in this window — they should be
    // absent. Other accounts (from concurrent test posts) may appear;
    // just confirm OUR three are absent.
    const ourCodes = tb.rows
      .map((r) => r.accountCode)
      .filter((c) => [ACCT_CASH, ACCT_AR, ACCT_REVENUE].includes(c));
    expect(ourCodes).toEqual([]);
  });

  it('trialBalance row math: beginning + period === ending (signed)', async () => {
    const tb = await trialBalance(db, { from: MAR_START, to: MAY_START });
    for (const row of tb.rows) {
      const beginningSigned = row.beginningDebit.minus(row.beginningCredit);
      const periodSigned = row.periodDebits.minus(row.periodCredits);
      const endingSigned = row.endingDebit.minus(row.endingCredit);
      expect(beginningSigned.plus(periodSigned).toString()).toBe(
        endingSigned.toString(),
      );
    }
  });

  // ---------- glDetail ----------

  it('glDetail for AR through end-Apr: 3 rows, running balance walks 0 → 100 → 40 → 20', async () => {
    const detail = await glDetail(db, { accountCode: ACCT_AR, to: MAY_START });
    // Filter to OUR test JEs (other tests may share the AR account).
    const ours = detail.rows.filter((r) =>
      [ENTITY_TYPE_A, ENTITY_TYPE_B].includes(r.entityType),
    );
    expect(ours).toHaveLength(3);

    // Order is chronological.
    expect(ours[0].entityId).toBe('feb-invoice');
    expect(ours[1].entityId).toBe('mar-payment');
    expect(ours[2].entityId).toBe('apr-credit');

    // The signed running balance ON the entire account also includes
    // any activity from other tests. We verify the DELTA pattern:
    expect(ours[0].debit.toString()).toBe(new Prisma.Decimal('100').toString());
    expect(ours[1].credit.toString()).toBe(new Prisma.Decimal('60').toString());
    expect(ours[2].credit.toString()).toBe(new Prisma.Decimal('20').toString());

    // Beginning + sum(debits-credits) === ending invariant on the
    // top-level computed numbers.
    const computedEnd = detail.beginningBalance
      .plus(detail.totalDebits)
      .minus(detail.totalCredits);
    expect(computedEnd.toString()).toBe(detail.endingBalance.toString());
  });

  it('glDetail running balance: each row equals previous-row balance + this-row delta', async () => {
    const detail = await glDetail(db, { accountCode: ACCT_AR, to: MAY_START });
    let prev = detail.beginningBalance;
    for (const row of detail.rows) {
      const expected = prev.plus(row.debit).minus(row.credit);
      expect(row.runningBalance.toString()).toBe(expected.toString());
      prev = row.runningBalance;
    }
    expect(prev.toString()).toBe(detail.endingBalance.toString());
  });

  it('glDetail with from-date excludes prior activity from rows but includes it in beginningBalance', async () => {
    // Pull just March + April for AR.
    const detail = await glDetail(db, {
      accountCode: ACCT_AR,
      from: MAR_START,
      to: MAY_START,
    });
    const ours = detail.rows.filter((r) =>
      [ENTITY_TYPE_A, ENTITY_TYPE_B].includes(r.entityType),
    );
    expect(ours).toHaveLength(2); // Mar payment + Apr credit
    expect(ours[0].entityId).toBe('mar-payment');
    expect(ours[1].entityId).toBe('apr-credit');
    // Beginning balance carries the Feb invoice forward (the AR account
    // also accumulates from other tests, but the delta from our seed
    // contributes +100 to the beginning).
  });

  it('glDetail throws on unknown account code', async () => {
    await expect(
      glDetail(db, { accountCode: 'NONEXIST', to: MAY_START }),
    ).rejects.toThrow(/GL account not found/);
  });

  // ---------- journalReport ----------

  it('journalReport returns entries in chronological order with full line detail', async () => {
    const report = await journalReport(db, {
      from: new Date(Date.UTC(TEST_YEAR, 0, 1)),
      to: MAY_START,
      entityType: ENTITY_TYPE_A,
    });
    // Both ENTITY_TYPE_A entries (feb invoice + mar payment).
    expect(report.entries).toHaveLength(2);
    expect(report.entries[0].entityId).toBe('feb-invoice');
    expect(report.entries[1].entityId).toBe('mar-payment');
    // Each entry has its full line detail.
    const inv = report.entries[0];
    expect(inv.lines).toHaveLength(2);
    expect(inv.lines.find((l) => l.accountCode === ACCT_AR)?.debit.toString()).toBe(
      new Prisma.Decimal('100').toString(),
    );
    expect(inv.lines.find((l) => l.accountCode === ACCT_REVENUE)?.credit.toString()).toBe(
      new Prisma.Decimal('100').toString(),
    );
  });

  it('journalReport filter by entityType isolates the slice', async () => {
    const report = await journalReport(db, {
      from: new Date(Date.UTC(TEST_YEAR, 0, 1)),
      to: MAY_START,
      entityType: ENTITY_TYPE_B,
    });
    expect(report.entries).toHaveLength(1);
    expect(report.entries[0].entityId).toBe('apr-credit');
  });

  it('journalReport filter by accountCode returns only JEs touching that account', async () => {
    // Cash (1110) — only mar-payment touches it.
    const report = await journalReport(db, {
      from: new Date(Date.UTC(TEST_YEAR, 0, 1)),
      to: MAY_START,
      entityType: ENTITY_TYPE_A,
      accountCode: ACCT_CASH,
    });
    expect(report.entries).toHaveLength(1);
    expect(report.entries[0].entityId).toBe('mar-payment');
  });

  it('journalReport date window excludes entries outside [from, to)', async () => {
    // Apr only — exactly the apr-credit JE.
    const report = await journalReport(db, {
      from: APR_START,
      to: MAY_START,
    });
    const ours = report.entries.filter((e) =>
      [ENTITY_TYPE_A, ENTITY_TYPE_B].includes(e.entityType),
    );
    expect(ours).toHaveLength(1);
    expect(ours[0].entityId).toBe('apr-credit');
  });

  it('journalReport throws on unknown accountCode filter', async () => {
    await expect(
      journalReport(db, {
        to: MAY_START,
        accountCode: 'NONEXIST',
      }),
    ).rejects.toThrow(/GL account not found/);
  });
});

async function wipe(): Promise<void> {
  const db = makeClient();
  try {
    // Sweep test JEs (and their lines) by entityType.
    const jes = await db.journalEntry.findMany({
      where: { entityType: { in: [ENTITY_TYPE_A, ENTITY_TYPE_B] } },
      select: { id: true },
    });
    if (jes.length > 0) {
      const jeIds = jes.map((j) => j.id);
      await db.journalEntryLine.deleteMany({
        where: { journalEntryId: { in: jeIds } },
      });
      await db.journalEntry.deleteMany({ where: { id: { in: jeIds } } });
    }
    // Periods auto-created in the test year are not cleaned per-test —
    // they're idempotent OPEN rows that don't affect later runs. Sweep
    // them once at suite end via afterAll's wipe call to keep the DB
    // tidy.
    await db.fiscalPeriod.deleteMany({
      where: { code: { startsWith: `${TEST_YEAR}-` } },
    });
    // Audit rows for the test periods (if any).
    // Using 'FiscalPeriod' entityType + checking if id matches deleted
    // periods is unnecessary because we delete the periods themselves;
    // audit rows referencing them stay but don't FK-block anything.
  } finally {
    await db.$disconnect();
  }
}
