import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PaymentTerm, PrismaClient, Vendor } from '@/generated/tenant';
import { createVendor } from '@/server/services/vendors';
import {
  createVendorContact,
  setPrimaryVendorContact,
  softDeleteVendorContact,
  updateVendorContact,
} from '@/server/services/vendorContacts';
import { hasTenantDb, makeClient } from '../helpers/db';

const suite = hasTenantDb ? describe : describe.skip;

const TAG = 'TEST-VENDCT';

suite('Vendor contacts — invariants', () => {
  let db: PrismaClient;
  let term: PaymentTerm;

  beforeAll(async () => {
    db = makeClient();
    term = await db.paymentTerm.findFirstOrThrow({ where: { code: 'NET30' } });
  });

  beforeEach(async () => {
    await wipe(db);
  });

  afterAll(async () => {
    await wipe(db);
    await db.$disconnect();
  });

  async function makeVendor(name: string): Promise<Vendor> {
    return createVendor(db, {
      name: `${TAG} ${name}`,
      paymentTermId: term.id,
    });
  }

  it('CRUD round-trip', async () => {
    const v = await makeVendor('CRUD');
    const created = await createVendorContact(db, v.id, { name: 'Sam', role: 'AR' });
    expect(created.name).toBe('Sam');
    const updated = await updateVendorContact(db, created.id, {
      name: 'Sam B',
      email: 's@x.com',
    });
    expect(updated.name).toBe('Sam B');
    expect(updated.email).toBe('s@x.com');
    const deleted = await softDeleteVendorContact(db, created.id);
    expect(deleted.deletedAt).not.toBeNull();
  });

  it('exactly one isPrimary per vendor — setting a new primary clears the old', async () => {
    const v = await makeVendor('P');
    const a = await createVendorContact(db, v.id, { name: 'Alice', isPrimary: true });
    const b = await createVendorContact(db, v.id, { name: 'Bob', isPrimary: false });
    await setPrimaryVendorContact(db, b.id);
    const fresh = await db.vendorContact.findMany({
      where: { vendorId: v.id, deletedAt: null, isPrimary: true },
    });
    expect(fresh).toHaveLength(1);
    expect(fresh[0].id).toBe(b.id);
    expect(
      (await db.vendorContact.findUnique({ where: { id: a.id } }))!.isPrimary,
    ).toBe(false);
  });

  it('creating a new contact with isPrimary=true clears previous primary', async () => {
    const v = await makeVendor('NEW');
    const a = await createVendorContact(db, v.id, { name: 'Alice', isPrimary: true });
    const b = await createVendorContact(db, v.id, { name: 'Bob', isPrimary: true });
    expect(b.isPrimary).toBe(true);
    const refreshed = await db.vendorContact.findUnique({ where: { id: a.id } });
    expect(refreshed!.isPrimary).toBe(false);
  });

  it('soft-delete clears isPrimary in the same tx', async () => {
    const v = await makeVendor('SD');
    const a = await createVendorContact(db, v.id, { name: 'Alice', isPrimary: true });
    const deleted = await softDeleteVendorContact(db, a.id);
    expect(deleted.deletedAt).not.toBeNull();
    expect(deleted.isPrimary).toBe(false);
    const b = await createVendorContact(db, v.id, { name: 'Bob', isPrimary: true });
    expect(b.isPrimary).toBe(true);
  });
});

async function wipe(db: PrismaClient): Promise<void> {
  const ours = await db.vendor.findMany({
    where: { name: { startsWith: TAG } },
    select: { id: true },
  });
  const ids = ours.map((o) => o.id);
  if (ids.length === 0) return;
  const contactIds = (
    await db.vendorContact.findMany({
      where: { vendorId: { in: ids } },
      select: { id: true },
    })
  ).map((c) => c.id);
  await db.vendorContact.deleteMany({ where: { vendorId: { in: ids } } });
  await db.vendorAddress.deleteMany({ where: { vendorId: { in: ids } } });
  await db.auditLog.deleteMany({
    where: { entityType: 'Vendor', entityId: { in: ids } },
  });
  if (contactIds.length > 0) {
    await db.auditLog.deleteMany({
      where: { entityType: 'VendorContact', entityId: { in: contactIds } },
    });
  }
  await db.vendor.deleteMany({ where: { id: { in: ids } } });
}
