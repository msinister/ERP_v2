import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { nextCookies } from 'better-auth/next-js';
import { AuditAction } from '@/generated/tenant';
import { db } from '@/lib/db';
import { audit } from '@/lib/audit/audit';

// =============================================================================
// BetterAuth configuration — pilot scope.
//
// Email + password only. No 2FA, no OAuth, no email verification, no
// password reset email (Mailgun integration deferred). Sign-up via the
// public endpoint is disabled — users are created by the provisioning
// script and (post-pilot) by Super Admins.
//
// LOGIN / LOGOUT audit rows are emitted via session.create.after and
// session.delete.after database hooks. The audit ledger lives in the
// tenant DB alongside the auth tables, so a single transaction is not
// strictly required — the hook fires after the session row commits and
// writing a separate audit row is correct semantics ("session was
// created" → log it).
//
// Password policy: BetterAuth enforces minimum length only. The spec's
// upper/lower/digit/special-char policy is enforced at the API/server-
// action layer when admins create or change passwords (slice B builds
// the helper). Putting the policy in BetterAuth's `password.hash`
// callback would tie it to a single internal call site; keeping it at
// the boundary makes the rule visible and testable independently.
// =============================================================================

const PILOT_PASSWORD_MIN_LENGTH = 8;

function readBaseUrl(): string {
  const url = process.env.BETTER_AUTH_URL ?? process.env.NEXT_PUBLIC_BETTER_AUTH_URL;
  if (!url) {
    throw new Error(
      'BETTER_AUTH_URL is not set; required for cookie + redirect URL construction',
    );
  }
  return url;
}

function readSecret(): string {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) {
    throw new Error(
      'BETTER_AUTH_SECRET is not set; required for session token signing',
    );
  }
  if (secret.length < 32) {
    throw new Error(
      'BETTER_AUTH_SECRET must be at least 32 chars; generate via `openssl rand -hex 32`',
    );
  }
  return secret;
}

export const auth = betterAuth({
  appName: 'ERP',
  baseURL: readBaseUrl(),
  secret: readSecret(),
  database: prismaAdapter(db, { provider: 'postgresql' }),
  emailAndPassword: {
    enabled: true,
    // disableSignUp is intentionally false: we still need to call
    // auth.api.signUpEmail() from server contexts (the bootstrap
    // script + future Super-Admin "create user" flow), and BetterAuth
    // applies this flag to both public AND internal callers.
    //
    // The PUBLIC sign-up endpoint is gated separately at the edge —
    // src/middleware.ts denies /api/auth/sign-up/* unless the request
    // already carries a session for a user with isSuperAdmin=true.
    // That keeps the public HTTP attack surface closed while leaving
    // server-side helpers usable.
    disableSignUp: false,
    requireEmailVerification: false,
    minPasswordLength: PILOT_PASSWORD_MIN_LENGTH,
    autoSignIn: false,
  },
  user: {
    // ERP-specific User columns — must match the Prisma model 1:1 so the
    // Prisma adapter reads/writes them. `isSuperAdmin`, `enabled`, and
    // `forcePasswordReset` default at the DB level (see schema) but are
    // declared here so BetterAuth knows the columns exist on read.
    additionalFields: {
      phone: { type: 'string', required: false, input: false },
      title: { type: 'string', required: false, input: false },
      department: { type: 'string', required: false, input: false },
      warehouseId: { type: 'string', required: false, input: false },
      salesRepId: { type: 'string', required: false, input: false },
      isSuperAdmin: { type: 'boolean', required: false, input: false, defaultValue: false },
      enabled: { type: 'boolean', required: false, input: false, defaultValue: true },
      forcePasswordReset: {
        type: 'boolean',
        required: false,
        input: false,
        defaultValue: false,
      },
      lastLoginAt: { type: 'date', required: false, input: false },
      deletedAt: { type: 'date', required: false, input: false },
    },
  },
  databaseHooks: {
    session: {
      create: {
        // Block login for disabled or soft-deleted users. We do this in
        // session.create.before (rather than relying on BetterAuth's
        // sign-in path) so any future code path that creates a session
        // (admin impersonation, OAuth, etc.) is gated by the same rule.
        before: async (session) => {
          const user = await db.user.findUnique({ where: { id: session.userId } });
          if (!user) return false;
          if (!user.enabled || user.deletedAt) return false;
          return;
        },
        // Audit + lastLoginAt update on successful login. Errors here
        // must NOT prevent the session from existing — BetterAuth has
        // already written the row; we're just decorating it. Wrap in a
        // try/catch so a transient AuditLog write failure doesn't lock
        // the user out.
        after: async (session) => {
          try {
            await db.user.update({
              where: { id: session.userId },
              data: { lastLoginAt: new Date() },
            });
            await audit(db, {
              action: AuditAction.LOGIN,
              entityType: 'User',
              entityId: session.userId,
              ctx: {
                userId: session.userId,
                ipAddress: session.ipAddress ?? null,
              },
            });
          } catch {
            // Intentionally swallowed; do not propagate to the response.
          }
        },
      },
      delete: {
        // Logout (session deletion). Explicit user-initiated logouts and
        // cascade-deletes both fire this; that's fine — both are events
        // worth recording. Audit failure must not break the logout.
        after: async (session) => {
          try {
            await audit(db, {
              action: AuditAction.LOGOUT,
              entityType: 'User',
              entityId: session.userId,
              ctx: {
                userId: session.userId,
                ipAddress: session.ipAddress ?? null,
              },
            });
          } catch {
            // Intentional swallow — see note on login hook.
          }
        },
      },
    },
  },
  // nextCookies() must be the LAST plugin per BetterAuth docs — it
  // installs the response hook that writes Set-Cookie headers in the
  // Next.js handler.
  plugins: [nextCookies()],
});

export type Auth = typeof auth;
