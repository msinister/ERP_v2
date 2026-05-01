import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PaymentTerm, PrismaClient, SalesRep } from '@/generated/tenant';
import {
  createCustomer,
  findDuplicateCandidates,
} from '@/server/services/customers';
import { hasTenantDb, makeClient } from '../helpers/db';

const suite = hasTenantDb ? describe : describe.skip;

const TAG = 'TEST-CUSTDUP';

suite('Customer findDuplicateCandidates', () => {
  let db: PrismaClient;
  let salesRep: SalesRep;
  let term: PaymentTerm;

  beforeAll(async () => {
    db = makeClient();
    salesRep = await db.salesRep.findFirstOrThrow({ where: { code: 'UNASSIGNED' } });
    term = await db.paymentTerm.findFirstOrThrow({ where: { code: 'NET30' } });
  });

  beforeEach(async () => {
    await wipe(db);
  });

  afterAll(async () => {
    await wipe(db);
    await db.$disconnect();
  });

  function buildInput(name: string, city: string) {
    return {
      name,
      salesRepId: salesRep.id,
      paymentTermId: term.id,
      billingAddress: {
        kind: 'BILLING' as const,
        line1: '1 St',
        city,
        region: 'TX',
        postalCode: '75201',
      },
      defaultShippingAddress: {
        kind: 'SHIPPING' as const,
        line1: '1 St',
        city,
        region: 'TX',
        postalCode: '75201',
        isDefault: true,
      },
    };
  }

  it('matches by name substring case-insensitively (citext)', async () => {
    await createCustomer(db, buildInput(`${TAG} Smoke Shop Plus`, 'Dallas'));
    const matches = await findDuplicateCandidates(db, { name: 'smoke shop plus' });
    const ours = matches.filter((m) => m.name.startsWith(TAG));
    expect(ours).toHaveLength(1);
    expect(ours[0].name).toBe(`${TAG} Smoke Shop Plus`);
  });

  it('prioritizes same-city matches over different-city matches (AND, not OR)', async () => {
    await createCustomer(db, buildInput(`${TAG} Smoke Shop Plus (Houston)`, 'Houston'));
    await createCustomer(db, buildInput(`${TAG} Smoke Shop Plus (Dallas)`, 'Dallas'));
    await createCustomer(db, buildInput(`${TAG} Glass World (Dallas)`, 'Dallas'));

    const matches = await findDuplicateCandidates(db, {
      name: `${TAG} Smoke Shop Plus`,
      city: 'Dallas',
    });

    // Expect only the two name-match rows; the Glass World row should NOT
    // be flagged as a duplicate just because it shares a city.
    const names = matches.map((m) => m.name);
    expect(names).not.toContain(`${TAG} Glass World (Dallas)`);
    expect(names).toContain(`${TAG} Smoke Shop Plus (Dallas)`);
    expect(names).toContain(`${TAG} Smoke Shop Plus (Houston)`);
    // Same-city result sorts first.
    expect(names[0]).toBe(`${TAG} Smoke Shop Plus (Dallas)`);
  });

  it('returns at most 5 results', async () => {
    for (let i = 1; i <= 7; i++) {
      await createCustomer(db, buildInput(`${TAG} Dup ${i}`, 'Dallas'));
    }
    const matches = await findDuplicateCandidates(db, { name: `${TAG} Dup`, city: 'Dallas' });
    expect(matches.length).toBeLessThanOrEqual(5);
  });

  it('display-name unique constraint — two customers with the same name (case-insensitive) cannot coexist', async () => {
    await createCustomer(db, buildInput(`${TAG} Unique Co`, 'Dallas'));
    await expect(
      createCustomer(db, buildInput(`${TAG} UNIQUE CO`, 'Houston')),
    ).rejects.toThrow();
  });
});

async function wipe(db: PrismaClient): Promise<void> {
  const ours = await db.customer.findMany({
    where: { name: { startsWith: TAG } },
    select: { id: true },
  });
  const ids = ours.map((o) => o.id);
  if (ids.length === 0) return;
  const ourAddresses = await db.customerAddress.findMany({
    where: { customerId: { in: ids } },
    select: { id: true },
  });
  const addressIds = ourAddresses.map((a) => a.id);
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
  await db.customer.deleteMany({ where: { id: { in: ids } } });
}
