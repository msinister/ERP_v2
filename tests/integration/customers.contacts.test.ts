import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Customer, PaymentTerm, PrismaClient, SalesRep } from '@/generated/tenant';
import { createCustomer } from '@/server/services/customers';
import {
  createContact,
  setPrimaryContact,
  softDeleteContact,
  updateContact,
} from '@/server/services/customerContacts';
import { hasTenantDb, makeClient } from '../helpers/db';

const suite = hasTenantDb ? describe : describe.skip;

const TAG = 'TEST-CUSTCT';

suite('Customer contacts — invariants', () => {
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
        line1: '1 St',
        city: 'Dallas',
        region: 'TX',
        postalCode: '75201',
      },
    });
  }

  it('CRUD round-trip', async () => {
    const c = await makeCustomer('CRUD');
    const created = await createContact(db, c.id, { name: 'Alice', role: 'Buyer' });
    expect(created.name).toBe('Alice');
    const updated = await updateContact(db, created.id, { name: 'Alice B', email: 'a@x.com' });
    expect(updated.name).toBe('Alice B');
    expect(updated.email).toBe('a@x.com');
    const deleted = await softDeleteContact(db, created.id);
    expect(deleted.deletedAt).not.toBeNull();
  });

  it('exactly one isPrimary per customer — setting a new primary clears the old', async () => {
    const c = await makeCustomer('P');
    const a = await createContact(db, c.id, { name: 'Alice', isPrimary: true });
    const b = await createContact(db, c.id, { name: 'Bob', isPrimary: false });
    await setPrimaryContact(db, b.id);

    const fresh = await db.customerContact.findMany({
      where: { customerId: c.id, deletedAt: null, isPrimary: true },
    });
    expect(fresh).toHaveLength(1);
    expect(fresh[0].id).toBe(b.id);
    expect((await db.customerContact.findUnique({ where: { id: a.id } }))!.isPrimary).toBe(false);
  });

  it('creating a new contact with isPrimary=true clears the previous primary', async () => {
    const c = await makeCustomer('NEW');
    const a = await createContact(db, c.id, { name: 'Alice', isPrimary: true });
    const b = await createContact(db, c.id, { name: 'Bob', isPrimary: true });
    expect(b.isPrimary).toBe(true);
    const refreshed = await db.customerContact.findUnique({ where: { id: a.id } });
    expect(refreshed!.isPrimary).toBe(false);
  });

  it('soft-delete clears isPrimary in the same tx', async () => {
    const c = await makeCustomer('SD');
    const a = await createContact(db, c.id, { name: 'Alice', isPrimary: true });
    const deleted = await softDeleteContact(db, a.id);
    expect(deleted.deletedAt).not.toBeNull();
    expect(deleted.isPrimary).toBe(false);

    // A new primary can be set without violating the partial unique index.
    const b = await createContact(db, c.id, { name: 'Bob', isPrimary: true });
    expect(b.isPrimary).toBe(true);
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
  const ourContacts = await db.customerContact.findMany({
    where: { customerId: { in: ids } },
    select: { id: true },
  });
  const contactIds = ourContacts.map((c) => c.id);
  await db.customerActivity.deleteMany({ where: { customerId: { in: ids } } });
  await db.customerContact.deleteMany({ where: { customerId: { in: ids } } });
  await db.customerAddress.deleteMany({ where: { customerId: { in: ids } } });
  await db.auditLog.deleteMany({
    where: { entityType: 'Customer', entityId: { in: ids } },
  });
  if (addressIds.length > 0) {
    await db.auditLog.deleteMany({
      where: { entityType: 'CustomerAddress', entityId: { in: addressIds } },
    });
  }
  if (contactIds.length > 0) {
    await db.auditLog.deleteMany({
      where: { entityType: 'CustomerContact', entityId: { in: contactIds } },
    });
  }
  await db.customer.deleteMany({ where: { id: { in: ids } } });
}
