/**
 * Route-level integration tests for the new customer sub-resource API routes:
 *
 *   Addresses:
 *     GET/POST  /api/customers/[id]/addresses
 *     PATCH/DELETE /api/customers/[id]/addresses/[aid]
 *     POST      /api/customers/[id]/addresses/[aid]/set-default
 *
 *   Contacts:
 *     GET/POST  /api/customers/[id]/contacts
 *     PATCH/DELETE /api/customers/[id]/contacts/[cid]
 *
 *   Documents (update path):
 *     PATCH     /api/customers/[id]/documents/[did]
 *
 * Service invariants (default-enforcement, advisory locks, encryption) are
 * tested at the service layer — see customers.addresses.test.ts,
 * customers.contacts.test.ts, and customers.documents.update.test.ts.
 * These tests verify the HTTP layer: request routing, auth gate, validation
 * rejection, and success responses.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Customer, PaymentTerm, PrismaClient, SalesRep } from '@/generated/tenant';
import { createCustomer } from '@/server/services/customers';
import { createDocument } from '@/server/services/customerDocuments';
import { auth } from '@/lib/auth/auth';
import { hasTenantDb, makeClient } from '../helpers/db';

// Route handlers under test
import {
  GET as addressesGet,
  POST as addressesPost,
} from '@/app/api/customers/[id]/addresses/route';
import {
  PATCH as addressPatch,
  DELETE as addressDelete,
} from '@/app/api/customers/[id]/addresses/[aid]/route';
import { POST as addressSetDefault } from '@/app/api/customers/[id]/addresses/[aid]/set-default/route';
import {
  GET as contactsGet,
  POST as contactsPost,
} from '@/app/api/customers/[id]/contacts/route';
import {
  PATCH as contactPatch,
  DELETE as contactDelete,
} from '@/app/api/customers/[id]/contacts/[cid]/route';
import {
  PATCH as documentPatch,
} from '@/app/api/customers/[id]/documents/[did]/route';

const suite = hasTenantDb ? describe : describe.skip;

const TAG = 'TEST-CRUDRT';
const AUTH_EMAIL = 'crud-routes-suite@erp.test';
const AUTH_PASSWORD = 'CrudRoutes-1!';
const AUTH_NAME = 'crud-routes-suite';

async function makeAuthCookie(db: PrismaClient): Promise<string> {
  // Clean up any prior run's leftover user.
  const existing = await db.user.findUnique({ where: { email: AUTH_EMAIL } });
  if (existing) {
    await db.session.deleteMany({ where: { userId: existing.id } });
    await db.account.deleteMany({ where: { userId: existing.id } });
    await db.user.delete({ where: { id: existing.id } });
  }
  await auth.api.signUpEmail({
    body: { email: AUTH_EMAIL, password: AUTH_PASSWORD, name: AUTH_NAME },
  });
  const resp = (await auth.api.signInEmail({
    body: { email: AUTH_EMAIL, password: AUTH_PASSWORD },
    asResponse: true,
  })) as Response;
  const raw = resp.headers.get('set-cookie') ?? '';
  return raw
    .split(/,(?=[^;]+=)/)
    .map((c) => c.split(';')[0].trim())
    .join('; ');
}

function makeReq(cookie: string, method = 'GET', body?: unknown): Request {
  return new Request('http://test/', {
    method,
    headers: {
      cookie,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

suite('Customer CRUD routes', () => {
  let db: PrismaClient;
  let salesRep: SalesRep;
  let term: PaymentTerm;
  let cookie: string;

  beforeAll(async () => {
    db = makeClient();
    salesRep = await db.salesRep.findFirstOrThrow({ where: { code: 'UNASSIGNED' } });
    term = await db.paymentTerm.findFirstOrThrow({ where: { code: 'NET30' } });
    cookie = await makeAuthCookie(db);
  });

  beforeEach(() => wipe(db));
  afterAll(async () => {
    await wipe(db);
    await wipeAuthUser(db);
    await db.$disconnect();
  });

  async function makeCustomer(label: string): Promise<Customer> {
    return createCustomer(db, {
      name: `${TAG} ${label}`,
      salesRepId: salesRep.id,
      paymentTermId: term.id,
    });
  }

  // =========================================================================
  // Addresses
  // =========================================================================

  describe('addresses', () => {
    it('GET /addresses → 200 with array', async () => {
      const c = await makeCustomer('A-LIST');
      const res = await addressesGet(
        makeReq(cookie),
        { params: Promise.resolve({ id: c.id }) },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as unknown[];
      expect(Array.isArray(body)).toBe(true);
    });

    it('POST /addresses → 201 creates a billing address', async () => {
      const c = await makeCustomer('A-POST-BILL');
      const res = await addressesPost(
        makeReq(cookie, 'POST', {
          kind: 'BILLING',
          line1: '100 Main St',
          city: 'Austin',
          region: 'TX',
          postalCode: '78701',
        }),
        { params: Promise.resolve({ id: c.id }) },
      );
      expect(res.status).toBe(201);
      const body = (await res.json()) as { kind: string; isDefault: boolean };
      expect(body.kind).toBe('BILLING');
      expect(body.isDefault).toBe(true);
    });

    it('POST /addresses → 201 creates a shipping address', async () => {
      const c = await makeCustomer('A-POST-SHIP');
      const res = await addressesPost(
        makeReq(cookie, 'POST', {
          kind: 'SHIPPING',
          isDefault: true,
          line1: '200 Ship St',
          city: 'Houston',
          region: 'TX',
          postalCode: '77001',
        }),
        { params: Promise.resolve({ id: c.id }) },
      );
      expect(res.status).toBe(201);
      const body = (await res.json()) as { kind: string; isDefault: boolean };
      expect(body.kind).toBe('SHIPPING');
      expect(body.isDefault).toBe(true);
    });

    it('POST /addresses → 400 on validation failure (missing required field)', async () => {
      const c = await makeCustomer('A-POST-INVALID');
      const res = await addressesPost(
        makeReq(cookie, 'POST', { kind: 'BILLING', line1: '100 St' /* missing city/region/zip */ }),
        { params: Promise.resolve({ id: c.id }) },
      );
      expect(res.status).toBe(400);
    });

    it('POST /addresses → 401 without session', async () => {
      const c = await makeCustomer('A-POST-UNAUTH');
      const res = await addressesPost(
        makeReq('', 'POST', {
          kind: 'BILLING',
          line1: '1 St',
          city: 'Dallas',
          region: 'TX',
          postalCode: '75201',
        }),
        { params: Promise.resolve({ id: c.id }) },
      );
      expect(res.status).toBe(401);
    });

    it('PATCH /addresses/[aid] → 200 updates label and city', async () => {
      const c = await makeCustomer('A-PATCH');
      const created = (await (await addressesPost(
        makeReq(cookie, 'POST', {
          kind: 'BILLING',
          line1: '1 St',
          city: 'Old City',
          region: 'TX',
          postalCode: '75201',
        }),
        { params: Promise.resolve({ id: c.id }) },
      )).json()) as { id: string };

      const res = await addressPatch(
        makeReq(cookie, 'PATCH', { city: 'New City', label: 'HQ' }),
        { params: Promise.resolve({ id: c.id, aid: created.id }) },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { city: string; label: string };
      expect(body.city).toBe('New City');
      expect(body.label).toBe('HQ');
    });

    it('DELETE /addresses/[aid] → 200 soft-deletes the address', async () => {
      const c = await makeCustomer('A-DEL');
      const created = (await (await addressesPost(
        makeReq(cookie, 'POST', {
          kind: 'SHIPPING',
          line1: '1 St',
          city: 'Dallas',
          region: 'TX',
          postalCode: '75201',
        }),
        { params: Promise.resolve({ id: c.id }) },
      )).json()) as { id: string };

      const res = await addressDelete(
        makeReq(cookie, 'DELETE'),
        { params: Promise.resolve({ id: c.id, aid: created.id }) },
      );
      expect(res.status).toBe(200);

      const listRes = await addressesGet(
        makeReq(cookie),
        { params: Promise.resolve({ id: c.id }) },
      );
      const list = (await listRes.json()) as Array<{ id: string }>;
      expect(list.some((a) => a.id === created.id)).toBe(false);
    });

    it('POST /addresses/[aid]/set-default → 200 makes shipping address the default', async () => {
      const c = await makeCustomer('A-SETDEF');
      // Create two shipping addresses; first is default.
      const first = (await (await addressesPost(
        makeReq(cookie, 'POST', {
          kind: 'SHIPPING', isDefault: true,
          line1: '1 A', city: 'Dallas', region: 'TX', postalCode: '75201',
        }),
        { params: Promise.resolve({ id: c.id }) },
      )).json()) as { id: string };

      const second = (await (await addressesPost(
        makeReq(cookie, 'POST', {
          kind: 'SHIPPING', isDefault: false,
          line1: '1 B', city: 'Dallas', region: 'TX', postalCode: '75201',
        }),
        { params: Promise.resolve({ id: c.id }) },
      )).json()) as { id: string };

      const res = await addressSetDefault(
        makeReq(cookie, 'POST'),
        { params: Promise.resolve({ id: c.id, aid: second.id }) },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { isDefault: boolean };
      expect(body.isDefault).toBe(true);

      // The first address must no longer be default.
      const fresh = await db.customerAddress.findUnique({ where: { id: first.id } });
      expect(fresh?.isDefault).toBe(false);
    });
  });

  // =========================================================================
  // Contacts
  // =========================================================================

  describe('contacts', () => {
    it('GET /contacts → 200 with array', async () => {
      const c = await makeCustomer('C-LIST');
      const res = await contactsGet(
        makeReq(cookie),
        { params: Promise.resolve({ id: c.id }) },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as unknown[];
      expect(Array.isArray(body)).toBe(true);
    });

    it('POST /contacts → 201 creates a contact', async () => {
      const c = await makeCustomer('C-POST');
      const res = await contactsPost(
        makeReq(cookie, 'POST', {
          name: 'Jane Buyer',
          role: 'Buyer',
          email: 'jane@example.com',
        }),
        { params: Promise.resolve({ id: c.id }) },
      );
      expect(res.status).toBe(201);
      const body = (await res.json()) as { name: string; role: string };
      expect(body.name).toBe('Jane Buyer');
      expect(body.role).toBe('Buyer');
    });

    it('POST /contacts → 400 on missing name', async () => {
      const c = await makeCustomer('C-POST-INV');
      const res = await contactsPost(
        makeReq(cookie, 'POST', { role: 'Buyer' }),
        { params: Promise.resolve({ id: c.id }) },
      );
      expect(res.status).toBe(400);
    });

    it('POST /contacts → 401 without session', async () => {
      const c = await makeCustomer('C-POST-UNAUTH');
      const res = await contactsPost(
        makeReq('', 'POST', { name: 'X' }),
        { params: Promise.resolve({ id: c.id }) },
      );
      expect(res.status).toBe(401);
    });

    it('PATCH /contacts/[cid] → 200 updates name and role', async () => {
      const c = await makeCustomer('C-PATCH');
      const created = (await (await contactsPost(
        makeReq(cookie, 'POST', { name: 'Old Name', role: 'AP' }),
        { params: Promise.resolve({ id: c.id }) },
      )).json()) as { id: string };

      const res = await contactPatch(
        makeReq(cookie, 'PATCH', { name: 'New Name', role: 'AR' }),
        { params: Promise.resolve({ id: c.id, cid: created.id }) },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { name: string; role: string };
      expect(body.name).toBe('New Name');
      expect(body.role).toBe('AR');
    });

    it('DELETE /contacts/[cid] → 200 soft-deletes the contact', async () => {
      const c = await makeCustomer('C-DEL');
      const created = (await (await contactsPost(
        makeReq(cookie, 'POST', { name: 'To Delete' }),
        { params: Promise.resolve({ id: c.id }) },
      )).json()) as { id: string };

      const res = await contactDelete(
        makeReq(cookie, 'DELETE'),
        { params: Promise.resolve({ id: c.id, cid: created.id }) },
      );
      expect(res.status).toBe(200);

      const listRes = await contactsGet(
        makeReq(cookie),
        { params: Promise.resolve({ id: c.id }) },
      );
      const list = (await listRes.json()) as Array<{ id: string }>;
      expect(list.some((x) => x.id === created.id)).toBe(false);
    });
  });

  // =========================================================================
  // Document PATCH (metadata + sensitive value update)
  // =========================================================================

  describe('documents PATCH', () => {
    it('PATCH /documents/[did] → 200 updates notes and expiresOn', async () => {
      const c = await makeCustomer('D-PATCH-META');
      const doc = await createDocument(db, c.id, {
        kind: 'RESALE_CERT',
        storageKey: 'k',
        fileName: 'f',
        contentType: 'application/pdf',
      });

      const res = await documentPatch(
        makeReq(cookie, 'PATCH', {
          notes: 'updated via route',
          expiresOn: '2031-01-01',
        }),
        { params: Promise.resolve({ id: c.id, did: doc.id }) },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { notes: string; expiresOn: string };
      expect(body.notes).toBe('updated via route');
      // expiresOn is serialized as ISO string.
      expect(body.expiresOn).toContain('2031-01-01');
    });

    it('PATCH /documents/[did] → 200 re-encrypts sensitive document value', async () => {
      const c = await makeCustomer('D-PATCH-REENC');
      const doc = await createDocument(db, c.id, {
        kind: 'EIN',
        cleartextValue: 'EIN-ORIGINAL',
      });

      const res = await documentPatch(
        makeReq(cookie, 'PATCH', { cleartextValue: 'EIN-UPDATED' }),
        { params: Promise.resolve({ id: c.id, did: doc.id }) },
      );
      expect(res.status).toBe(200);
      // Encrypted columns must be stripped from the response.
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.encryptedValue).toBeUndefined();
      expect(body.encryptedValueIv).toBeUndefined();
    });

    it('PATCH /documents/[did] → 400 when cleartextValue sent for a file kind', async () => {
      const c = await makeCustomer('D-PATCH-GUARD');
      const doc = await createDocument(db, c.id, {
        kind: 'OTHER',
        storageKey: 'k',
        fileName: 'f',
        contentType: 'application/pdf',
      });
      const res = await documentPatch(
        makeReq(cookie, 'PATCH', { cleartextValue: 'should-be-rejected' }),
        { params: Promise.resolve({ id: c.id, did: doc.id }) },
      );
      expect(res.status).toBe(400);
    });

    it('PATCH /documents/[did] → 401 without session', async () => {
      const c = await makeCustomer('D-PATCH-UNAUTH');
      const doc = await createDocument(db, c.id, {
        kind: 'OTHER',
        storageKey: 'k',
        fileName: 'f',
        contentType: 'application/pdf',
      });
      const res = await documentPatch(
        makeReq('', 'PATCH', { notes: 'x' }),
        { params: Promise.resolve({ id: c.id, did: doc.id }) },
      );
      expect(res.status).toBe(401);
    });
  });
});

// ---------------------------------------------------------------------------
// Cleanup helpers
// ---------------------------------------------------------------------------

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
  const addrIds = (
    await db.customerAddress.findMany({ where: { customerId: { in: ids } }, select: { id: true } })
  ).map((a) => a.id);
  const contactIds = (
    await db.customerContact.findMany({ where: { customerId: { in: ids } }, select: { id: true } })
  ).map((x) => x.id);

  await db.customerDocument.deleteMany({ where: { customerId: { in: ids } } });
  await db.customerContact.deleteMany({ where: { customerId: { in: ids } } });
  await db.customerActivity.deleteMany({ where: { customerId: { in: ids } } });
  await db.customerAddress.deleteMany({ where: { customerId: { in: ids } } });

  for (const [type, typeIds] of [
    ['CustomerDocument', docIds] as const,
    ['CustomerAddress', addrIds] as const,
    ['CustomerContact', contactIds] as const,
  ]) {
    if (typeIds.length > 0) {
      await db.auditLog.deleteMany({
        where: { entityType: type, entityId: { in: typeIds } },
      });
    }
  }
  await db.auditLog.deleteMany({ where: { entityType: 'Customer', entityId: { in: ids } } });
  await db.customer.deleteMany({ where: { id: { in: ids } } });
}

async function wipeAuthUser(db: PrismaClient): Promise<void> {
  const u = await db.user.findUnique({ where: { email: AUTH_EMAIL } });
  if (!u) return;
  await db.session.deleteMany({ where: { userId: u.id } });
  await db.account.deleteMany({ where: { userId: u.id } });
  await db.user.delete({ where: { id: u.id } });
}
