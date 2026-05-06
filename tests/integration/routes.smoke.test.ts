import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@/generated/tenant';
import { auth } from '@/lib/auth/auth';
import { hasTenantDb, makeClient } from '../helpers/db';

// Route handlers under test (a representative sample — the full sweep is
// the static-analysis test in tests/unit/routes.auth-coverage.test.ts).
//
// We import each handler directly and call it like Next.js would, with a
// constructed Request that does or doesn't carry a session cookie.
import { GET as customersGet, POST as customersPost } from '@/app/api/customers/route';
import { GET as invoicesGet } from '@/app/api/invoices/route';
import { GET as agingGet } from '@/app/api/ar/aging-summary/route';
import { POST as inventoryAdjustPost } from '@/app/api/inventory/adjust/route';

const suite = hasTenantDb ? describe : describe.skip;

const TAG = 'TEST-SMOKE-RT';
const VALID_PASSWORD = 'Smoke-1!';

async function makeUserAndCookie(
  db: PrismaClient,
  email: string,
): Promise<string> {
  await auth.api.signUpEmail({
    body: { email, password: VALID_PASSWORD, name: `${TAG} ${email}` },
  });
  const signIn = (await auth.api.signInEmail({
    body: { email, password: VALID_PASSWORD },
    asResponse: true,
  })) as Response;
  const setCookie = signIn.headers.get('set-cookie');
  if (!setCookie) throw new Error('no Set-Cookie on sign-in response');
  return setCookie
    .split(/,(?=[^;]+=)/)
    .map((c) => c.split(';')[0].trim())
    .join('; ');
}

function buildReq(
  url: string,
  init: RequestInit & { cookie?: string } = {},
): Request {
  const headers = new Headers(init.headers ?? {});
  if (init.cookie) headers.set('cookie', init.cookie);
  return new Request(url, { ...init, headers });
}

suite('API routes — smoke (real session, end-to-end)', () => {
  let db: PrismaClient;
  let cookie: string;

  beforeAll(async () => {
    db = makeClient();
    await wipe(db);
    cookie = await makeUserAndCookie(db, `${TAG.toLowerCase()}@x.com`);
  });

  beforeEach(async () => {
    // Don't wipe the user between tests — we need the cookie to keep
    // working. Wipe only at suite end.
  });

  afterAll(async () => {
    await wipe(db);
    await db.$disconnect();
  });

  // ---------- Unauthenticated rejection (401) ----------

  it('GET /api/customers without a session cookie → 401', async () => {
    const res = await customersGet(buildReq('http://localhost:3000/api/customers'));
    expect(res.status).toBe(401);
  });

  it('POST /api/customers without a session cookie → 401', async () => {
    const res = await customersPost(
      buildReq('http://localhost:3000/api/customers', {
        method: 'POST',
        body: JSON.stringify({ name: 'X' }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it('GET /api/invoices without a session cookie → 401', async () => {
    const res = await invoicesGet(buildReq('http://localhost:3000/api/invoices'));
    expect(res.status).toBe(401);
  });

  it('GET /api/ar/aging-summary without a session cookie → 401', async () => {
    const res = await agingGet(
      buildReq('http://localhost:3000/api/ar/aging-summary'),
    );
    expect(res.status).toBe(401);
  });

  it('POST /api/inventory/adjust without a session cookie → 401', async () => {
    const res = await inventoryAdjustPost(
      buildReq('http://localhost:3000/api/inventory/adjust', {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(401);
  });

  it('forged session cookie → 401 (signature check at requireAuth)', async () => {
    const forged =
      'better-auth.session_token=this-is-not-a-real-signed-token-just-noise';
    const res = await customersGet(
      buildReq('http://localhost:3000/api/customers', { cookie: forged }),
    );
    expect(res.status).toBe(401);
  });

  // ---------- Authenticated success ----------

  it('GET /api/customers with a valid session → 200', async () => {
    const res = await customersGet(
      buildReq('http://localhost:3000/api/customers', { cookie }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown[];
    expect(Array.isArray(body)).toBe(true);
  });

  it('GET /api/invoices with a valid session → 200', async () => {
    const res = await invoicesGet(
      buildReq('http://localhost:3000/api/invoices', { cookie }),
    );
    expect(res.status).toBe(200);
  });

  it('GET /api/ar/aging-summary with a valid session → 200', async () => {
    const res = await agingGet(
      buildReq('http://localhost:3000/api/ar/aging-summary', { cookie }),
    );
    expect(res.status).toBe(200);
  });
});

async function wipe(db: PrismaClient): Promise<void> {
  const ours = await db.user.findMany({
    where: { name: { startsWith: TAG } },
    select: { id: true },
  });
  const ids = ours.map((u) => u.id);
  if (ids.length === 0) return;
  await db.session.deleteMany({ where: { userId: { in: ids } } });
  await db.account.deleteMany({ where: { userId: { in: ids } } });
  await db.auditLog.deleteMany({
    where: { entityType: 'User', entityId: { in: ids } },
  });
  await db.user.deleteMany({ where: { id: { in: ids } } });
}
