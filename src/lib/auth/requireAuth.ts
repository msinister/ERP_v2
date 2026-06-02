import { auth } from './auth';
import { AuthError } from './errors';
import type { AuthedUser } from './getCurrentUser';

// =============================================================================
// requireAuth / requireSuperAdmin — the SECURITY BOUNDARY for /api/* and
// server actions. Middleware (src/middleware.ts) only does a fast cookie
// presence check at the edge; these helpers are what actually validate
// the session: BetterAuth verifies the signed token, looks up the user,
// and confirms they're still enabled + not soft-deleted.
//
// Usage in a route handler:
//
//   export async function POST(req: Request) {
//     try {
//       const user = await requireAuth(req);
//       const ctx = auditCtxFromRequest(req, user);
//       const result = await someService(db, parsed.data, ctx);
//       return NextResponse.json(result);
//     } catch (e) {
//       const authResp = authErrorResponse(e);
//       if (authResp) return authResp;
//       return NextResponse.json({ error: ... }, { status: 400 });
//     }
//   }
//
// The throw + catch pattern (rather than returning a Response from the
// helper) keeps the happy path linear and matches how Zod parse failures
// already flow through routes.
// =============================================================================

/**
 * Validate the session cookie on `req` via BetterAuth and return the
 * authenticated user. Throws AuthError(401) if there is no session or
 * the underlying user is disabled / soft-deleted.
 *
 * SECURITY CONTRACT:
 *   - The cookie's signature is verified by auth.api.getSession; a
 *     forged or tampered cookie reaches this helper and produces a
 *     null session, which we convert to a 401.
 *   - A user disabled mid-session (set enabled=false in the DB after
 *     they logged in) is rejected here on the next request, even
 *     though their session row is still valid. getCurrentUser handles
 *     the same check; this helper mirrors it so route guards don't
 *     have to combine two helpers.
 *   - We deliberately do NOT update lastLoginAt or write a LOGIN
 *     audit row on every authenticated request — those fire only on
 *     session creation (login), not on session use.
 */
export async function requireAuth(req: Request): Promise<AuthedUser> {
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session) {
    throw new AuthError(401, 'unauthorized');
  }
  const u = session.user as AuthedUser & {
    enabled?: boolean;
    deletedAt?: Date | null;
  };
  if (u.enabled === false || u.deletedAt) {
    throw new AuthError(401, 'unauthorized');
  }
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    image: (u as { image?: string | null }).image ?? null,
    isSuperAdmin: u.isSuperAdmin === true,
    enabled: true,
  };
}

/**
 * As requireAuth, but additionally enforces isSuperAdmin=true. Throws
 * AuthError(403) for an authenticated non-super user. Used by the
 * future hard-delete + admin endpoints.
 */
export async function requireSuperAdmin(req: Request): Promise<AuthedUser> {
  const user = await requireAuth(req);
  if (!user.isSuperAdmin) {
    throw new AuthError(403, 'forbidden');
  }
  return user;
}
