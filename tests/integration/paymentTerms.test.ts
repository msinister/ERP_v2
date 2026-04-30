import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditAction } from '@/generated/tenant';
import type { PrismaClient } from '@/generated/tenant';
import {
  createPaymentTerm,
  getPaymentTerm,
  listPaymentTerms,
  softDeletePaymentTerm,
  updatePaymentTerm,
} from '@/server/services/paymentTerms';
import { hasTenantDb, makeClient } from '../helpers/db';

const suite = hasTenantDb ? describe : describe.skip;

const TEST_PREFIX = 'TEST-PT-';

suite('PaymentTerm service', () => {
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

  it('creates a term with uppercased code, audit row recorded', async () => {
    const term = await createPaymentTerm(db, {
      code: 'test-pt-net45',
      label: 'Net 45',
      netDays: 45,
    });
    expect(term.code).toBe('TEST-PT-NET45');
    expect(term.label).toBe('Net 45');
    expect(term.netDays).toBe(45);
    expect(term.active).toBe(true);

    const audits = await db.auditLog.findMany({
      where: { entityType: 'PaymentTerm', entityId: term.id },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe(AuditAction.CREATE);
  });

  it('updates label / netDays / active and writes UPDATE audit', async () => {
    const term = await createPaymentTerm(db, {
      code: 'TEST-PT-COD2',
      label: 'COD',
      netDays: null,
    });
    const updated = await updatePaymentTerm(db, term.id, {
      label: 'COD (revised)',
      netDays: 0,
      active: false,
    });
    expect(updated.label).toBe('COD (revised)');
    expect(updated.netDays).toBe(0);
    expect(updated.active).toBe(false);

    const audits = await db.auditLog.findMany({
      where: { entityType: 'PaymentTerm', entityId: term.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(audits.map((a) => a.action)).toEqual([AuditAction.CREATE, AuditAction.UPDATE]);
  });

  it('soft-delete refuses while a non-deleted Customer references the term', async () => {
    const term = await createPaymentTerm(db, {
      code: 'TEST-PT-INUSE',
      label: 'In Use',
      netDays: 15,
    });
    // Connect a customer to this term.
    const customer = await db.customer.create({
      data: {
        code: 'TEST-PT-REFCUST',
        name: 'Term Ref Customer',
        salesRep: { connect: { code: 'UNASSIGNED' } },
        paymentTerm: { connect: { id: term.id } },
      },
    });
    await expect(softDeletePaymentTerm(db, term.id)).rejects.toThrow(
      /1 customer\(s\) still reference it/,
    );

    // After soft-deleting the customer, the term can be soft-deleted.
    await db.customer.update({
      where: { id: customer.id },
      data: { deletedAt: new Date() },
    });
    const deleted = await softDeletePaymentTerm(db, term.id);
    expect(deleted.deletedAt).not.toBeNull();
  });

  it('getPaymentTerm hides soft-deleted rows', async () => {
    const term = await createPaymentTerm(db, {
      code: 'TEST-PT-HIDE',
      label: 'Hide me',
      netDays: null,
    });
    await softDeletePaymentTerm(db, term.id);
    const fetched = await getPaymentTerm(db, term.id);
    expect(fetched).toBeNull();
  });

  it('list filters by active', async () => {
    await createPaymentTerm(db, { code: 'TEST-PT-A', label: 'A', netDays: 30, active: true });
    await createPaymentTerm(db, { code: 'TEST-PT-B', label: 'B', netDays: 30, active: false });
    const allActive = await listPaymentTerms(db, { active: true });
    const ourActive = allActive.filter((t) => t.code.startsWith(TEST_PREFIX));
    expect(ourActive.map((t) => t.code).sort()).toEqual(['TEST-PT-A']);
  });
});

async function wipe(db: PrismaClient): Promise<void> {
  // Tear down only TEST-PT-* terms + their audit rows + the linked
  // TEST-PT-REFCUST customer if it exists. Leaves the seeded NET30 etc.
  // alone so other tests keep working.
  const ourTerms = await db.paymentTerm.findMany({
    where: { code: { startsWith: TEST_PREFIX } },
    select: { id: true },
  });
  const ourTermIds = ourTerms.map((t) => t.id);

  const ourCustomers = await db.customer.findMany({
    where: { code: 'TEST-PT-REFCUST' },
    select: { id: true },
  });

  if (ourCustomers.length > 0) {
    await db.auditLog.deleteMany({
      where: { entityType: 'Customer', entityId: { in: ourCustomers.map((c) => c.id) } },
    });
    await db.customer.deleteMany({ where: { id: { in: ourCustomers.map((c) => c.id) } } });
  }
  if (ourTermIds.length > 0) {
    await db.auditLog.deleteMany({
      where: { entityType: 'PaymentTerm', entityId: { in: ourTermIds } },
    });
    await db.paymentTerm.deleteMany({ where: { id: { in: ourTermIds } } });
  }
}
