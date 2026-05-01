import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Customer, PaymentTerm, PrismaClient, SalesRep } from '@/generated/tenant';
import { createCustomer } from '@/server/services/customers';
import {
  addAddress,
  setDefaultAddress,
  softDeleteAddress,
} from '@/server/services/customerAddresses';
import { hasTenantDb, makeClient } from '../helpers/db';

const suite = hasTenantDb ? describe : describe.skip;

const TAG = 'TEST-CUSTADDR';

suite('Customer addresses — invariants', () => {
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

  async function makeCustomer(name: string): Promise<Customer> {
    return createCustomer(db, {
      name: `${TAG} ${name}`,
      salesRepId: salesRep.id,
      paymentTermId: term.id,
      billingAddress: {
        kind: 'BILLING',
        line1: '1 Billing Way',
        city: 'Dallas',
        region: 'TX',
        postalCode: '75201',
      },
    });
  }

  it('exactly one default per (customerId, kind) — adding a new SHIPPING with isDefault=true clears the old one', async () => {
    const c = await makeCustomer('A');
    // Default ship-to A
    const a = await addAddress(db, c.id, {
      kind: 'SHIPPING',
      isDefault: true,
      line1: '500 A',
      city: 'Dallas',
      region: 'TX',
      postalCode: '75201',
    });
    // Default ship-to B (should clear A)
    const b = await addAddress(db, c.id, {
      kind: 'SHIPPING',
      isDefault: true,
      line1: '500 B',
      city: 'Dallas',
      region: 'TX',
      postalCode: '75201',
    });
    const fresh = await db.customerAddress.findMany({
      where: { customerId: c.id, kind: 'SHIPPING', deletedAt: null },
    });
    const defaults = fresh.filter((x) => x.isDefault);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].id).toBe(b.id);
    expect(fresh.find((x) => x.id === a.id)?.isDefault).toBe(false);
  });

  it('setDefaultAddress flips the flag atomically — no two defaults', async () => {
    const c = await makeCustomer('B');
    const a = await addAddress(db, c.id, {
      kind: 'SHIPPING',
      isDefault: true,
      line1: '1 A',
      city: 'Dallas',
      region: 'TX',
      postalCode: '75201',
    });
    const b = await addAddress(db, c.id, {
      kind: 'SHIPPING',
      isDefault: false,
      line1: '1 B',
      city: 'Dallas',
      region: 'TX',
      postalCode: '75201',
    });

    await setDefaultAddress(db, b.id);
    const fresh = await db.customerAddress.findMany({
      where: { customerId: c.id, kind: 'SHIPPING', deletedAt: null, isDefault: true },
    });
    expect(fresh).toHaveLength(1);
    expect(fresh[0].id).toBe(b.id);
    expect((await db.customerAddress.findUnique({ where: { id: a.id } }))!.isDefault).toBe(false);
  });

  it('concurrent setDefault calls serialize via FOR UPDATE — exactly one default at the end', async () => {
    const c = await makeCustomer('C');
    const a = await addAddress(db, c.id, {
      kind: 'SHIPPING',
      isDefault: true,
      line1: '1 A',
      city: 'Dallas',
      region: 'TX',
      postalCode: '75201',
    });
    const b = await addAddress(db, c.id, {
      kind: 'SHIPPING',
      isDefault: false,
      line1: '1 B',
      city: 'Dallas',
      region: 'TX',
      postalCode: '75201',
    });
    const d = await addAddress(db, c.id, {
      kind: 'SHIPPING',
      isDefault: false,
      line1: '1 D',
      city: 'Dallas',
      region: 'TX',
      postalCode: '75201',
    });

    const results = await Promise.allSettled([
      setDefaultAddress(db, b.id),
      setDefaultAddress(db, d.id),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);

    const defaults = await db.customerAddress.findMany({
      where: { customerId: c.id, kind: 'SHIPPING', deletedAt: null, isDefault: true },
    });
    expect(defaults).toHaveLength(1);

    // None of the rows is in an unexpected state.
    const all = await db.customerAddress.findMany({
      where: { customerId: c.id, kind: 'SHIPPING', deletedAt: null },
    });
    const trueCount = all.filter((x) => x.isDefault).length;
    expect(trueCount).toBe(1);
    void a;
  });

  it('soft-deleting a default address clears the isDefault flag in the same tx', async () => {
    const c = await makeCustomer('D');
    const a = await addAddress(db, c.id, {
      kind: 'SHIPPING',
      isDefault: true,
      line1: '1 A',
      city: 'Dallas',
      region: 'TX',
      postalCode: '75201',
    });
    expect(a.isDefault).toBe(true);

    const deleted = await softDeleteAddress(db, a.id);
    expect(deleted.deletedAt).not.toBeNull();
    expect(deleted.isDefault).toBe(false); // ← key assertion

    // A new default for the same kind can now be set without violating
    // the partial unique index.
    const b = await addAddress(db, c.id, {
      kind: 'SHIPPING',
      isDefault: true,
      line1: '1 B',
      city: 'Dallas',
      region: 'TX',
      postalCode: '75201',
    });
    expect(b.isDefault).toBe(true);
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
