import { headers } from 'next/headers';
import { auth } from './auth';

// =============================================================================
// Server-side current-user helper.
//
// Returns the authenticated User along with the bare-minimum fields the
// rest of the app needs to make authorization decisions or populate
// audit context. Returns null when there is no session — callers must
// decide whether that's a 401 (API routes via requireAuth) or a redirect
// (server components via the dashboard layout).
//
// This helper is the ONLY supported way to read the current user from a
// server context; the underlying `auth.api.getSession` call requires the
// Next.js `headers()` cookie wrapper and shouldn't be duplicated.
// =============================================================================

export type AuthedUser = {
  id: string;
  email: string;
  name: string;
  image: string | null;
  isSuperAdmin: boolean;
  enabled: boolean;
};

export async function getCurrentUser(): Promise<AuthedUser | null> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return null;
  const u = session.user as AuthedUser & { deletedAt?: Date | null };
  // BetterAuth.api.getSession returns the user as it lives in the DB;
  // an enabled=false user can't have created the session in the first
  // place (blocked by session.create.before). The double-check here is
  // defense in depth — if the user is disabled mid-session, this null
  // forces them out on the next request.
  if (!u.enabled) return null;
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    image: (u as { image?: string | null }).image ?? null,
    isSuperAdmin: u.isSuperAdmin === true,
    enabled: u.enabled,
  };
}
