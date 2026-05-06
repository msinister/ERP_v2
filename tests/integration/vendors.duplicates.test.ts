import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PaymentTerm, PrismaClient } from '@/generated/tenant';
import { createVendor, softDeleteVendor } from '@/server/services/vendors';
import { hasTenantDb, makeClient } from '../helpers/db';

const suite = hasTenantDb ? describe : describe.skip;

const TAG = 'TEST-VENDDUP';

suite('Vendor code uniqueness', () => {
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

  it('rejects a duplicate manually-supplied code', async () => {
    const code = `${TAG}-DUP`;
    await createVendor(db, { code, name: `${TAG} A`, paymentTermId: term.id });
    await expect(
      createVendor(db, { code, name: `${TAG} B`, paymentTermId: term.id }),
    ).rejects.toThrow();
  });

  it('soft-deleted code still occupies the unique slot (no resurrection via duplicate code)', async () => {
    // The Vendor.code column has a hard UNIQUE constraint (not partial).
    // Soft-deleted rows still hold the slot — re-using a code requires
    // hard-delete. Confirms the existing legacy behavior is preserved.
    const code = `${TAG}-SD-CODE`;
    const v = await createVendor(db, {
      code,
      name: `${TAG} First`,
      paymentTermId: term.id,
    });
    await softDeleteVendor(db, v.id);
    await expect(
      createVendor(db, { code, name: `${TAG} Second`, paymentTermId: term.id }),
    ).rejects.toThrow();
  });

  it('auto-allocated codes increment monotonically', async () => {
    const a = await createVendor(db, { name: `${TAG} Seq A`, paymentTermId: term.id });
    const b = await createVendor(db, { name: `${TAG} Seq B`, paymentTermId: term.id });
    const matchA = a.code.match(/^VEND-\d{4}-(\d{5})$/);
    const matchB = b.code.match(/^VEND-\d{4}-(\d{5})$/);
    expect(matchA).not.toBeNull();
    expect(matchB).not.toBeNull();
    expect(Number(matchB![1])).toBe(Number(matchA![1]) + 1);
  });
});

async function wipe(db: PrismaClient): Promise<void> {
  const ours = await db.vendor.findMany({
    where: {
      OR: [
        { name: { startsWith: TAG } },
        { code: { startsWith: TAG } },
      ],
    },
    select: { id: true },
  });
  const ids = ours.map((o) => o.id);
  if (ids.length === 0) return;
  await db.vendorAddress.deleteMany({ where: { vendorId: { in: ids } } });
  await db.vendorContact.deleteMany({ where: { vendorId: { in: ids } } });
  await db.auditLog.deleteMany({
    where: { entityType: 'Vendor', entityId: { in: ids } },
  });
  await db.vendor.deleteMany({ where: { id: { in: ids } } });
}
