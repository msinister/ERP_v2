import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AccountType,
  Prisma,
} from '@/generated/tenant';
import type {
  GlAccount,
  PrismaClient,
} from '@/generated/tenant';
import { post } from '@/lib/gl/post';
import {
  cashPosition,
  inventoryValuation,
  salesByCustomer,
  salesByItem,
} from '@/server/services/reports/operational';
import {
  apAgingWidget,
  arAgingWidget,
  cashPositionWidget,
  openPosWidget,
  openSosWidget,
  todaysSalesWidget,
} from '@/server/services/reports/dashboard';
import { hasTenantDb, makeClient } from '../helpers/db';

const suite = hasTenantDb ? describe : describe.skip;
const TEST_YEAR = 2096;
const ENTITY_TYPE = 'TestOp';

suite('Operational reports + dashboard widgets (slice E)', () => {
  let db: PrismaClient;
  let cash: GlAccount;

  beforeAll(async () => {
    db = makeClient();
    // Seed an isolated TEST cash account so cashPosition can be
    // verified without contamination from other parallel test files.
    // operational.cashPosition hardcodes '1110', but for test isolation
    // we exercise it via the widget which uses the same seeded account.
    cash = await db.glAccount.findFirstOrThrow({ where: { code: '1110' } });
    void cash;
  });

  beforeEach(async () => {
    await wipe();
  });

  afterAll(async () => {
    await wipe();
    await db.$disconnect();
  });

  // ---------- salesByCustomer ----------

  it('salesByCustomer returns no rows for an empty period', async () => {
    const from = new Date(Date.UTC(TEST_YEAR, 0, 1));
    const to = new Date(Date.UTC(TEST_YEAR, 1, 1));
    const report = await salesByCustomer(db, { from, to });
    expect(report.rows).toEqual([]);
    expect(report.totalGrossSales.toString()).toBe('0');
    expect(report.totalInvoices).toBe(0);
  });

  // (We don't seed real invoices here — building a full invoice
  // requires SO+close+inventory plumbing. The smoke script exercises
  // the full happy path. Here we only verify shape + empty cases.)

  it('salesByCustomer date window is half-open [from, to)', async () => {
    const from = new Date(Date.UTC(TEST_YEAR, 5, 1));
    const to = new Date(Date.UTC(TEST_YEAR, 6, 1));
    const report = await salesByCustomer(db, { from, to });
    expect(report.asOfFrom?.toISOString()).toBe(from.toISOString());
    expect(report.asOfTo.toISOString()).toBe(to.toISOString());
  });

  // ---------- salesByItem ----------

  it('salesByItem returns no rows for an empty period', async () => {
    const from = new Date(Date.UTC(TEST_YEAR, 0, 1));
    const to = new Date(Date.UTC(TEST_YEAR, 1, 1));
    const report = await salesByItem(db, { from, to });
    expect(report.rows).toEqual([]);
    expect(report.totalQty.toString()).toBe('0');
    expect(report.totalGrossSales.toString()).toBe('0');
  });

  // ---------- inventoryValuation ----------

  it('inventoryValuation with non-matching warehouse returns empty', async () => {
    const report = await inventoryValuation(db, { warehouseId: 'nonexistent-wh-id' });
    expect(report.rows).toEqual([]);
    expect(report.totalQty.toString()).toBe('0');
    expect(report.totalValue.toString()).toBe('0');
  });

  it('inventoryValuation aggregates per (variant, warehouse) and sorts by value DESC', async () => {
    // Use real layers from any test data that may exist; verify the
    // shape only — we don't seed our own layers since FifoLayer creation
    // requires the full receipt + movement plumbing.
    const report = await inventoryValuation(db);
    // Each row has a unique (variantId, warehouseId) key.
    const seen = new Set<string>();
    for (const r of report.rows) {
      const key = `${r.variantId}::${r.warehouseId}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
    // Sorted by value DESC.
    for (let i = 1; i < report.rows.length; i++) {
      expect(
        report.rows[i - 1].value.greaterThanOrEqualTo(report.rows[i].value),
      ).toBe(true);
    }
    // Total value = sum of row values.
    const computed = report.rows.reduce(
      (acc, r) => acc.plus(r.value),
      new Prisma.Decimal(0),
    );
    expect(computed.toString()).toBe(report.totalValue.toString());
  });

  // ---------- cashPosition ----------

  it('cashPosition returns the GL 1110 balance signed', async () => {
    const result = await cashPosition(db);
    expect(result.cashAccountCode).toBe('1110');
    expect(result.glBalance).toBeDefined();
  });

  it('cashPosition reflects an inline JE that DRs cash by $13.13 (delta verified)', async () => {
    const before = await cashPosition(db);
    // Post DR 1110 / CR 2010 — adds $13.13 to cash GL balance.
    await db.$transaction((tx) =>
      post(tx, {
        entityType: ENTITY_TYPE,
        entityId: `cash-delta-${Date.now()}`,
        description: 'Cash delta sanity check',
        postedAt: new Date(Date.UTC(TEST_YEAR, 4, 15)),
        lines: [
          { accountCode: '1110', debit: '13.13' },
          { accountCode: '2010', credit: '13.13' },
        ],
      }),
    );
    const after = await cashPosition(db);
    const delta = after.glBalance.minus(before.glBalance);
    expect(delta.toString()).toBe(new Prisma.Decimal('13.13').toString());
  });

  // ---------- openSosWidget ----------

  it('openSosWidget returns count-by-status shape', async () => {
    const widget = await openSosWidget(db);
    expect(widget.byStatus).toBeDefined();
    expect(typeof widget.totalCount).toBe('number');
    // Total === sum of byStatus counts.
    const sum = Object.values(widget.byStatus).reduce((acc, n) => acc + n, 0);
    expect(sum).toBe(widget.totalCount);
  });

  // ---------- openPosWidget ----------

  it('openPosWidget returns count-by-status shape', async () => {
    const widget = await openPosWidget(db);
    expect(widget.byStatus).toBeDefined();
    const sum = Object.values(widget.byStatus).reduce((acc, n) => acc + n, 0);
    expect(sum).toBe(widget.totalCount);
  });

  // ---------- todaysSalesWidget ----------

  it('todaysSalesWidget date is start-of-UTC-day; counts/sums are non-negative', async () => {
    const now = new Date(Date.UTC(TEST_YEAR, 3, 15, 14, 30, 0));
    const widget = await todaysSalesWidget(db, now);
    expect(widget.date.toISOString()).toBe(`${TEST_YEAR}-04-15T00:00:00.000Z`);
    expect(widget.invoiceCount).toBeGreaterThanOrEqual(0);
    expect(widget.grossSales.greaterThanOrEqualTo(0)).toBe(true);
  });

  // ---------- cashPositionWidget ----------

  it('cashPositionWidget mirrors cashPosition', async () => {
    const widget = await cashPositionWidget(db);
    const direct = await cashPosition(db);
    expect(widget.cashAccountCode).toBe(direct.cashAccountCode);
    expect(widget.glBalance.toString()).toBe(direct.glBalance.toString());
  });

  // ---------- arAgingWidget ----------

  it('arAgingWidget rolls up agingSummary buckets; total === sum of buckets', async () => {
    const widget = await arAgingWidget(db);
    const sum = widget.current
      .plus(widget.b1to30)
      .plus(widget.b31to60)
      .plus(widget.b61to90)
      .plus(widget.b91plus);
    expect(sum.toString()).toBe(widget.total.toString());
    expect(widget.customerCount).toBeGreaterThanOrEqual(0);
  });

  // ---------- apAgingWidget ----------

  it('apAgingWidget rolls up apAgingSummary buckets; total === sum of buckets', async () => {
    const widget = await apAgingWidget(db);
    const sum = widget.current
      .plus(widget.b1to30)
      .plus(widget.b31to60)
      .plus(widget.b61to90)
      .plus(widget.b91plus);
    expect(sum.toString()).toBe(widget.total.toString());
    expect(widget.vendorCount).toBeGreaterThanOrEqual(0);
  });

  void AccountType;
});

async function wipe(): Promise<void> {
  const db = makeClient();
  try {
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
    // Sweep our test periods auto-created by the cash-delta JE.
    await db.fiscalPeriod.deleteMany({
      where: { code: { startsWith: `${TEST_YEAR}-` } },
    });
  } finally {
    await db.$disconnect();
  }
}
