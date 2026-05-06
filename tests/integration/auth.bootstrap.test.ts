import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { AuditAction } from '@/generated/tenant';
import type { PrismaClient } from '@/generated/tenant';
import { hasTenantDb, makeClient } from '../helpers/db';

const suite = hasTenantDb ? describe : describe.skip;

const TAG_EMAIL = 'test-bootstrap@erp.test';
const VALID_PASSWORD = 'Bootstrap-1!';

function runBootstrap(env: Record<string, string>): { stdout: string; stderr: string; code: number } {
  try {
    const stdout = execSync(
      'npx tsx scripts/create-first-super-admin.ts',
      {
        env: {
          ...process.env,
          // Reuse the existing tenant DB connection so the script
          // writes to the same DB this test reads from.
          ...env,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
      },
    );
    return { stdout, stderr: '', code: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return {
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
      code: err.status ?? 1,
    };
  }
}

suite('Bootstrap script — first Super Admin provisioning', () => {
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

  it('creates a Super Admin from env vars', async () => {
    const r = runBootstrap({
      SEED_ADMIN_EMAIL: TAG_EMAIL,
      SEED_ADMIN_PASSWORD: VALID_PASSWORD,
      SEED_ADMIN_NAME: 'Bootstrap Tester',
    });
    expect(r.code).toBe(0);
    const u = await db.user.findUnique({ where: { email: TAG_EMAIL } });
    expect(u).not.toBeNull();
    expect(u!.isSuperAdmin).toBe(true);
    expect(u!.enabled).toBe(true);
    expect(u!.deletedAt).toBeNull();
    expect(u!.name).toBe('Bootstrap Tester');
    // Account row with hashed password should exist.
    const accounts = await db.account.findMany({ where: { userId: u!.id } });
    expect(accounts).toHaveLength(1);
    expect(accounts[0].providerId).toBe('credential');
    expect(accounts[0].password).toBeTruthy();
    // Password is stored as a hash, not cleartext.
    expect(accounts[0].password).not.toBe(VALID_PASSWORD);
  });

  it('is idempotent: re-running with the same credentials is a no-op', async () => {
    const env = {
      SEED_ADMIN_EMAIL: TAG_EMAIL,
      SEED_ADMIN_PASSWORD: VALID_PASSWORD,
      SEED_ADMIN_NAME: 'Bootstrap Tester',
    };
    const first = runBootstrap(env);
    expect(first.code).toBe(0);
    const u1 = await db.user.findUniqueOrThrow({ where: { email: TAG_EMAIL } });

    const second = runBootstrap(env);
    expect(second.code).toBe(0);
    const u2 = await db.user.findUniqueOrThrow({ where: { email: TAG_EMAIL } });
    // Same row, no duplicate.
    expect(u2.id).toBe(u1.id);
    // No duplicate Account either.
    const accounts = await db.account.findMany({ where: { userId: u1.id } });
    expect(accounts).toHaveLength(1);
  });

  it('promotes an existing non-Super-Admin user to Super Admin', async () => {
    // Create a regular user first via BetterAuth.
    const { auth } = await import('@/lib/auth/auth');
    const r = await auth.api.signUpEmail({
      body: { email: TAG_EMAIL, password: VALID_PASSWORD, name: 'Pre-existing' },
    });
    const userId = r?.user?.id;
    expect(userId).toBeTruthy();
    const before = await db.user.findUniqueOrThrow({ where: { id: userId! } });
    expect(before.isSuperAdmin).toBe(false);

    const r2 = runBootstrap({
      SEED_ADMIN_EMAIL: TAG_EMAIL,
      SEED_ADMIN_PASSWORD: VALID_PASSWORD,
    });
    expect(r2.code).toBe(0);
    const after = await db.user.findUniqueOrThrow({ where: { id: userId! } });
    expect(after.isSuperAdmin).toBe(true);

    // PERMISSION_CHANGE audit row written.
    const audits = await db.auditLog.findMany({
      where: {
        entityType: 'User',
        entityId: userId!,
        action: AuditAction.PERMISSION_CHANGE,
      },
    });
    expect(audits.length).toBeGreaterThanOrEqual(1);
  });

  it('rejects a password that fails the spec policy', () => {
    const r = runBootstrap({
      SEED_ADMIN_EMAIL: TAG_EMAIL,
      SEED_ADMIN_PASSWORD: 'no-special-chars-or-digits-or-upper',
    });
    expect(r.code).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/SEED_ADMIN_PASSWORD/);
  });

  it('rejects when SEED_ADMIN_EMAIL is missing', () => {
    const r = runBootstrap({
      SEED_ADMIN_PASSWORD: VALID_PASSWORD,
    });
    expect(r.code).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/SEED_ADMIN_EMAIL/);
  });
});

async function wipe(db: PrismaClient): Promise<void> {
  const u = await db.user.findUnique({ where: { email: TAG_EMAIL } });
  if (!u) return;
  await db.session.deleteMany({ where: { userId: u.id } });
  await db.account.deleteMany({ where: { userId: u.id } });
  await db.auditLog.deleteMany({
    where: { entityType: 'User', entityId: u.id },
  });
  await db.user.delete({ where: { id: u.id } });
}
