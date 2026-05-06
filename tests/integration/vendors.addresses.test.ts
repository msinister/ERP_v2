import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PaymentTerm, PrismaClient, Vendor } from '@/generated/tenant';
import { createVendor } from '@/server/services/vendors';
import {
  addVendorAddress,
  listVendorAddresses,
  setDefaultVendorAddress,
  softDeleteVendorAddress,
  updateVendorAddress,
} from '@/server/services/vendorAddresses';
import { hasTenantDb, makeClient } from '../helpers/db';

const suite = hasTenantDb ? describe : describe.skip;

const TAG = 'TEST-VENDADDR';

const stockAddr = (overrides: Partial<{ city: string; isDefault: boolean }> = {}) => ({
  line1: '1 Vendor St',
  city: overrides.city ?? 'Austin',
  region: 'TX',
  postalCode: '78701',
  isDefault: overrides.isDefault ?? false,
});

suite('Vendor addresses — invariants', () => {
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
    return createVendor(db, { name: `${TAG} ${name}`, paymentTermId: term.id });
  }

  it('CRUD round-trip on REMIT_TO', async () => {
    const v = await makeVendor('CRUD');
    const created = await addVendorAddress(db, v.id, {
      kind: 'REMIT_TO',
      ...stockAddr({ isDefault: true }),
    });
    expect(created.kind).toBe('REMIT_TO');
    expect(created.isDefault).toBe(true);

    const updated = await updateVendorAddress(db, created.id, { city: 'Dallas' });
    expect(updated.city).toBe('Dallas');

    const deleted = await softDeleteVendorAddress(db, created.id);
    expect(deleted.deletedAt).not.toBeNull();
    expect(deleted.isDefault).toBe(false);
  });

  it('three address kinds coexist on one vendor (REMIT_TO + SHIPPING + BILLING)', async () => {
    const v = await makeVendor('THREE');
    await addVendorAddress(db, v.id, {
      kind: 'REMIT_TO',
      ...stockAddr({ isDefault: true }),
    });
    await addVendorAddress(db, v.id, {
      kind: 'SHIPPING',
      ...stockAddr({ city: 'Houston', isDefault: true }),
    });
    await addVendorAddress(db, v.id, {
      kind: 'BILLING',
      ...stockAddr({ city: 'Dallas', isDefault: true }),
    });
    const all = await listVendorAddresses(db, v.id);
    expect(all).toHaveLength(3);
    const kinds = all.map((a) => a.kind).sort();
    expect(kinds).toEqual(['BILLING', 'REMIT_TO', 'SHIPPING']);
  });

  it('exactly one isDefault=true per (vendor, kind) — setting a new default clears the prior', async () => {
    const v = await makeVendor('DEF');
    const a = await addVendorAddress(db, v.id, {
      kind: 'REMIT_TO',
      ...stockAddr({ isDefault: true }),
    });
    const b = await addVendorAddress(db, v.id, {
      kind: 'REMIT_TO',
      ...stockAddr({ city: 'Dallas', isDefault: false }),
    });
    await setDefaultVendorAddress(db, b.id);
    const refreshedA = await db.vendorAddress.findUnique({ where: { id: a.id } });
    expect(refreshedA!.isDefault).toBe(false);
    const defaults = await db.vendorAddress.findMany({
      where: { vendorId: v.id, kind: 'REMIT_TO', isDefault: true, deletedAt: null },
    });
    expect(defaults).toHaveLength(1);
    expect(defaults[0].id).toBe(b.id);
  });

  it('isDefault is per-kind — setting REMIT_TO default does not affect SHIPPING default', async () => {
    const v = await makeVendor('PERKIND');
    const remit = await addVendorAddress(db, v.id, {
      kind: 'REMIT_TO',
      ...stockAddr({ isDefault: true }),
    });
    const ship = await addVendorAddress(db, v.id, {
      kind: 'SHIPPING',
      ...stockAddr({ city: 'Houston', isDefault: true }),
    });
    expect(remit.isDefault).toBe(true);
    expect(ship.isDefault).toBe(true);
  });

  it('soft-delete clears isDefault in same tx so a new default can be set', async () => {
    const v = await makeVendor('SD');
    const a = await addVendorAddress(db, v.id, {
      kind: 'REMIT_TO',
      ...stockAddr({ isDefault: true }),
    });
    await softDeleteVendorAddress(db, a.id);
    const b = await addVendorAddress(db, v.id, {
      kind: 'REMIT_TO',
      ...stockAddr({ city: 'Dallas', isDefault: true }),
    });
    expect(b.isDefault).toBe(true);
  });
});

async function wipe(db: PrismaClient): Promise<void> {
  const ours = await db.vendor.findMany({
    where: { name: { startsWith: TAG } },
    select: { id: true },
  });
  const ids = ours.map((o) => o.id);
  if (ids.length === 0) return;
  const addrIds = (
    await db.vendorAddress.findMany({
      where: { vendorId: { in: ids } },
      select: { id: true },
    })
  ).map((a) => a.id);
  await db.vendorAddress.deleteMany({ where: { vendorId: { in: ids } } });
  await db.vendorContact.deleteMany({ where: { vendorId: { in: ids } } });
  await db.auditLog.deleteMany({
    where: { entityType: 'Vendor', entityId: { in: ids } },
  });
  if (addrIds.length > 0) {
    await db.auditLog.deleteMany({
      where: { entityType: 'VendorAddress', entityId: { in: addrIds } },
    });
  }
  await db.vendor.deleteMany({ where: { id: { in: ids } } });
}
