import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient, SalesRep, Customer, Warehouse } from '@/generated/tenant';
import { salesByRepWidget } from '@/server/services/reports/dashboard';
import { hasTenantDb, makeClient } from '../helpers/db';
import { upsertTestWarehouse } from '../helpers/warehouseStub';

const suite = hasTenantDb ? describe : describe.skip;
const TAG = 'TST-SBR';

// Fixed "now" = Aug 15, 2096 (Q3) so the period windows are deterministic:
//   This Month  = Aug 1 → Aug 15
//   Last Month  = Jul 1 → Jul 31
//   This Quarter= Jul 1 → Aug 15
//   YTD         = Jan 1 → Aug 15
const NOW = new Date(Date.UTC(2096, 7, 15));
const d = (y: number, mo: number, day: number) => new Date(Date.UTC(y, mo, day));

suite('salesByRepWidget', () => {
  let db: PrismaClient;
  let wh: Warehouse;
  let repA: SalesRep;
  let repB: SalesRep;
  let unassignedRep: SalesRep;
  let custA: Customer; // rep = repA
  let custU: Customer; // rep = UNASSIGNED sentinel

  async function wipe() {
    await db.invoice.deleteMany({ where: { number: { startsWith: TAG } } });
    await db.salesOrder.deleteMany({ where: { number: { startsWith: TAG } } });
    await db.customer.deleteMany({ where: { code: { startsWith: TAG } } });
    await db.salesRep.deleteMany({ where: { code: { startsWith: TAG } } });
    await db.warehouse.deleteMany({ where: { code: { startsWith: TAG } } });
  }

  beforeAll(async () => {
    db = makeClient();
    await wipe();
    wh = await upsertTestWarehouse(db, { code: `${TAG}-WH`, name: 'SBR WH' });
    unassignedRep = await db.salesRep.findFirstOrThrow({
      where: { code: 'UNASSIGNED' },
    });
    repA = await db.salesRep.create({
      data: { code: `${TAG}-A`, name: 'Rep Alpha' },
    });
    repB = await db.salesRep.create({
      data: { code: `${TAG}-B`, name: 'Rep Beta' },
    });
    custA = await db.customer.create({
      data: {
        code: `${TAG}-CA`,
        name: `${TAG} Customer A`,
        salesRep: { connect: { id: repA.id } },
        paymentTerm: { connect: { code: 'NET30' } },
      },
    });
    custU = await db.customer.create({
      data: {
        code: `${TAG}-CU`,
        name: `${TAG} Customer U`,
        salesRep: { connect: { id: unassignedRep.id } },
        paymentTerm: { connect: { code: 'NET30' } },
      },
    });

    // SO that overrides custA's rep (repA) with repB.
    const soB = await db.salesOrder.create({
      data: {
        number: `${TAG}-SO1`,
        customer: { connect: { id: custA.id } },
        warehouse: { connect: { id: wh.id } },
        salesRep: { connect: { id: repB.id } },
      },
    });

    async function inv(args: {
      n: string;
      customerId: string;
      date: Date;
      total: string;
      salesOrderId?: string;
    }) {
      await db.invoice.create({
        data: {
          number: args.n,
          customer: { connect: { id: args.customerId } },
          warehouse: { connect: { id: wh.id } },
          ...(args.salesOrderId
            ? { salesOrder: { connect: { id: args.salesOrderId } } }
            : {}),
          subtotal: args.total,
          total: args.total,
          invoiceDate: args.date,
        },
      });
    }

    // repA (via custA, no SO override):
    await inv({ n: `${TAG}-I1`, customerId: custA.id, date: d(2096, 7, 10), total: '100' }); // Aug → month+qtr+ytd
    await inv({ n: `${TAG}-I2`, customerId: custA.id, date: d(2096, 6, 10), total: '50' }); // Jul → lastMonth+qtr+ytd
    await inv({ n: `${TAG}-I3`, customerId: custA.id, date: d(2096, 2, 5), total: '30' }); // Mar → ytd only
    // repB (via SO override on a custA invoice):
    await inv({
      n: `${TAG}-I4`,
      customerId: custA.id,
      date: d(2096, 7, 12),
      total: '200',
      salesOrderId: soB.id,
    }); // Aug → month+qtr+ytd, attributed to repB
    // Unassigned (custU → UNASSIGNED sentinel rep):
    await inv({ n: `${TAG}-I5`, customerId: custU.id, date: d(2096, 7, 1), total: '10' }); // Aug
    // Out of window: prior-year December (not last-month for August, before YTD):
    await inv({ n: `${TAG}-I6`, customerId: custA.id, date: d(2095, 11, 15), total: '999' });
  });

  afterAll(async () => {
    await wipe();
    await db.$disconnect();
  });

  it('buckets by effective rep across the four periods', async () => {
    const w = await salesByRepWidget(db, NOW);

    const a = w.rows.find((r) => r.salesRepId === repA.id);
    const b = w.rows.find((r) => r.salesRepId === repB.id);
    expect(a).toBeDefined();
    expect(b).toBeDefined();

    // repA: I1(100 Aug) + I2(50 Jul) + I3(30 Mar). I6(999 Dec'95) excluded.
    expect(a!.thisMonth.toString()).toBe('100');
    expect(a!.lastMonth.toString()).toBe('50');
    expect(a!.thisQuarter.toString()).toBe('150');
    expect(a!.ytd.toString()).toBe('180');

    // repB: I4(200 Aug) via SO override — proves SO.salesRepId wins over
    // the customer's repA.
    expect(b!.thisMonth.toString()).toBe('200');
    expect(b!.lastMonth.toString()).toBe('0');
    expect(b!.thisQuarter.toString()).toBe('200');
    expect(b!.ytd.toString()).toBe('200');
  });

  it('sorts by YTD desc and pins Unassigned last', async () => {
    const w = await salesByRepWidget(db, NOW);
    const idxB = w.rows.findIndex((r) => r.salesRepId === repB.id);
    const idxA = w.rows.findIndex((r) => r.salesRepId === repA.id);
    // repB (ytd 200) outranks repA (ytd 180).
    expect(idxB).toBeGreaterThanOrEqual(0);
    expect(idxB).toBeLessThan(idxA);

    // The UNASSIGNED sentinel folds into a single null-id row, pinned last.
    const unassigned = w.rows.find((r) => r.salesRepId === null);
    expect(unassigned).toBeDefined();
    expect(unassigned!.salesRepName).toBe('Unassigned');
    expect(unassigned!.thisMonth.toString()).toBe('10');
    expect(w.rows[w.rows.length - 1].salesRepId).toBeNull();
  });

  it('totals include every period contribution', async () => {
    const w = await salesByRepWidget(db, NOW);
    // Tolerant lower bounds (the shared dev DB may hold unrelated 2096
    // invoices); our seed contributes the amounts below.
    expect(Number(w.totals.thisMonth)).toBeGreaterThanOrEqual(310); // 100+200+10
    expect(Number(w.totals.lastMonth)).toBeGreaterThanOrEqual(50);
    expect(Number(w.totals.thisQuarter)).toBeGreaterThanOrEqual(360); // 150+200+10
    expect(Number(w.totals.ytd)).toBeGreaterThanOrEqual(390); // 180+200+10
  });
});
