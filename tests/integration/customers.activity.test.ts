import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CustomerActivityKind,
  CustomerType,
  Prisma,
} from '@/generated/tenant';
import type { Customer, PaymentTerm, PrismaClient, SalesRep } from '@/generated/tenant';
import { createCustomer, updateCustomer } from '@/server/services/customers';
import {
  addManualEntry,
  listActivity,
} from '@/server/services/customerActivities';
import { hasTenantDb, makeClient } from '../helpers/db';

const suite = hasTenantDb ? describe : describe.skip;

const TAG = 'TEST-CACT';

suite('CustomerActivity service', () => {
  let db: PrismaClient;
  let salesRep: SalesRep;
  let altRep: SalesRep;
  let term: PaymentTerm;

  beforeAll(async () => {
    db = makeClient();
    salesRep = await db.salesRep.findFirstOrThrow({ where: { code: 'UNASSIGNED' } });
    term = await db.paymentTerm.findFirstOrThrow({ where: { code: 'NET30' } });
    altRep = await db.salesRep.upsert({
      where: { code: `${TAG}-REP-ALT` },
      create: { code: `${TAG}-REP-ALT`, name: 'Alt Rep' },
      update: { active: true, deletedAt: null },
    });
  });

  beforeEach(async () => {
    await wipe(db);
  });

  afterAll(async () => {
    await wipe(db);
    await db.salesRep.deleteMany({ where: { code: { startsWith: `${TAG}-REP` } } });
    await db.$disconnect();
  });

  async function makeCustomer(name: string, overrides: Partial<Parameters<typeof createCustomer>[1]> = {}): Promise<Customer> {
    return createCustomer(db, {
      name: `${TAG} ${name}`,
      salesRepId: salesRep.id,
      paymentTermId: term.id,
      billingAddress: {
        kind: 'BILLING',
        line1: '1 St',
        city: 'Dallas',
        region: 'TX',
        postalCode: '75201',
      },
      ...overrides,
    });
  }

  it('addManualEntry creates a MANUAL row, summary set, detailJson null', async () => {
    const c = await makeCustomer('M');
    const entry = await addManualEntry(db, c.id, { summary: 'Called Jane re: Q3 order' });
    expect(entry.kind).toBe(CustomerActivityKind.MANUAL);
    expect(entry.summary).toBe('Called Jane re: Q3 order');
    expect(entry.detailJson).toBeNull();
  });

  it('AUTO entry on credit-limit change has the documented { field, from, to } shape', async () => {
    const c = await makeCustomer('CL', { creditLimit: '1000' });
    await updateCustomer(db, c.id, { creditLimit: '2500' });
    const acts = await db.customerActivity.findMany({
      where: { customerId: c.id, summary: 'creditLimit_changed' },
    });
    expect(acts).toHaveLength(1);
    const detail = acts[0].detailJson as { field: string; from: string | null; to: string | null };
    expect(detail).toEqual({
      field: 'creditLimit',
      from: new Prisma.Decimal('1000').toString(),
      to: new Prisma.Decimal('2500').toString(),
    });
  });

  it('AUTO entry on multi-field update writes one row per tracked field', async () => {
    const c = await makeCustomer('MF');
    await updateCustomer(db, c.id, {
      type: CustomerType.WHOLESALE_DISTRIBUTOR,
      salesRepId: altRep.id,
      taxExempt: true,
    });
    const auto = await db.customerActivity.findMany({
      where: {
        customerId: c.id,
        kind: CustomerActivityKind.AUTO,
        summary: { endsWith: '_changed' },
      },
    });
    const summaries = auto.map((a) => a.summary).sort();
    expect(summaries).toEqual(['salesRepId_changed', 'taxExempt_changed', 'type_changed']);
  });

  it('listActivity orders by createdAt DESC', async () => {
    const c = await makeCustomer('ORD');
    const a = await addManualEntry(db, c.id, { summary: 'first' });
    // Small delay so the second row's createdAt is strictly later.
    await new Promise((r) => setTimeout(r, 10));
    const b = await addManualEntry(db, c.id, { summary: 'second' });
    const list = await listActivity(db, c.id, { kind: CustomerActivityKind.MANUAL });
    const ids = list.map((x) => x.id);
    // b (newer) before a (older).
    expect(ids.indexOf(b.id)).toBeLessThan(ids.indexOf(a.id));
  });

  it('listActivity date-range filter', async () => {
    const c = await makeCustomer('DR');
    await addManualEntry(db, c.id, { summary: 'window-entry' });
    // Backdate one row past the cutoff.
    const old = await db.customerActivity.create({
      data: {
        customerId: c.id,
        kind: CustomerActivityKind.MANUAL,
        summary: 'old-entry',
        createdAt: new Date('2025-01-01T00:00:00Z'),
      },
    });
    const since = new Date('2025-06-01T00:00:00Z');
    const recent = await listActivity(db, c.id, { from: since });
    expect(recent.find((x) => x.id === old.id)).toBeUndefined();
    expect(recent.find((x) => x.summary === 'window-entry')).toBeDefined();
  });

  it('listActivity kind filter — MANUAL only', async () => {
    const c = await makeCustomer('K');
    await addManualEntry(db, c.id, { summary: 'manual-1' });
    await updateCustomer(db, c.id, { creditLimit: '999' }); // generates AUTO
    const manual = await listActivity(db, c.id, { kind: CustomerActivityKind.MANUAL });
    expect(manual.every((x) => x.kind === CustomerActivityKind.MANUAL)).toBe(true);
    expect(manual.find((x) => x.summary === 'manual-1')).toBeDefined();
    const auto = await listActivity(db, c.id, { kind: CustomerActivityKind.AUTO });
    expect(auto.every((x) => x.kind === CustomerActivityKind.AUTO)).toBe(true);
  });

  it('listActivity excludes other customers activity', async () => {
    const a = await makeCustomer('SCOPE-A');
    const b = await makeCustomer('SCOPE-B');
    await addManualEntry(db, a.id, { summary: 'A-only' });
    await addManualEntry(db, b.id, { summary: 'B-only' });
    const aList = await listActivity(db, a.id, { kind: CustomerActivityKind.MANUAL });
    expect(aList.every((x) => x.customerId === a.id)).toBe(true);
    expect(aList.find((x) => x.summary === 'B-only')).toBeUndefined();
  });
});

async function wipe(db: PrismaClient): Promise<void> {
  const customers = await db.customer.findMany({
    where: { name: { startsWith: TAG } },
    select: { id: true },
  });
  const ids = customers.map((c) => c.id);
  if (ids.length === 0) return;
  const ourAddresses = await db.customerAddress.findMany({
    where: { customerId: { in: ids } },
    select: { id: true },
  });
  const addressIds = ourAddresses.map((a) => a.id);
  const ourActivities = await db.customerActivity.findMany({
    where: { customerId: { in: ids } },
    select: { id: true },
  });
  const activityIds = ourActivities.map((a) => a.id);
  await db.customerActivity.deleteMany({ where: { customerId: { in: ids } } });
  await db.customerAddress.deleteMany({ where: { customerId: { in: ids } } });
  await db.auditLog.deleteMany({
    where: { entityType: 'Customer', entityId: { in: ids } },
  });
  if (addressIds.length > 0) {
    await db.auditLog.deleteMany({
      where: { entityType: 'CustomerAddress', entityId: { in: addressIds } },
    });
  }
  if (activityIds.length > 0) {
    await db.auditLog.deleteMany({
      where: { entityType: 'CustomerActivity', entityId: { in: activityIds } },
    });
  }
  await db.customer.deleteMany({ where: { id: { in: ids } } });
}
