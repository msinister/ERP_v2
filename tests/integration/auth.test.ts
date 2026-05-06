import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditAction } from '@/generated/tenant';
import type { PrismaClient } from '@/generated/tenant';
import { auth } from '@/lib/auth/auth';
import { hasTenantDb, makeClient } from '../helpers/db';

const suite = hasTenantDb ? describe : describe.skip;

const TAG = 'TEST-AUTH';

// Sentinel password — meets the spec policy (>=8, upper, lower, digit, special).
const VALID_PASSWORD = 'Sentinel-1!';

suite('Auth — login + session lifecycle + audit', () => {
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

  async function makeUser(opts: {
    email: string;
    name?: string;
    enabled?: boolean;
    isSuperAdmin?: boolean;
  }) {
    // Create the user via BetterAuth's signUpEmail so the password hash
    // is owned by BetterAuth (the same path the bootstrap script uses).
    const r = await auth.api.signUpEmail({
      body: {
        email: opts.email,
        password: VALID_PASSWORD,
        name: opts.name ?? `${TAG} ${opts.email}`,
      },
    });
    const id = r?.user?.id;
    if (!id) throw new Error('signUpEmail did not return a user id');
    if (opts.enabled === false || opts.isSuperAdmin) {
      await db.user.update({
        where: { id },
        data: {
          enabled: opts.enabled !== false,
          isSuperAdmin: opts.isSuperAdmin ?? false,
        },
      });
    }
    return id;
  }

  // ---------- Login flow ----------

  it('signInEmail with correct password returns a session token', async () => {
    const email = `${TAG.toLowerCase()}-success@x.com`;
    await makeUser({ email });
    const r = await auth.api.signInEmail({
      body: { email, password: VALID_PASSWORD },
    });
    expect(r).toBeDefined();
    expect((r as { token?: string }).token).toBeTruthy();
    // Session row should exist for the user.
    const sessions = await db.session.findMany({
      where: { user: { email } },
    });
    expect(sessions.length).toBeGreaterThanOrEqual(1);
  });

  it('signInEmail with wrong password throws and creates no session', async () => {
    const email = `${TAG.toLowerCase()}-bad@x.com`;
    await makeUser({ email });
    await expect(
      auth.api.signInEmail({
        body: { email, password: 'WrongPass-9!' },
      }),
    ).rejects.toThrow();
    const sessions = await db.session.findMany({
      where: { user: { email } },
    });
    expect(sessions).toHaveLength(0);
  });

  it('signInEmail for a disabled user is blocked by the create-session hook', async () => {
    const email = `${TAG.toLowerCase()}-disabled@x.com`;
    await makeUser({ email, enabled: false });
    // BetterAuth surfaces a hook-blocked sign-in as a thrown APIError.
    await expect(
      auth.api.signInEmail({
        body: { email, password: VALID_PASSWORD },
      }),
    ).rejects.toThrow();
    const sessions = await db.session.findMany({
      where: { user: { email } },
    });
    expect(sessions).toHaveLength(0);
  });

  it('signInEmail for a soft-deleted user is blocked', async () => {
    const email = `${TAG.toLowerCase()}-sd@x.com`;
    const id = await makeUser({ email });
    await db.user.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    await expect(
      auth.api.signInEmail({
        body: { email, password: VALID_PASSWORD },
      }),
    ).rejects.toThrow();
    const sessions = await db.session.findMany({ where: { userId: id } });
    expect(sessions).toHaveLength(0);
  });

  // ---------- Audit hooks ----------

  it('successful login writes a LOGIN AuditLog row attributed to the user', async () => {
    const email = `${TAG.toLowerCase()}-audit-login@x.com`;
    const id = await makeUser({ email });
    await auth.api.signInEmail({
      body: { email, password: VALID_PASSWORD },
    });
    // The hook is async-after; allow the row to land.
    const rows = await db.auditLog.findMany({
      where: { entityType: 'User', entityId: id, action: AuditAction.LOGIN },
    });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].userId).toBe(id);
  });

  it('successful login updates User.lastLoginAt', async () => {
    const email = `${TAG.toLowerCase()}-lastlogin@x.com`;
    const id = await makeUser({ email });
    const before = await db.user.findUniqueOrThrow({ where: { id } });
    expect(before.lastLoginAt).toBeNull();
    await auth.api.signInEmail({
      body: { email, password: VALID_PASSWORD },
    });
    const after = await db.user.findUniqueOrThrow({ where: { id } });
    expect(after.lastLoginAt).not.toBeNull();
    expect(after.lastLoginAt!.getTime()).toBeGreaterThan(before.createdAt.getTime() - 1);
  });

  it('signOut writes a LOGOUT AuditLog row', async () => {
    const email = `${TAG.toLowerCase()}-audit-logout@x.com`;
    const id = await makeUser({ email });
    const signIn = (await auth.api.signInEmail({
      body: { email, password: VALID_PASSWORD },
      asResponse: true,
    })) as Response;
    // Extract the session cookie BetterAuth set on the sign-in response
    // and replay it on signOut so the API helper authenticates the
    // logout against this session. asResponse:true gives us the raw
    // Set-Cookie header.
    const setCookie = signIn.headers.get('set-cookie');
    expect(setCookie).toBeTruthy();
    const cookieHeader = (setCookie ?? '')
      .split(/,(?=[^;]+=)/) // split multiple cookies
      .map((c) => c.split(';')[0].trim())
      .join('; ');

    await auth.api.signOut({
      headers: new Headers({ cookie: cookieHeader }),
    });

    const rows = await db.auditLog.findMany({
      where: { entityType: 'User', entityId: id, action: AuditAction.LOGOUT },
    });
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  // ---------- Schema integrity ----------

  it('User.email is unique — duplicate signUp throws', async () => {
    const email = `${TAG.toLowerCase()}-dup@x.com`;
    await makeUser({ email });
    await expect(
      auth.api.signUpEmail({
        body: { email, password: VALID_PASSWORD, name: 'Dup' },
      }),
    ).rejects.toThrow();
  });

  it('isSuperAdmin defaults to false on new accounts', async () => {
    const email = `${TAG.toLowerCase()}-default@x.com`;
    const id = await makeUser({ email });
    const u = await db.user.findUniqueOrThrow({ where: { id } });
    expect(u.isSuperAdmin).toBe(false);
    expect(u.enabled).toBe(true);
    expect(u.deletedAt).toBeNull();
  });

  // ---------- Password policy enforcement (boundary layer, not BetterAuth) ----------

  it('BetterAuth enforces minimum length only — service-layer policy is checked elsewhere', async () => {
    // BetterAuth is configured with minPasswordLength=8. A 7-char password
    // is rejected at the BetterAuth boundary itself.
    await expect(
      auth.api.signUpEmail({
        body: {
          email: `${TAG.toLowerCase()}-shortpw@x.com`,
          password: 'Aa1!aaa', // 7 chars
          name: 'Short',
        },
      }),
    ).rejects.toThrow();
  });
});

async function wipe(db: PrismaClient): Promise<void> {
  // Delete users matching our tag — sessions + accounts cascade via FK.
  const ours = await db.user.findMany({
    where: {
      OR: [
        { email: { startsWith: TAG.toLowerCase() } },
        { name: { startsWith: TAG } },
      ],
    },
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
