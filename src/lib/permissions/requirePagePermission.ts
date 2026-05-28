import 'server-only';
import { redirect } from 'next/navigation';
import { getActor } from './getActor';
import { hasPermission, type Actor } from './actor';
import type { PermissionKey } from './constants';

// =============================================================================
// requirePagePermission — page-level (Server Component) sibling of
// lib/auth/requirePermission. The API-route variant takes a `Request` and
// throws AuthError; this one uses getActor() (which reads next/headers
// internally) and routes failures through Next.js redirect() so the
// happy path stays linear inside `page.tsx`:
//
//   export default async function Page() {
//     const actor = await requirePagePermission('products.view');
//     // actor is guaranteed; render…
//   }
//
// Pass a single PermissionKey for an exact gate, or an array for
// ANY-of semantics (used for view_all | view_own pairs).
//
// Unauthenticated → /login. Authenticated-but-forbidden → /dashboard.
// Both redirects throw and short-circuit before the function returns,
// so the call site can treat the returned Actor as non-null.
// Super Admin passes every check (hasPermission short-circuits on
// isSuperAdmin).
// =============================================================================

export async function requirePagePermission(
  key: PermissionKey | PermissionKey[],
): Promise<Actor> {
  const actor = await getActor();
  if (!actor) redirect('/login');
  const keys = Array.isArray(key) ? key : [key];
  const ok = keys.some((k) => hasPermission(actor, k));
  if (!ok) redirect('/dashboard');
  return actor;
}

/**
 * Variant for pages that need ANY of N module-level permissions (e.g.
 * the /admin landing page is visible when the user has any admin.*
 * key — the individual tiles each gate themselves). Returns the loaded
 * actor on success. Same redirect semantics as requirePagePermission.
 */
export async function requirePageAnyPermissionInModule(
  module: string,
): Promise<Actor> {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (actor.isSuperAdmin) return actor;
  const prefix = `${module}.`;
  const ok = Object.entries(actor.permissions).some(
    ([k, v]) => v === true && k.startsWith(prefix),
  );
  if (!ok) redirect('/dashboard');
  return actor;
}
