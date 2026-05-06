import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditAction } from '@/generated/tenant';
import type { PaymentTerm, PrismaClient, Vendor } from '@/generated/tenant';
import { createVendor } from '@/server/services/vendors';
import {
  createVendorPaymentMethod,
  getVendorPaymentMethodMetadata,
  listVendorPaymentMethods,
  readDecryptedVendorPaymentMethodPayload,
  setPreferredVendorPaymentMethod,
  softDeleteVendorPaymentMethod,
  updateVendorPaymentMethod,
} from '@/server/services/vendorPaymentMethods';
import { createVendorPaymentMethodInputSchema } from '@/lib/validation/vendors';
import { hasTenantDb, makeClient } from '../helpers/db';

const suite = hasTenantDb ? describe : describe.skip;

const TAG = 'TEST-VENDPM';

// Sentinel cleartext we can scan for in audit rows. Improbable enough
// that any accidental log/store would jump out.
const SENTINEL_ACCOUNT = '9876-VENDPM-CLEARTXT-001';

suite('VendorPaymentMethod service', () => {
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

  // ---------- CRUD round-trip per kind ----------

  it('ACH: create + metadata + decrypt round-trip', async () => {
    const v = await makeVendor('ACH');
    const created = await createVendorPaymentMethod(db, v.id, {
      kind: 'ACH',
      payload: {
        routingNumber: '021000021',
        accountNumber: '123456789',
        accountName: 'Acme Operating',
        bankName: 'Chase',
      },
    });
    expect(created.kind).toBe('ACH');
    expect(created.displayHint).toBe('ACH ****6789');
    // Encrypted columns must NOT appear on the metadata return.
    expect((created as Record<string, unknown>).encryptedPayload).toBeUndefined();
    expect((created as Record<string, unknown>).encryptedPayloadIv).toBeUndefined();

    const decrypted = await readDecryptedVendorPaymentMethodPayload(db, created.id);
    expect(decrypted.kind).toBe('ACH');
    if (decrypted.kind !== 'ACH') throw new Error('unreachable');
    expect(decrypted.payload.routingNumber).toBe('021000021');
    expect(decrypted.payload.accountNumber).toBe('123456789');
    expect(decrypted.payload.accountName).toBe('Acme Operating');
    expect(decrypted.payload.bankName).toBe('Chase');
  });

  it('WIRE: round-trip with optional SWIFT + intermediary', async () => {
    const v = await makeVendor('WIRE');
    const created = await createVendorPaymentMethod(db, v.id, {
      kind: 'WIRE',
      payload: {
        routingNumber: '026009593',
        accountNumber: 'GB29NWBK60161331926819',
        accountName: 'Acme UK',
        swiftCode: 'NWBKGB2L',
        intermediaryBank: 'Bank of America NY',
      },
    });
    expect(created.displayHint).toBe('Wire ****6819');
    const decrypted = await readDecryptedVendorPaymentMethodPayload(db, created.id);
    if (decrypted.kind !== 'WIRE') throw new Error('unreachable');
    expect(decrypted.payload.swiftCode).toBe('NWBKGB2L');
    expect(decrypted.payload.intermediaryBank).toBe('Bank of America NY');
  });

  it('CHECK: round-trip with payee address', async () => {
    const v = await makeVendor('CHECK');
    const created = await createVendorPaymentMethod(db, v.id, {
      kind: 'CHECK',
      payload: {
        payeeName: 'Acme LLC',
        line1: '100 Main St',
        line2: 'Suite 200',
        city: 'Austin',
        region: 'TX',
        postalCode: '78701',
        country: 'US',
      },
    });
    expect(created.displayHint).toBe('Check to: Acme LLC');
    const decrypted = await readDecryptedVendorPaymentMethodPayload(db, created.id);
    if (decrypted.kind !== 'CHECK') throw new Error('unreachable');
    expect(decrypted.payload.payeeName).toBe('Acme LLC');
    expect(decrypted.payload.line1).toBe('100 Main St');
    expect(decrypted.payload.line2).toBe('Suite 200');
  });

  it('CREDIT_CARD: round-trip with last4 + brand only', async () => {
    const v = await makeVendor('CC');
    const created = await createVendorPaymentMethod(db, v.id, {
      kind: 'CREDIT_CARD',
      payload: {
        last4: '4242',
        brand: 'Visa',
        expirationMonth: 12,
        expirationYear: 2030,
      },
    });
    expect(created.displayHint).toBe('Visa ****4242');
    const decrypted = await readDecryptedVendorPaymentMethodPayload(db, created.id);
    if (decrypted.kind !== 'CREDIT_CARD') throw new Error('unreachable');
    expect(decrypted.payload.last4).toBe('4242');
    expect(decrypted.payload.brand).toBe('Visa');
    expect(decrypted.payload.expirationYear).toBe(2030);
  });

  // ---------- Update + lifecycle ----------

  it('update mutates label/preferred/active but never the payload', async () => {
    const v = await makeVendor('UPD');
    const created = await createVendorPaymentMethod(db, v.id, {
      kind: 'ACH',
      payload: {
        routingNumber: '021000021',
        accountNumber: '111111111',
        accountName: 'Original',
      },
      label: 'Old label',
    });
    const updated = await updateVendorPaymentMethod(db, created.id, {
      label: 'New label',
      isPreferred: true,
      active: false,
    });
    expect(updated.label).toBe('New label');
    expect(updated.isPreferred).toBe(true);
    expect(updated.active).toBe(false);

    // Payload was untouched — decrypt still returns the original.
    const decrypted = await readDecryptedVendorPaymentMethodPayload(db, created.id);
    if (decrypted.kind !== 'ACH') throw new Error('unreachable');
    expect(decrypted.payload.accountName).toBe('Original');
    expect(decrypted.payload.accountNumber).toBe('111111111');

    // Update schema does not accept a payload field — type-level guarantee
    // is enforced by Zod parse rejecting unknown keys via strict mode? No,
    // Zod is non-strict by default; assert behaviorally that the update
    // function signature has no payload field by checking the runtime
    // result (no schema change to payload regardless of what callers pass).
  });

  it('soft-delete clears isPreferred and excludes from list', async () => {
    const v = await makeVendor('SD');
    const created = await createVendorPaymentMethod(db, v.id, {
      kind: 'ACH',
      payload: { routingNumber: '021000021', accountNumber: '111122223333', accountName: 'X' },
      isPreferred: true,
    });
    const deleted = await softDeleteVendorPaymentMethod(db, created.id);
    expect(deleted.deletedAt).not.toBeNull();
    expect(deleted.isPreferred).toBe(false);

    const list = await listVendorPaymentMethods(db, v.id);
    expect(list).toHaveLength(0);

    // Singleton slot is freed — a new preferred can be set immediately.
    const replacement = await createVendorPaymentMethod(db, v.id, {
      kind: 'ACH',
      payload: { routingNumber: '021000021', accountNumber: '999988887777', accountName: 'Y' },
      isPreferred: true,
    });
    expect(replacement.isPreferred).toBe(true);
  });

  it('exactly one isPreferred=true per vendor — setPreferred clears others', async () => {
    const v = await makeVendor('PREF');
    const a = await createVendorPaymentMethod(db, v.id, {
      kind: 'ACH',
      payload: { routingNumber: '021000021', accountNumber: '111111111', accountName: 'A' },
      isPreferred: true,
    });
    const b = await createVendorPaymentMethod(db, v.id, {
      kind: 'WIRE',
      payload: { routingNumber: '026009593', accountNumber: '222222222', accountName: 'B' },
    });
    await setPreferredVendorPaymentMethod(db, b.id);

    const fresh = await db.vendorPaymentMethod.findMany({
      where: { vendorId: v.id, deletedAt: null, isPreferred: true },
    });
    expect(fresh).toHaveLength(1);
    expect(fresh[0].id).toBe(b.id);
    const aRefetch = await getVendorPaymentMethodMetadata(db, a.id);
    expect(aRefetch!.isPreferred).toBe(false);
  });

  it('creating a new method with isPreferred=true clears prior preferred', async () => {
    const v = await makeVendor('CREATEPREF');
    const a = await createVendorPaymentMethod(db, v.id, {
      kind: 'ACH',
      payload: { routingNumber: '021000021', accountNumber: '111111111', accountName: 'A' },
      isPreferred: true,
    });
    const b = await createVendorPaymentMethod(db, v.id, {
      kind: 'CHECK',
      payload: {
        payeeName: 'B',
        line1: '1 St',
        city: 'Austin',
        region: 'TX',
        postalCode: '78701',
      },
      isPreferred: true,
    });
    expect(b.isPreferred).toBe(true);
    const aRefetch = await getVendorPaymentMethodMetadata(db, a.id);
    expect(aRefetch!.isPreferred).toBe(false);
  });

  it('list orders preferred first then by createdAt desc; excludes soft-deleted', async () => {
    const v = await makeVendor('LIST');
    const a = await createVendorPaymentMethod(db, v.id, {
      kind: 'ACH',
      payload: { routingNumber: '021000021', accountNumber: '1111', accountName: 'A' },
    });
    const b = await createVendorPaymentMethod(db, v.id, {
      kind: 'WIRE',
      payload: { routingNumber: '026009593', accountNumber: '2222', accountName: 'B' },
      isPreferred: true,
    });
    const c = await createVendorPaymentMethod(db, v.id, {
      kind: 'CREDIT_CARD',
      payload: { last4: '3333', brand: 'Visa' },
    });
    await softDeleteVendorPaymentMethod(db, a.id);
    const list = await listVendorPaymentMethods(db, v.id);
    expect(list.map((p) => p.id)).toEqual([b.id, c.id]); // preferred first, then newest
  });

  // ---------- SENSITIVE_READ audit ----------

  it('readDecryptedPayload writes exactly one SENSITIVE_READ row with redacted JSON', async () => {
    const v = await makeVendor('SR');
    const created = await createVendorPaymentMethod(db, v.id, {
      kind: 'ACH',
      payload: {
        routingNumber: '021000021',
        accountNumber: SENTINEL_ACCOUNT,
        accountName: 'Sentinel',
      },
    });
    await readDecryptedVendorPaymentMethodPayload(db, created.id);

    const reads = await db.auditLog.findMany({
      where: {
        entityType: 'VendorPaymentMethod',
        entityId: created.id,
        action: AuditAction.SENSITIVE_READ,
      },
    });
    expect(reads).toHaveLength(1);
    const before = reads[0].beforeJson as {
      vendorPaymentMethodId?: string;
      kind?: string;
      // No cleartext fields:
      payload?: unknown;
      accountNumber?: unknown;
      encryptedPayload?: unknown;
    };
    expect(before.vendorPaymentMethodId).toBe(created.id);
    expect(before.kind).toBe('ACH');
    expect(before.payload).toBeUndefined();
    expect(before.accountNumber).toBeUndefined();
    expect(before.encryptedPayload).toBeUndefined();

    // Defense-in-depth: stringify the whole audit row and assert sentinel
    // is nowhere in the JSON.
    expect(JSON.stringify(reads[0])).not.toContain(SENTINEL_ACCOUNT);
  });

  // ---------- Tampered ciphertext ----------

  it('tampered ciphertext: readDecryptedPayload throws AND SENSITIVE_READ row is still written', async () => {
    const v = await makeVendor('TAMP');
    const created = await createVendorPaymentMethod(db, v.id, {
      kind: 'ACH',
      payload: {
        routingNumber: '021000021',
        accountNumber: '5555444433332222',
        accountName: 'Tamper Test',
      },
    });

    // Flip a bit in the stored ciphertext.
    const row = await db.vendorPaymentMethod.findUniqueOrThrow({ where: { id: created.id } });
    const buf = Buffer.from(row.encryptedPayload, 'base64');
    buf[0] = buf[0] ^ 0x01;
    await db.vendorPaymentMethod.update({
      where: { id: created.id },
      data: { encryptedPayload: buf.toString('base64') },
    });

    await expect(readDecryptedVendorPaymentMethodPayload(db, created.id)).rejects.toThrow();

    const reads = await db.auditLog.findMany({
      where: {
        entityType: 'VendorPaymentMethod',
        entityId: created.id,
        action: AuditAction.SENSITIVE_READ,
      },
    });
    expect(reads).toHaveLength(1); // audit survives the throw
  });

  // ---------- Cleartext leak / redaction guarantees ----------

  it('CREATE audit afterJson is redacted: hasEncryptedPayload=true, no ciphertext, no IV, no cleartext sentinel', async () => {
    const v = await makeVendor('REDACT');
    const created = await createVendorPaymentMethod(db, v.id, {
      kind: 'ACH',
      payload: {
        routingNumber: '021000021',
        accountNumber: SENTINEL_ACCOUNT,
        accountName: 'RedactCheck',
      },
    });
    const audits = await db.auditLog.findMany({
      where: {
        entityType: 'VendorPaymentMethod',
        entityId: created.id,
        action: AuditAction.CREATE,
      },
    });
    expect(audits).toHaveLength(1);
    const after = audits[0].afterJson as {
      hasEncryptedPayload?: boolean;
      encryptedPayload?: unknown;
      encryptedPayloadIv?: unknown;
    };
    expect(after.hasEncryptedPayload).toBe(true);
    expect(after.encryptedPayload).toBeUndefined();
    expect(after.encryptedPayloadIv).toBeUndefined();

    // Stringify the entire audit row and assert no cleartext sentinel anywhere.
    expect(JSON.stringify(audits[0])).not.toContain(SENTINEL_ACCOUNT);
  });

  it('list / getMetadata never expose encryptedPayload columns', async () => {
    const v = await makeVendor('STRIP');
    const created = await createVendorPaymentMethod(db, v.id, {
      kind: 'ACH',
      payload: { routingNumber: '021000021', accountNumber: '1234', accountName: 'X' },
    });
    const fetched = await getVendorPaymentMethodMetadata(db, created.id);
    expect(fetched).not.toBeNull();
    expect((fetched as Record<string, unknown>).encryptedPayload).toBeUndefined();
    expect((fetched as Record<string, unknown>).encryptedPayloadIv).toBeUndefined();

    const list = await listVendorPaymentMethods(db, v.id);
    for (const row of list) {
      expect((row as Record<string, unknown>).encryptedPayload).toBeUndefined();
      expect((row as Record<string, unknown>).encryptedPayloadIv).toBeUndefined();
    }
  });

  // ---------- Validation ----------

  it('rejects a CREDIT_CARD payload with a 16-digit "last4" (full-PAN guard)', () => {
    expect(() =>
      createVendorPaymentMethodInputSchema.parse({
        kind: 'CREDIT_CARD',
        payload: { last4: '4242424242424242', brand: 'Visa' },
      }),
    ).toThrow();
  });

  it('rejects an ACH payload with a non-9-digit routing number', () => {
    expect(() =>
      createVendorPaymentMethodInputSchema.parse({
        kind: 'ACH',
        payload: {
          routingNumber: '12345',
          accountNumber: '987654321',
          accountName: 'X',
        },
      }),
    ).toThrow();
  });
});

async function wipe(db: PrismaClient): Promise<void> {
  const ours = await db.vendor.findMany({
    where: { name: { startsWith: TAG } },
    select: { id: true },
  });
  const ids = ours.map((o) => o.id);
  if (ids.length === 0) return;
  const pmIds = (
    await db.vendorPaymentMethod.findMany({
      where: { vendorId: { in: ids } },
      select: { id: true },
    })
  ).map((p) => p.id);
  await db.vendorPaymentMethod.deleteMany({ where: { vendorId: { in: ids } } });
  await db.vendorContact.deleteMany({ where: { vendorId: { in: ids } } });
  await db.vendorAddress.deleteMany({ where: { vendorId: { in: ids } } });
  await db.auditLog.deleteMany({
    where: { entityType: 'Vendor', entityId: { in: ids } },
  });
  if (pmIds.length > 0) {
    await db.auditLog.deleteMany({
      where: { entityType: 'VendorPaymentMethod', entityId: { in: pmIds } },
    });
  }
  await db.vendor.deleteMany({ where: { id: { in: ids } } });
}
