import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditAction, Prisma } from '@/generated/tenant';
import type { PrismaClient } from '@/generated/tenant';
import {
  createSalesRep,
  getSalesRep,
  listSalesReps,
  softDeleteSalesRep,
  updateSalesRep,
} from '@/server/services/salesReps';
import { hasTenantDb, makeClient } from '../helpers/db';

const suite = hasTenantDb ? describe : describe.skip;

const TEST_PREFIX = 'TEST-SR-';

suite('SalesRep service', () => {
  let db: PrismaClient;

  beforeAll(async () => {
    db = makeClient();
  });

  beforeEach(async () => {
    await wipe(db);
  });

  afterAll(async () => {
    await wipe(db);
    await db.$disconnect();
  });

  it('creates a rep with uppercased code, audit row recorded', async () => {
    const rep = await createSalesRep(db, {
      code: 'test-sr-alice',
      name: 'Alice',
      email: 'alice@example.com',
      commissionBasis: 'REVENUE',
      commissionPercent: '5.5',
    });
    expect(rep.code).toBe('TEST-SR-ALICE');
    expect(rep.name).toBe('Alice');
    expect(rep.commissionBasis).toBe('REVENUE');
    expect(rep.commissionPercent?.toString()).toBe(new Prisma.Decimal('5.5').toString());

    const audits = await db.auditLog.findMany({
      where: { entityType: 'SalesRep', entityId: rep.id },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe(AuditAction.CREATE);
  });

  it('updates fields and writes UPDATE audit', async () => {
    const rep = await createSalesRep(db, { code: 'TEST-SR-BOB', name: 'Bob' });
    const updated = await updateSalesRep(db, rep.id, {
      name: 'Robert',
      email: 'robert@example.com',
      commissionBasis: 'MARGIN',
      commissionPercent: '7.25',
      active: false,
    });
    expect(updated.name).toBe('Robert');
    expect(updated.commissionBasis).toBe('MARGIN');
    expect(updated.active).toBe(false);

    const audits = await db.auditLog.findMany({
      where: { entityType: 'SalesRep', entityId: rep.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(audits.map((a) => a.action)).toEqual([AuditAction.CREATE, AuditAction.UPDATE]);
  });

  it('refuses to soft-delete the permanent UNASSIGNED rep', async () => {
    const unassigned = await db.salesRep.findFirstOrThrow({ where: { code: 'UNASSIGNED' } });
    await expect(softDeleteSalesRep(db, unassigned.id)).rejects.toThrow(
      /Cannot soft-delete the permanent UNASSIGNED/,
    );
  });

  it('soft-delete refuses while a non-deleted Customer references the rep', async () => {
    const rep = await createSalesRep(db, { code: 'TEST-SR-INUSE', name: 'In Use Rep' });
    const customer = await db.customer.create({
      data: {
        code: 'TEST-SR-REFCUST',
        name: 'SR Ref Customer',
        salesRep: { connect: { id: rep.id } },
        paymentTerm: { connect: { code: 'NET30' } },
      },
    });
    await expect(softDeleteSalesRep(db, rep.id)).rejects.toThrow(
      /1 customer\(s\) still reference it/,
    );

    await db.customer.update({
      where: { id: customer.id },
      data: { deletedAt: new Date() },
    });
    const deleted = await softDeleteSalesRep(db, rep.id);
    expect(deleted.deletedAt).not.toBeNull();
  });

  it('getSalesRep hides soft-deleted rows', async () => {
    const rep = await createSalesRep(db, { code: 'TEST-SR-HIDE', name: 'Hide Me' });
    await softDeleteSalesRep(db, rep.id);
    const fetched = await getSalesRep(db, rep.id);
    expect(fetched).toBeNull();
  });

  it('list filters by active', async () => {
    await createSalesRep(db, { code: 'TEST-SR-A', name: 'A', active: true });
    await createSalesRep(db, { code: 'TEST-SR-B', name: 'B', active: false });
    const all = await listSalesReps(db, { active: true });
    const ours = all.filter((r) => r.code.startsWith(TEST_PREFIX));
    expect(ours.map((r) => r.code).sort()).toEqual(['TEST-SR-A']);
  });
});

async function wipe(db: PrismaClient): Promise<void> {
  const ourReps = await db.salesRep.findMany({
    where: { code: { startsWith: TEST_PREFIX } },
    select: { id: true },
  });
  const ourRepIds = ourReps.map((r) => r.id);

  const ourCustomers = await db.customer.findMany({
    where: { code: 'TEST-SR-REFCUST' },
    select: { id: true },
  });

  if (ourCustomers.length > 0) {
    await db.auditLog.deleteMany({
      where: { entityType: 'Customer', entityId: { in: ourCustomers.map((c) => c.id) } },
    });
    await db.customer.deleteMany({ where: { id: { in: ourCustomers.map((c) => c.id) } } });
  }
  if (ourRepIds.length > 0) {
    await db.auditLog.deleteMany({
      where: { entityType: 'SalesRep', entityId: { in: ourRepIds } },
    });
    await db.salesRep.deleteMany({ where: { id: { in: ourRepIds } } });
  }
}
