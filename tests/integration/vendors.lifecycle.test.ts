import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PaymentTerm, PrismaClient } from '@/generated/tenant';
import {
  createVendor,
  getVendor,
  listVendors,
  softDeleteVendor,
  updateVendor,
} from '@/server/services/vendors';
import { hasTenantDb, makeClient } from '../helpers/db';

const suite = hasTenantDb ? describe : describe.skip;

const TAG = 'TEST-VENDLC';

suite('Vendor lifecycle', () => {
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

  it('creates with auto-allocated VEND-YYYY-NNNNN code', async () => {
    const v = await createVendor(db, {
      name: `${TAG} Auto Code`,
      paymentTermId: term.id,
    });
    expect(v.code).toMatch(/^VEND-\d{4}-\d{5}$/);
    expect(v.type).toBe('STOCK');
    expect(v.active).toBe(true);
    expect(v.defaultCurrency).toBe('USD');
  });

  it('honors a manually supplied code (migration import path)', async () => {
    const v = await createVendor(db, {
      code: `${TAG}-MANUAL-001`,
      name: `${TAG} Manual Code`,
      paymentTermId: term.id,
    });
    expect(v.code).toBe(`${TAG}-MANUAL-001`);
  });

  it('writes a CREATE audit row', async () => {
    const v = await createVendor(db, {
      name: `${TAG} Audited`,
      paymentTermId: term.id,
    });
    const rows = await db.auditLog.findMany({
      where: { entityType: 'Vendor', entityId: v.id, action: 'CREATE' },
    });
    expect(rows).toHaveLength(1);
  });

  it('composite create writes remit-to address + contacts in same tx', async () => {
    const v = await createVendor(db, {
      name: `${TAG} Composite`,
      paymentTermId: term.id,
      remitToAddress: {
        kind: 'REMIT_TO',
        line1: '100 Vendor Way',
        city: 'Austin',
        region: 'TX',
        postalCode: '78701',
        isDefault: true,
      },
      contacts: [{ name: 'Sam', role: 'AR', isPrimary: true }],
    });
    const addrs = await db.vendorAddress.findMany({ where: { vendorId: v.id } });
    const contacts = await db.vendorContact.findMany({ where: { vendorId: v.id } });
    expect(addrs).toHaveLength(1);
    expect(addrs[0].kind).toBe('REMIT_TO');
    expect(addrs[0].isDefault).toBe(true);
    expect(contacts).toHaveLength(1);
    expect(contacts[0].isPrimary).toBe(true);
  });

  it('rejects create when paymentTermId is missing (service-level required)', async () => {
    await expect(
      // @ts-expect-error — paymentTermId omitted on purpose
      createVendor(db, { name: `${TAG} No Term` }),
    ).rejects.toThrow();
  });

  it('updates allowed fields and writes UPDATE audit', async () => {
    const v = await createVendor(db, {
      name: `${TAG} Pre-update`,
      paymentTermId: term.id,
    });
    const after = await updateVendor(db, v.id, {
      name: `${TAG} Post-update`,
      type: 'SERVICE',
      notes: 'switched to service vendor',
    });
    expect(after.name).toBe(`${TAG} Post-update`);
    expect(after.type).toBe('SERVICE');
    expect(after.notes).toBe('switched to service vendor');
    const rows = await db.auditLog.findMany({
      where: { entityType: 'Vendor', entityId: v.id, action: 'UPDATE' },
    });
    expect(rows).toHaveLength(1);
  });

  it('rejects update of soft-deleted vendor', async () => {
    const v = await createVendor(db, {
      name: `${TAG} SoftDel-Update`,
      paymentTermId: term.id,
    });
    await softDeleteVendor(db, v.id);
    await expect(
      updateVendor(db, v.id, { name: 'should fail' }),
    ).rejects.toThrow(/soft-deleted/);
  });

  it('soft-deletes a vendor with no dependents', async () => {
    const v = await createVendor(db, {
      name: `${TAG} SoftDel`,
      paymentTermId: term.id,
    });
    const deleted = await softDeleteVendor(db, v.id);
    expect(deleted.deletedAt).not.toBeNull();
    expect(await getVendor(db, v.id)).toBeNull();
  });

  it('blocks soft-delete when non-deleted POs reference the vendor', async () => {
    const v = await createVendor(db, {
      name: `${TAG} HasPO`,
      paymentTermId: term.id,
    });
    await db.purchaseOrder.create({
      data: {
        number: `${TAG}-PO-1`,
        vendorId: v.id,
      },
    });
    await expect(softDeleteVendor(db, v.id)).rejects.toThrow(/purchase order/);
  });

  it('listVendors filters by type and active', async () => {
    await createVendor(db, {
      name: `${TAG} Stock-A`,
      paymentTermId: term.id,
    });
    await createVendor(db, {
      name: `${TAG} Service-B`,
      paymentTermId: term.id,
      type: 'SERVICE',
    });
    const justService = await listVendors(db, { type: 'SERVICE' });
    const ours = justService.filter((v) => v.name.startsWith(TAG));
    expect(ours.map((v) => v.name)).toContain(`${TAG} Service-B`);
    expect(ours.map((v) => v.name)).not.toContain(`${TAG} Stock-A`);
  });

  it('legacy stub upsert still works (db.vendor.upsert with only code+name)', async () => {
    // 11+ test files use this pattern; the migration must keep it valid.
    const v = await db.vendor.upsert({
      where: { code: `${TAG}-LEGACY-1` },
      create: { code: `${TAG}-LEGACY-1`, name: `${TAG} Legacy Stub` },
      update: { active: true, deletedAt: null },
    });
    expect(v.type).toBe('STOCK');
    expect(v.paymentTermId).toBeNull();
    expect(v.defaultCurrency).toBe('USD');
  });
});

async function wipe(db: PrismaClient): Promise<void> {
  const ours = await db.vendor.findMany({
    where: { name: { startsWith: TAG } },
    select: { id: true },
  });
  const ids = ours.map((o) => o.id);
  if (ids.length === 0) {
    await db.vendor.deleteMany({ where: { code: { startsWith: TAG } } });
    return;
  }
  await db.purchaseOrder.deleteMany({ where: { vendorId: { in: ids } } });
  const addrIds = (
    await db.vendorAddress.findMany({
      where: { vendorId: { in: ids } },
      select: { id: true },
    })
  ).map((a) => a.id);
  const contactIds = (
    await db.vendorContact.findMany({
      where: { vendorId: { in: ids } },
      select: { id: true },
    })
  ).map((c) => c.id);
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
  if (contactIds.length > 0) {
    await db.auditLog.deleteMany({
      where: { entityType: 'VendorContact', entityId: { in: contactIds } },
    });
  }
  await db.vendor.deleteMany({ where: { id: { in: ids } } });
  await db.vendor.deleteMany({ where: { code: { startsWith: TAG } } });
}
