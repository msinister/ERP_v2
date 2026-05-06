import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@/generated/tenant';
import { auth } from '@/lib/auth/auth';
import { requireAuth, requireSuperAdmin } from '@/lib/auth/requireAuth';
import { auditCtxFromRequest } from '@/lib/auth/auditCtxFromRequest';
import { AuthError, authErrorResponse } from '@/lib/auth/errors';
import { hasTenantDb, makeClient } from '../helpers/db';

const suite = hasTenantDb ? describe : describe.skip;

const TAG = 'TEST-GUARDS';
const VALID_PASSWORD = 'Guards-1!';

// Helper: create a user via BetterAuth, sign them in, and return the
// session cookie header string we can replay on Request objects.
async function makeUserAndSession(
  db: PrismaClient,
  opts: {
    email: string;
    isSuperAdmin?: boolean;
    enabled?: boolean;
  },
): Promise<{ userId: string; cookie: string }> {
  const r = await auth.api.signUpEmail({
    body: { email: opts.email, password: VALID_PASSWORD, name: `${TAG} ${opts.email}` },
  });
  const userId = r?.user?.id;
  if (!userId) throw new Error('signUpEmail did not return id');
  if (opts.isSuperAdmin || opts.enabled === false) {
    await db.user.update({
      where: { id: userId },
      data: {
        isSuperAdmin: opts.isSuperAdmin ?? false,
        enabled: opts.enabled !== false,
      },
    });
  }
  // If user is disabled, sign-in will be blocked by the create-session
  // hook, so we sign in BEFORE flipping enabled to false. To test the
  // disabled-mid-session case, sign in first and disable after.
  // Here we always sign in pre-disable since we want a valid cookie.
  let signInUserId = userId;
  if (opts.enabled === false) {
    // Re-enable temporarily so sign-in succeeds, then disable.
    await db.user.update({ where: { id: userId }, data: { enabled: true } });
  }
  const signIn = (await auth.api.signInEmail({
    body: { email: opts.email, password: VALID_PASSWORD },
    asResponse: true,
  })) as Response;
  void signInUserId;
  const setCookie = signIn.headers.get('set-cookie');
  if (!setCookie) throw new Error('no Set-Cookie on sign-in response');
  const cookie = setCookie
    .split(/,(?=[^;]+=)/)
    .map((c) => c.split(';')[0].trim())
    .join('; ');
  if (opts.enabled === false) {
    await db.user.update({ where: { id: userId }, data: { enabled: false } });
  }
  return { userId, cookie };
}

function reqWithCookie(cookie: string | null, extraHeaders: Record<string, string> = {}): Request {
  const headers = new Headers(extraHeaders);
  if (cookie) headers.set('cookie', cookie);
  return new Request('http://localhost:3000/api/test', { headers });
}

suite('Auth guards — requireAuth / requireSuperAdmin / auditCtxFromRequest', () => {
  let db: PrismaClient;

  beforeAll(async () => {
    db = makeClient();
  });

  beforeEach(async () => {
    await wipe(db);
  });

  afterAll(async () => {
    await wipe(db);
    await db.$disconnect();
  });

  // ---------- requireAuth ----------

  it('requireAuth returns the user for a valid session cookie', async () => {
    const { userId, cookie } = await makeUserAndSession(db, {
      email: `${TAG.toLowerCase()}-happy@x.com`,
    });
    const u = await requireAuth(reqWithCookie(cookie));
    expect(u.id).toBe(userId);
    expect(u.isSuperAdmin).toBe(false);
    expect(u.enabled).toBe(true);
  });

  it('requireAuth throws AuthError(401) when no session cookie is present', async () => {
    await expect(requireAuth(reqWithCookie(null))).rejects.toBeInstanceOf(AuthError);
    try {
      await requireAuth(reqWithCookie(null));
    } catch (e) {
      expect((e as AuthError).status).toBe(401);
    }
  });

  it('requireAuth throws AuthError(401) for a forged session cookie', async () => {
    const forged = 'better-auth.session_token=this-is-not-a-real-signed-token';
    await expect(requireAuth(reqWithCookie(forged))).rejects.toBeInstanceOf(AuthError);
  });

  it('requireAuth throws AuthError(401) when the user has been disabled mid-session', async () => {
    const { userId, cookie } = await makeUserAndSession(db, {
      email: `${TAG.toLowerCase()}-disable-mid@x.com`,
    });
    // Disable the user AFTER login — the session row is still valid in
    // BetterAuth's sense, but we reject at the guard.
    await db.user.update({ where: { id: userId }, data: { enabled: false } });
    await expect(requireAuth(reqWithCookie(cookie))).rejects.toBeInstanceOf(AuthError);
  });

  it('requireAuth throws AuthError(401) when the user has been soft-deleted mid-session', async () => {
    const { userId, cookie } = await makeUserAndSession(db, {
      email: `${TAG.toLowerCase()}-sd-mid@x.com`,
    });
    await db.user.update({ where: { id: userId }, data: { deletedAt: new Date() } });
    await expect(requireAuth(reqWithCookie(cookie))).rejects.toBeInstanceOf(AuthError);
  });

  // ---------- requireSuperAdmin ----------

  it('requireSuperAdmin returns the user for an authenticated Super Admin', async () => {
    const { userId, cookie } = await makeUserAndSession(db, {
      email: `${TAG.toLowerCase()}-super@x.com`,
      isSuperAdmin: true,
    });
    const u = await requireSuperAdmin(reqWithCookie(cookie));
    expect(u.id).toBe(userId);
    expect(u.isSuperAdmin).toBe(true);
  });

  it('requireSuperAdmin throws AuthError(403) for a non-super authenticated user', async () => {
    const { cookie } = await makeUserAndSession(db, {
      email: `${TAG.toLowerCase()}-nonsuper@x.com`,
      isSuperAdmin: false,
    });
    try {
      await requireSuperAdmin(reqWithCookie(cookie));
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(AuthError);
      expect((e as AuthError).status).toBe(403);
    }
  });

  it('requireSuperAdmin throws AuthError(401) when no session is present', async () => {
    try {
      await requireSuperAdmin(reqWithCookie(null));
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(AuthError);
      expect((e as AuthError).status).toBe(401);
    }
  });

  // ---------- authErrorResponse ----------

  it('authErrorResponse maps AuthError to a JSON Response with the right status', async () => {
    const r401 = authErrorResponse(new AuthError(401, 'unauthorized'));
    expect(r401).not.toBeNull();
    expect(r401!.status).toBe(401);
    expect(r401!.headers.get('Cache-Control')).toBe('no-store');

    const r403 = authErrorResponse(new AuthError(403, 'forbidden'));
    expect(r403!.status).toBe(403);
  });

  it('authErrorResponse returns null for non-AuthError values', () => {
    expect(authErrorResponse(new Error('boom'))).toBeNull();
    expect(authErrorResponse(undefined)).toBeNull();
    expect(authErrorResponse('string')).toBeNull();
  });

  // ---------- auditCtxFromRequest ----------

  it('auditCtxFromRequest puts userId on the context', () => {
    const ctx = auditCtxFromRequest(reqWithCookie(null), {
      id: 'user-abc',
      email: 'x@y.com',
      name: 'X',
      isSuperAdmin: false,
      enabled: true,
    });
    expect(ctx.userId).toBe('user-abc');
    expect(ctx.ipAddress).toBeNull();
    expect(ctx.reason).toBeNull();
  });

  it('auditCtxFromRequest extracts the leftmost x-forwarded-for entry', () => {
    const ctx = auditCtxFromRequest(
      reqWithCookie(null, { 'x-forwarded-for': '203.0.113.7, 10.0.0.1, 10.0.0.2' }),
      { id: 'u', email: 'a@b.c', name: 'a', isSuperAdmin: false, enabled: true },
    );
    expect(ctx.ipAddress).toBe('203.0.113.7');
  });

  it('auditCtxFromRequest falls back to x-real-ip when x-forwarded-for is absent', () => {
    const ctx = auditCtxFromRequest(
      reqWithCookie(null, { 'x-real-ip': '198.51.100.4' }),
      { id: 'u', email: 'a@b.c', name: 'a', isSuperAdmin: false, enabled: true },
    );
    expect(ctx.ipAddress).toBe('198.51.100.4');
  });

  it('auditCtxFromRequest prefers x-forwarded-for over x-real-ip when both are present', () => {
    const ctx = auditCtxFromRequest(
      reqWithCookie(null, {
        'x-forwarded-for': '203.0.113.7',
        'x-real-ip': '198.51.100.4',
      }),
      { id: 'u', email: 'a@b.c', name: 'a', isSuperAdmin: false, enabled: true },
    );
    expect(ctx.ipAddress).toBe('203.0.113.7');
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
