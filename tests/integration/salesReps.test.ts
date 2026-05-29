import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditAction, Prisma } from '@/generated/tenant';
import type { PrismaClient } from '@/generated/tenant';
import {
  createSalesRep,
  findRepByEmail,
  getSalesRep,
  linkUserToExistingRep,
  listLinkableUsers,
  listSalesReps,
  listUnlinkedReps,
  softDeleteSalesRep,
  unlinkUserSalesRep,
  updateSalesRep,
} from '@/server/services/salesReps';
import { hasTenantDb, makeClient } from '../helpers/db';

const suite = hasTenantDb ? describe : describe.skip;

const TEST_PREFIX = 'TEST-SR-';
const TEST_USER_PREFIX = 'test-sr-user';

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

  it('createSalesRep with linkUserId points the user at the new rep', async () => {
    const user = await makeUser(db, 'link1');
    const rep = await createSalesRep(db, {
      code: 'TEST-SR-LINK1',
      name: 'Linked Rep',
      linkUserId: user.id,
    });
    const refreshed = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(refreshed.salesRepId).toBe(rep.id);
    // User link writes its own UPDATE audit row.
    const userAudits = await db.auditLog.findMany({
      where: { entityType: 'User', entityId: user.id, action: AuditAction.UPDATE },
    });
    expect(userAudits.length).toBeGreaterThanOrEqual(1);
  });

  it('updateSalesRep linkUserId=null unlinks; a userId links', async () => {
    const user = await makeUser(db, 'link2');
    const rep = await createSalesRep(db, { code: 'TEST-SR-LINK2', name: 'Rep2' });

    await updateSalesRep(db, rep.id, { linkUserId: user.id });
    expect(
      (await db.user.findUniqueOrThrow({ where: { id: user.id } })).salesRepId,
    ).toBe(rep.id);

    await updateSalesRep(db, rep.id, { linkUserId: null });
    expect(
      (await db.user.findUniqueOrThrow({ where: { id: user.id } })).salesRepId,
    ).toBeNull();
  });

  it('updateSalesRep refuses to steal a user linked to another rep', async () => {
    const user = await makeUser(db, 'link3');
    const repA = await createSalesRep(db, { code: 'TEST-SR-LINK3A', name: 'A3' });
    const repB = await createSalesRep(db, { code: 'TEST-SR-LINK3B', name: 'B3' });
    await updateSalesRep(db, repA.id, { linkUserId: user.id });
    await expect(
      updateSalesRep(db, repB.id, { linkUserId: user.id }),
    ).rejects.toThrow(/already linked to a different sales rep/);
  });

  it('listLinkableUsers excludes users linked to other reps, includes own', async () => {
    const free = await makeUser(db, 'free');
    const taken = await makeUser(db, 'taken');
    const rep = await createSalesRep(db, { code: 'TEST-SR-OWN', name: 'Own' });
    const otherRep = await createSalesRep(db, { code: 'TEST-SR-OTHER', name: 'Other' });
    await updateSalesRep(db, otherRep.id, { linkUserId: taken.id });
    await updateSalesRep(db, rep.id, { linkUserId: free.id });

    const linkable = await listLinkableUsers(db, { includeRepId: rep.id });
    const ids = linkable.map((u) => u.id);
    expect(ids).toContain(free.id); // linked to rep we're editing → still offered
    expect(ids).not.toContain(taken.id); // linked elsewhere → hidden
  });

  it('linkUserToExistingRep links a user to an existing rep + audits', async () => {
    const user = await makeUser(db, 'existing1');
    const rep = await createSalesRep(db, { code: 'TEST-SR-EXIST1', name: 'Exist1' });
    const linked = await linkUserToExistingRep(db, user.id, rep.id);
    expect(linked.id).toBe(rep.id);
    expect(
      (await db.user.findUniqueOrThrow({ where: { id: user.id } })).salesRepId,
    ).toBe(rep.id);
    const audits = await db.auditLog.findMany({
      where: { entityType: 'User', entityId: user.id, action: AuditAction.UPDATE },
    });
    expect(audits.length).toBeGreaterThanOrEqual(1);
  });

  it('linkUserToExistingRep switches a user from one rep to another', async () => {
    const user = await makeUser(db, 'existing2');
    const repA = await createSalesRep(db, { code: 'TEST-SR-EXIST2A', name: 'A2' });
    const repB = await createSalesRep(db, { code: 'TEST-SR-EXIST2B', name: 'B2' });
    await linkUserToExistingRep(db, user.id, repA.id);
    await linkUserToExistingRep(db, user.id, repB.id);
    expect(
      (await db.user.findUniqueOrThrow({ where: { id: user.id } })).salesRepId,
    ).toBe(repB.id);
    // repA is left in place, now unlinked.
    expect(
      await db.user.findFirst({ where: { salesRepId: repA.id } }),
    ).toBeNull();
  });

  it('linkUserToExistingRep refuses a rep already linked to another user', async () => {
    const userA = await makeUser(db, 'existing3a');
    const userB = await makeUser(db, 'existing3b');
    const rep = await createSalesRep(db, { code: 'TEST-SR-EXIST3', name: 'Exist3' });
    await linkUserToExistingRep(db, userA.id, rep.id);
    await expect(
      linkUserToExistingRep(db, userB.id, rep.id),
    ).rejects.toThrow(/already linked to another user/);
  });

  it('listUnlinkedReps excludes linked reps', async () => {
    const user = await makeUser(db, 'unlinked1');
    const free = await createSalesRep(db, { code: 'TEST-SR-FREE', name: 'Free' });
    const taken = await createSalesRep(db, { code: 'TEST-SR-TAKEN', name: 'Taken' });
    await linkUserToExistingRep(db, user.id, taken.id);

    const unlinked = await listUnlinkedReps(db);
    const ourCodes = unlinked
      .filter((r) => r.code.startsWith(TEST_PREFIX))
      .map((r) => r.code);
    expect(ourCodes).toContain(free.code);
    expect(ourCodes).not.toContain(taken.code);

    // After unlinking, the rep reappears.
    await unlinkUserSalesRep(db, user.id);
    const after = await listUnlinkedReps(db);
    expect(after.map((r) => r.code)).toContain(taken.code);
  });

  it('findRepByEmail matches case-insensitively and honors exclude', async () => {
    const rep = await createSalesRep(db, {
      code: 'TEST-SR-EMAIL',
      name: 'Email Rep',
      email: 'Dup@Example.com',
    });
    const hit = await findRepByEmail(db, 'dup@example.com');
    expect(hit?.id).toBe(rep.id);
    const excluded = await findRepByEmail(db, 'dup@example.com', rep.id);
    expect(excluded).toBeNull();
  });
});

async function makeUser(
  db: PrismaClient,
  slug: string,
): Promise<{ id: string; email: string }> {
  return db.user.create({
    data: {
      email: `${TEST_USER_PREFIX}-${slug}@example.com`,
      name: `Test ${slug}`,
    },
    select: { id: true, email: true },
  });
}

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

  // Test users that may be linked to our reps — clear the link first so the
  // SalesRep rows delete cleanly, then remove the users + their audit rows.
  const ourUsers = await db.user.findMany({
    where: { email: { startsWith: TEST_USER_PREFIX } },
    select: { id: true },
  });
  const ourUserIds = ourUsers.map((u) => u.id);

  if (ourUserIds.length > 0) {
    await db.user.updateMany({
      where: { id: { in: ourUserIds } },
      data: { salesRepId: null },
    });
    await db.auditLog.deleteMany({
      where: { entityType: 'User', entityId: { in: ourUserIds } },
    });
    await db.user.deleteMany({ where: { id: { in: ourUserIds } } });
  }

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
