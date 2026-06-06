import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditAction } from '@/generated/tenant';
import type { Customer, PaymentTerm, PrismaClient, SalesRep } from '@/generated/tenant';
import { createCustomer } from '@/server/services/customers';
import {
  createDocument,
  updateDocument,
  readEncryptedValue,
} from '@/server/services/customerDocuments';
import { hasTenantDb, makeClient } from '../helpers/db';

const suite = hasTenantDb ? describe : describe.skip;

const TAG = 'TEST-CDOC-UPD';

// Distinct sentinel so accidental persistence is immediately visible.
const SENTINEL_ORIGINAL = `EIN-ORIG-${TAG}-x7k2q`;
const SENTINEL_UPDATED = `EIN-UPD-${TAG}-p9m4r`;

suite('updateDocument service', () => {
  let db: PrismaClient;
  let salesRep: SalesRep;
  let term: PaymentTerm;

  beforeAll(async () => {
    db = makeClient();
    salesRep = await db.salesRep.findFirstOrThrow({ where: { code: 'UNASSIGNED' } });
    term = await db.paymentTerm.findFirstOrThrow({ where: { code: 'NET30' } });
  });

  beforeEach(() => wipe(db));
  afterAll(async () => {
    await wipe(db);
    await db.$disconnect();
  });

  async function makeCustomer(label: string): Promise<Customer> {
    return createCustomer(db, {
      name: `${TAG} ${label}`,
      salesRepId: salesRep.id,
      paymentTermId: term.id,
      billingAddress: {
        kind: 'BILLING',
        line1: '1 Test St',
        city: 'Dallas',
        region: 'TX',
        postalCode: '75201',
      },
    });
  }

  // -------------------------------------------------------------------------
  // Metadata-only update (works for any kind)
  // -------------------------------------------------------------------------

  it('metadata update — updates expiresOn and notes, does not touch encryption columns', async () => {
    const c = await makeCustomer('META');
    const doc = await createDocument(db, c.id, {
      kind: 'EIN',
      cleartextValue: SENTINEL_ORIGINAL,
      notes: 'original notes',
    });

    const updated = await updateDocument(db, doc.id, {
      expiresOn: new Date('2030-01-01T00:00:00Z'),
      notes: 'updated notes',
    });

    expect(updated.expiresOn?.toISOString()).toContain('2030-01-01');
    expect(updated.notes).toBe('updated notes');

    // Encryption columns must be untouched — cleartext still decrypts correctly.
    const cleartext = await readEncryptedValue(db, doc.id);
    expect(cleartext).toBe(SENTINEL_ORIGINAL);
  });

  it('metadata update — setting expiresOn to null clears the field', async () => {
    const c = await makeCustomer('META-NULL');
    const doc = await createDocument(db, c.id, {
      kind: 'RESALE_CERT',
      storageKey: 's/key',
      fileName: 'cert.pdf',
      contentType: 'application/pdf',
      expiresOn: new Date('2027-06-01T00:00:00Z'),
    });

    const updated = await updateDocument(db, doc.id, { expiresOn: null });
    expect(updated.expiresOn).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Sensitive kind — re-encrypt cleartext value
  // -------------------------------------------------------------------------

  it('re-encrypt cleartext: new ciphertext differs, readEncryptedValue returns new value', async () => {
    const c = await makeCustomer('REENC');
    const doc = await createDocument(db, c.id, {
      kind: 'EIN',
      cleartextValue: SENTINEL_ORIGINAL,
    });
    const origCiphertext = doc.encryptedValue;
    const origIv = doc.encryptedValueIv;

    const updated = await updateDocument(db, doc.id, {
      cleartextValue: SENTINEL_UPDATED,
    });

    // New ciphertext must be stored.
    expect(updated.encryptedValue).not.toBe(origCiphertext);
    expect(updated.encryptedValueIv).not.toBe(origIv);

    // Decryption must return the NEW value.
    const cleartext = await readEncryptedValue(db, doc.id);
    expect(cleartext).toBe(SENTINEL_UPDATED);
  });

  it('re-encrypt: cleartext sentinel NEVER appears in AuditLog after the update', async () => {
    const c = await makeCustomer('REENC-AUDIT');
    const doc = await createDocument(db, c.id, {
      kind: 'SSN',
      cleartextValue: SENTINEL_ORIGINAL,
    });
    await updateDocument(db, doc.id, { cleartextValue: SENTINEL_UPDATED });

    const audits = await db.auditLog.findMany({
      where: { entityType: 'CustomerDocument', entityId: doc.id },
    });
    // Should have CREATE + UPDATE rows.
    expect(audits.length).toBeGreaterThanOrEqual(2);

    for (const row of audits) {
      const blob = JSON.stringify(row);
      expect(blob).not.toContain(SENTINEL_ORIGINAL);
      expect(blob).not.toContain(SENTINEL_UPDATED);
    }
  });

  it('re-encrypt: AuditLog UPDATE row is redacted (hasEncryptedValue, no raw columns)', async () => {
    const c = await makeCustomer('REENC-SHAPE');
    const doc = await createDocument(db, c.id, { kind: 'EIN', cleartextValue: SENTINEL_ORIGINAL });

    await updateDocument(db, doc.id, { cleartextValue: SENTINEL_UPDATED });

    const updateRow = await db.auditLog.findFirstOrThrow({
      where: {
        entityType: 'CustomerDocument',
        entityId: doc.id,
        action: AuditAction.UPDATE,
      },
    });

    const before = updateRow.beforeJson as Record<string, unknown>;
    const after = updateRow.afterJson as Record<string, unknown>;

    expect(before.hasEncryptedValue).toBe(true);
    expect(after.hasEncryptedValue).toBe(true);
    expect(before.encryptedValue).toBeUndefined();
    expect(after.encryptedValue).toBeUndefined();
    expect(before.encryptedValueIv).toBeUndefined();
    expect(after.encryptedValueIv).toBeUndefined();
  });

  it('re-encrypt: readEncryptedValue still writes SENSITIVE_READ after update', async () => {
    const c = await makeCustomer('REENC-READ');
    const doc = await createDocument(db, c.id, { kind: 'DRIVERS_LICENSE', cleartextValue: 'DL-ORIG' });
    await updateDocument(db, doc.id, { cleartextValue: 'DL-UPD' });

    const cleartext = await readEncryptedValue(db, doc.id);
    expect(cleartext).toBe('DL-UPD');

    const sensitiveReads = await db.auditLog.findMany({
      where: {
        entityType: 'CustomerDocument',
        entityId: doc.id,
        action: AuditAction.SENSITIVE_READ,
      },
    });
    // Exactly one SENSITIVE_READ from our call above.
    expect(sensitiveReads).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // File kind — update storage reference
  // -------------------------------------------------------------------------

  it('file kind: can update storageKey/fileName/contentType', async () => {
    const c = await makeCustomer('FILE-UPD');
    const doc = await createDocument(db, c.id, {
      kind: 'RESALE_PERMIT',
      storageKey: 'customers/1/old.pdf',
      fileName: 'old.pdf',
      contentType: 'application/pdf',
    });

    const updated = await updateDocument(db, doc.id, {
      storageKey: 'customers/1/new.pdf',
      fileName: 'new.pdf',
      contentType: 'application/pdf',
    });

    expect(updated.storageKey).toBe('customers/1/new.pdf');
    expect(updated.fileName).toBe('new.pdf');
  });

  // -------------------------------------------------------------------------
  // Kind-compatibility guards
  // -------------------------------------------------------------------------

  it('throws if cleartextValue is provided for a file-kind document', async () => {
    const c = await makeCustomer('GUARD-CT');
    const doc = await createDocument(db, c.id, {
      kind: 'BUSINESS_LICENSE',
      storageKey: 'k',
      fileName: 'f',
      contentType: 'application/pdf',
    });
    await expect(
      updateDocument(db, doc.id, { cleartextValue: 'should-fail' }),
    ).rejects.toThrow(/cleartextValue is only valid for sensitive/);
  });

  it('throws if storageKey is provided for a sensitive-kind document', async () => {
    const c = await makeCustomer('GUARD-SK');
    const doc = await createDocument(db, c.id, { kind: 'EIN', cleartextValue: 'EIN-123' });
    await expect(
      updateDocument(db, doc.id, { storageKey: 'some-key' }),
    ).rejects.toThrow(/storageKey\/fileName\/contentType cannot be set on sensitive/);
  });

  it('throws on a soft-deleted document (findFirst with deletedAt: null returns null)', async () => {
    const c = await makeCustomer('DELETED');
    const doc = await createDocument(db, c.id, {
      kind: 'OTHER',
      storageKey: 'k',
      fileName: 'f',
      contentType: 'application/pdf',
    });
    await db.customerDocument.update({
      where: { id: doc.id },
      data: { deletedAt: new Date() },
    });
    await expect(updateDocument(db, doc.id, { notes: 'x' })).rejects.toThrow(
      /not found/,
    );
  });
});

async function wipe(db: PrismaClient): Promise<void> {
  const customers = await db.customer.findMany({
    where: { name: { startsWith: TAG } },
    select: { id: true },
  });
  const ids = customers.map((c) => c.id);
  if (ids.length === 0) return;

  const docIds = (
    await db.customerDocument.findMany({ where: { customerId: { in: ids } }, select: { id: true } })
  ).map((d) => d.id);

  await db.customerDocument.deleteMany({ where: { customerId: { in: ids } } });
  await db.customerActivity.deleteMany({ where: { customerId: { in: ids } } });
  await db.customerAddress.deleteMany({ where: { customerId: { in: ids } } });

  if (docIds.length > 0) {
    await db.auditLog.deleteMany({
      where: { entityType: 'CustomerDocument', entityId: { in: docIds } },
    });
  }
  await db.auditLog.deleteMany({ where: { entityType: 'Customer', entityId: { in: ids } } });
  await db.customer.deleteMany({ where: { id: { in: ids } } });
}
