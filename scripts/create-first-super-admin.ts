/**
 * Idempotently create the first Super Admin user for a freshly
 * provisioned tenant instance.
 *
 * Reads:
 *   SEED_ADMIN_EMAIL    — required
 *   SEED_ADMIN_PASSWORD — required (must satisfy the spec password
 *                         policy: >= 8 chars, upper + lower + digit
 *                         + special)
 *   SEED_ADMIN_NAME     — optional (defaults to "Super Admin")
 *
 * Behavior:
 *   - If a User row already exists for the given email, the script
 *     ensures isSuperAdmin=true + enabled=true and exits 0. It does
 *     NOT overwrite the password.
 *   - Otherwise, creates the User + a credential Account with the
 *     password hashed via BetterAuth's internal hasher.
 *   - Writes a CREATE AuditLog row attributed to the new user
 *     (self-attribution is intentional — there's no other actor at
 *     bootstrap time).
 *
 * Usage:
 *   SEED_ADMIN_EMAIL=admin@nakedkratom.com \
 *     SEED_ADMIN_PASSWORD='ChangeMe!2026' \
 *     npx tsx --env-file=.env scripts/create-first-super-admin.ts
 */
import { auth } from '@/lib/auth/auth';
import { AuditAction } from '@/generated/tenant';
import { db } from '@/lib/db';
import { audit } from '@/lib/audit/audit';

const PASSWORD_POLICY_RE = {
  minLength: /.{8,}/,
  upper: /[A-Z]/,
  lower: /[a-z]/,
  digit: /\d/,
  special: /[^A-Za-z0-9]/,
};

function validatePasswordPolicy(password: string): string | null {
  if (!PASSWORD_POLICY_RE.minLength.test(password)) return 'must be at least 8 characters';
  if (!PASSWORD_POLICY_RE.upper.test(password)) return 'must include an uppercase letter';
  if (!PASSWORD_POLICY_RE.lower.test(password)) return 'must include a lowercase letter';
  if (!PASSWORD_POLICY_RE.digit.test(password)) return 'must include a digit';
  if (!PASSWORD_POLICY_RE.special.test(password)) return 'must include a special character';
  return null;
}

async function main(): Promise<void> {
  const email = process.env.SEED_ADMIN_EMAIL;
  const password = process.env.SEED_ADMIN_PASSWORD;
  const name = process.env.SEED_ADMIN_NAME ?? 'Super Admin';

  if (!email) throw new Error('SEED_ADMIN_EMAIL is required');
  if (!password) throw new Error('SEED_ADMIN_PASSWORD is required');

  const policyFailure = validatePasswordPolicy(password);
  if (policyFailure) {
    throw new Error(`SEED_ADMIN_PASSWORD ${policyFailure}`);
  }

  const existing = await db.user.findUnique({ where: { email } });
  if (existing) {
    if (existing.isSuperAdmin && existing.enabled && !existing.deletedAt) {
      console.log(`User ${email} already exists as Super Admin. No changes.`);
      return;
    }
    const updated = await db.user.update({
      where: { id: existing.id },
      data: {
        isSuperAdmin: true,
        enabled: true,
        deletedAt: null,
      },
    });
    await audit(db, {
      action: AuditAction.PERMISSION_CHANGE,
      entityType: 'User',
      entityId: updated.id,
      before: {
        isSuperAdmin: existing.isSuperAdmin,
        enabled: existing.enabled,
        deletedAt: existing.deletedAt,
      },
      after: {
        isSuperAdmin: true,
        enabled: true,
        deletedAt: null,
      },
      ctx: { userId: updated.id, reason: 'first-super-admin bootstrap' },
    });
    console.log(`User ${email} promoted to Super Admin.`);
    return;
  }

  // BetterAuth's signUpEmail endpoint is the canonical way to create a
  // credential account because it owns password hashing. We bypass
  // `disableSignUp: true` by calling the endpoint directly via auth.api
  // (the disable flag only blocks the public HTTP route, not internal
  // server callers). After creation, we flip isSuperAdmin to true on
  // the User row.
  const result = await auth.api.signUpEmail({
    body: { email, password, name },
  });

  // signUpEmail returns either { user, token } or throws on conflict.
  const userId = result?.user?.id;
  if (!userId) {
    throw new Error('signUpEmail did not return a user id');
  }

  await db.user.update({
    where: { id: userId },
    data: { isSuperAdmin: true },
  });

  await audit(db, {
    action: AuditAction.CREATE,
    entityType: 'User',
    entityId: userId,
    after: {
      email,
      name,
      isSuperAdmin: true,
      enabled: true,
    },
    ctx: { userId, reason: 'first-super-admin bootstrap' },
  });

  console.log(`Super Admin created: ${email} (${userId}).`);
}

main()
  .then(() => db.$disconnect())
  .catch(async (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    await db.$disconnect();
    process.exit(1);
  });
