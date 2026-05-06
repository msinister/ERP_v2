import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AuditAction,
  CustomerDocumentKind,
} from '@/generated/tenant';
import type { Customer, PaymentTerm, PrismaClient, SalesRep } from '@/generated/tenant';
import { createCustomer } from '@/server/services/customers';
import {
  createDocument,
  findDocumentsExpiringWithin,
  listDocumentsForCustomer,
  readEncryptedValue,
  softDeleteDocument,
} from '@/server/services/customerDocuments';
import { GET as cleartextRouteGet } from '@/app/api/customers/[id]/documents/[did]/cleartext/route';
import { auth } from '@/lib/auth/auth';
import { hasTenantDb, makeClient } from '../helpers/db';

const suite = hasTenantDb ? describe : describe.skip;

const TAG = 'TEST-CDOC';

// Cleartext-route tests below need an authenticated session (slice D
// gated /api/* on requireAuth). Provision one user up front and reuse
// the cookie across the suite. The user's name is intentionally NOT
// TAG-prefixed because wipe() runs on beforeEach — we only want this
// user cleaned up at suite end (see afterAll), not between tests.
const AUTH_USER_EMAIL = 'cdoc-cleartext-suite-user@erp.test';
const AUTH_USER_NAME = 'cdoc-cleartext-suite-user';

async function makeAuthCookie(): Promise<string> {
  await auth.api.signUpEmail({
    body: { email: AUTH_USER_EMAIL, password: 'CdocTest-1!', name: AUTH_USER_NAME },
  });
  const signIn = (await auth.api.signInEmail({
    body: { email: AUTH_USER_EMAIL, password: 'CdocTest-1!' },
    asResponse: true,
  })) as Response;
  const setCookie = signIn.headers.get('set-cookie');
  if (!setCookie) throw new Error('no Set-Cookie on sign-in response');
  return setCookie
    .split(/,(?=[^;]+=)/)
    .map((c) => c.split(';')[0].trim())
    .join('; ');
}

async function wipeAuthUser(db: PrismaClient): Promise<void> {
  const u = await db.user.findUnique({ where: { email: AUTH_USER_EMAIL } });
  if (!u) return;
  await db.session.deleteMany({ where: { userId: u.id } });
  await db.account.deleteMany({ where: { userId: u.id } });
  await db.auditLog.deleteMany({
    where: { entityType: 'User', entityId: u.id },
  });
  await db.user.delete({ where: { id: u.id } });
}

// A unique sentinel cleartext we can scan for in audit / activity tables.
// Make it improbable enough that any accidental log/store would jump out.
const SENTINEL_EIN = `EIN-CLEARTEXT-${TAG}-9b7c4e3a1f8d`;

suite('CustomerDocument service', () => {
  let db: PrismaClient;
  let salesRep: SalesRep;
  let term: PaymentTerm;
  let authCookie: string;

  beforeAll(async () => {
    db = makeClient();
    salesRep = await db.salesRep.findFirstOrThrow({ where: { code: 'UNASSIGNED' } });
    term = await db.paymentTerm.findFirstOrThrow({ where: { code: 'NET30' } });
    // Pre-clean any leftover suite-user from a prior interrupted run so
    // signUpEmail doesn't trip the email-uniqueness constraint.
    await wipeAuthUser(db);
    authCookie = await makeAuthCookie();
  });

  beforeEach(async () => {
    await wipe(db);
  });

  afterAll(async () => {
    await wipe(db);
    await wipeAuthUser(db);
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

  // ---------- Encrypted round-trip ----------

  it('encrypted round-trip — DB stores ciphertext, readEncryptedValue returns original cleartext', async () => {
    const c = await makeCustomer('RT');
    const created = await createDocument(db, c.id, {
      kind: 'EIN',
      cleartextValue: SENTINEL_EIN,
    });
    expect(created.encryptedValue).not.toBe(SENTINEL_EIN);
    expect(created.encryptedValue).not.toBeNull();
    expect(created.encryptedValueIv).not.toBeNull();

    const cleartext = await readEncryptedValue(db, created.id);
    expect(cleartext).toBe(SENTINEL_EIN);
  });

  // ---------- Audit redaction (CRITICAL) ----------

  it('AuditLog after createDocument redacts encrypted scalars and never contains cleartext', async () => {
    const c = await makeCustomer('AR');
    const created = await createDocument(db, c.id, {
      kind: 'EIN',
      cleartextValue: SENTINEL_EIN,
    });
    const audits = await db.auditLog.findMany({
      where: { entityType: 'CustomerDocument', entityId: created.id },
    });
    expect(audits).toHaveLength(1);
    const after = audits[0].afterJson as {
      kind?: string;
      hasEncryptedValue?: boolean;
      encryptedValue?: unknown;
      encryptedValueIv?: unknown;
    };
    expect(after.kind).toBe('EIN');
    expect(after.hasEncryptedValue).toBe(true);
    // The redacted shape must not carry the encrypted columns at all.
    expect(after.encryptedValue).toBeUndefined();
    expect(after.encryptedValueIv).toBeUndefined();

    // Stringify and assert no cleartext sentinel anywhere.
    const blob = JSON.stringify(audits[0]);
    expect(blob).not.toContain(SENTINEL_EIN);
  });

  // ---------- SENSITIVE_READ audit ----------

  it('readEncryptedValue writes exactly one SENSITIVE_READ audit row with redacted JSON', async () => {
    const c = await makeCustomer('SR');
    const doc = await createDocument(db, c.id, {
      kind: 'SSN',
      cleartextValue: 'SSN-CLEARTEXT-9999',
    });
    await readEncryptedValue(db, doc.id);

    const reads = await db.auditLog.findMany({
      where: {
        entityType: 'CustomerDocument',
        entityId: doc.id,
        action: AuditAction.SENSITIVE_READ,
      },
    });
    expect(reads).toHaveLength(1);
    const before = reads[0].beforeJson as {
      documentId?: string;
      kind?: string;
      // No cleartext fields:
      cleartextValue?: unknown;
      encryptedValue?: unknown;
    };
    expect(before.documentId).toBe(doc.id);
    expect(before.kind).toBe('SSN');
    expect(before.cleartextValue).toBeUndefined();
    expect(before.encryptedValue).toBeUndefined();
  });

  // ---------- Tampered ciphertext ----------

  it('tampered ciphertext: readEncryptedValue throws AND the SENSITIVE_READ row is still written', async () => {
    const c = await makeCustomer('TAMP');
    const doc = await createDocument(db, c.id, {
      kind: 'DRIVERS_LICENSE',
      cleartextValue: `DL-${TAG}-zzzz`,
    });

    // Flip a bit in the ciphertext.
    const buf = Buffer.from(doc.encryptedValue!, 'base64');
    buf[0] = buf[0] ^ 0x01;
    await db.customerDocument.update({
      where: { id: doc.id },
      data: { encryptedValue: buf.toString('base64') },
    });

    await expect(readEncryptedValue(db, doc.id)).rejects.toThrow();

    const reads = await db.auditLog.findMany({
      where: {
        entityType: 'CustomerDocument',
        entityId: doc.id,
        action: AuditAction.SENSITIVE_READ,
      },
    });
    expect(reads).toHaveLength(1); // audit survives the throw
  });

  // ---------- Wrong kind ----------

  it('readEncryptedValue on a non-sensitive kind: specific error, NO audit row written', async () => {
    const c = await makeCustomer('WK');
    const doc = await createDocument(db, c.id, {
      kind: 'RESALE_PERMIT',
      storageKey: 'spaces/key/abc',
      fileName: 'permit.pdf',
      contentType: 'application/pdf',
    });
    await expect(readEncryptedValue(db, doc.id)).rejects.toThrow(
      /no encrypted value/,
    );
    const reads = await db.auditLog.findMany({
      where: {
        entityType: 'CustomerDocument',
        entityId: doc.id,
        action: AuditAction.SENSITIVE_READ,
      },
    });
    expect(reads).toHaveLength(0);
  });

  // ---------- File path ----------

  it('createDocument for a file kind stores metadata only, no encryption columns', async () => {
    const c = await makeCustomer('FILE');
    const doc = await createDocument(db, c.id, {
      kind: 'BUSINESS_LICENSE',
      storageKey: 'spaces/business-license/abc.pdf',
      fileName: 'license.pdf',
      contentType: 'application/pdf',
      expiresOn: new Date('2027-06-01T00:00:00Z'),
    });
    expect(doc.encryptedValue).toBeNull();
    expect(doc.encryptedValueIv).toBeNull();
    expect(doc.storageKey).toBe('spaces/business-license/abc.pdf');
    expect(doc.fileName).toBe('license.pdf');
    expect(doc.contentType).toBe('application/pdf');
  });

  // ---------- Listing strips encrypted columns ----------

  it('listDocumentsForCustomer / getDocumentMetadata never expose encrypted columns', async () => {
    const c = await makeCustomer('LIST');
    await createDocument(db, c.id, { kind: 'EIN', cleartextValue: SENTINEL_EIN });

    const list = await listDocumentsForCustomer(db, c.id);
    expect(list).toHaveLength(1);
    expect(list[0]).not.toHaveProperty('encryptedValue');
    expect(list[0]).not.toHaveProperty('encryptedValueIv');
  });

  // ---------- Expiring query ----------

  it('findDocumentsExpiringWithin: in-window included, far-future / past / soft-deleted excluded', async () => {
    const c = await makeCustomer('EXP');
    const NOW = new Date('2026-04-15T00:00:00Z');

    const within = await createDocument(db, c.id, {
      kind: 'RESALE_CERT',
      storageKey: 'k1',
      fileName: 'within.pdf',
      contentType: 'application/pdf',
      expiresOn: new Date('2026-05-01T00:00:00Z'),
    });
    const far = await createDocument(db, c.id, {
      kind: 'BUSINESS_LICENSE',
      storageKey: 'k2',
      fileName: 'far.pdf',
      contentType: 'application/pdf',
      expiresOn: new Date('2030-12-01T00:00:00Z'),
    });
    const past = await createDocument(db, c.id, {
      kind: 'RESALE_PERMIT',
      storageKey: 'k3',
      fileName: 'past.pdf',
      contentType: 'application/pdf',
      expiresOn: new Date('2026-01-01T00:00:00Z'),
    });

    const found = await findDocumentsExpiringWithin(db, 60, NOW);
    const ids = found.map((f) => f.id);
    expect(ids).toContain(within.id);
    expect(ids).not.toContain(far.id);
    expect(ids).not.toContain(past.id);

    await softDeleteDocument(db, within.id);
    const found2 = await findDocumentsExpiringWithin(db, 60, NOW);
    expect(found2.map((f) => f.id)).not.toContain(within.id);
  });

  // ---------- Full-table cleartext scans (CRITICAL) ----------

  it('cleartext sentinel never appears in any AuditLog row after a series of operations', async () => {
    const c = await makeCustomer('SCAN-A');
    const doc = await createDocument(db, c.id, {
      kind: 'EIN',
      cleartextValue: SENTINEL_EIN,
    });
    await readEncryptedValue(db, doc.id);
    await readEncryptedValue(db, doc.id); // repeat for noise
    await softDeleteDocument(db, doc.id);

    // Full-table scan over all AuditLog rows. Stringify each and
    // assert the sentinel cleartext is nowhere to be found.
    const allAudits = await db.auditLog.findMany({});
    for (const a of allAudits) {
      const blob = JSON.stringify(a);
      expect(blob).not.toContain(SENTINEL_EIN);
    }
  });

  it('cleartext sentinel never appears in any CustomerActivity row after a series of operations', async () => {
    const c = await makeCustomer('SCAN-B');
    const doc = await createDocument(db, c.id, {
      kind: 'EIN',
      cleartextValue: SENTINEL_EIN,
    });
    await readEncryptedValue(db, doc.id);
    await softDeleteDocument(db, doc.id);

    const allActivity = await db.customerActivity.findMany({});
    for (const a of allActivity) {
      const blob = JSON.stringify(a);
      expect(blob).not.toContain(SENTINEL_EIN);
    }
  });

  // ---------- /cleartext route headers ----------

  it('/cleartext route response sets Cache-Control: no-store and Pragma: no-cache', async () => {
    const c = await makeCustomer('HDR');
    const doc = await createDocument(db, c.id, {
      kind: 'EIN',
      cleartextValue: 'EIN-HDR-TEST',
    });
    const res = await cleartextRouteGet(
      new Request('http://test/x', { headers: { cookie: authCookie } }),
      { params: Promise.resolve({ id: c.id, did: doc.id }) },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('pragma')).toBe('no-cache');
    const json = (await res.json()) as { value?: string };
    expect(json.value).toBe('EIN-HDR-TEST');
  });

  it('/cleartext route on a file kind returns error WITH no-cache headers (no info leak via cache)', async () => {
    const c = await makeCustomer('HDRERR');
    const doc = await createDocument(db, c.id, {
      kind: 'OTHER',
      storageKey: 'k',
      fileName: 'f',
      contentType: 'application/pdf',
    });
    const res = await cleartextRouteGet(
      new Request('http://test/x', { headers: { cookie: authCookie } }),
      { params: Promise.resolve({ id: c.id, did: doc.id }) },
    );
    expect(res.status).toBe(400);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('pragma')).toBe('no-cache');
  });
});

async function wipe(db: PrismaClient): Promise<void> {
  const customers = await db.customer.findMany({
    where: { name: { startsWith: TAG } },
    select: { id: true },
  });
  const ids = customers.map((c) => c.id);
  if (ids.length === 0) return;
  const ourAddresses = await db.customerAddress.findMany({
    where: { customerId: { in: ids } },
    select: { id: true },
  });
  const addressIds = ourAddresses.map((a) => a.id);
  const ourDocuments = await db.customerDocument.findMany({
    where: { customerId: { in: ids } },
    select: { id: true },
  });
  const documentIds = ourDocuments.map((d) => d.id);
  await db.customerDocument.deleteMany({ where: { customerId: { in: ids } } });
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
  if (documentIds.length > 0) {
    await db.auditLog.deleteMany({
      where: { entityType: 'CustomerDocument', entityId: { in: documentIds } },
    });
  }
  await db.customer.deleteMany({ where: { id: { in: ids } } });
}
