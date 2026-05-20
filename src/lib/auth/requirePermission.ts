import { db } from '@/lib/db';
import { AuthError } from './errors';
import { requireAuth } from './requireAuth';
import { loadActor, hasPermission, type Actor } from '@/lib/permissions/actor';
import type { PermissionKey } from '@/lib/permissions/constants';

// =============================================================================
// requirePermission — the permission-aware security boundary for /api/*
// route handlers. Layers on top of requireAuth:
//
//   requireAuth        → 401 if no valid session
//   loadActor          → resolve role permissions + salesRepId
//   hasPermission(key) → 403 if the actor lacks the permission
//
// Returns the resolved Actor so the handler can reuse it for scope
// filtering without a second DB round-trip. Super Admin passes every
// check (hasPermission short-circuits on isSuperAdmin).
//
// Usage:
//   const actor = await requirePermission(req, 'customers.edit');
//   const rows = await listCustomers(db, { scope: customerScopeWhere(actor) });
// =============================================================================

export async function requirePermission(
  req: Request,
  key: PermissionKey,
): Promise<Actor> {
  const user = await requireAuth(req);
  const actor = await loadActor(db, user.id);
  // requireAuth already confirmed the user is enabled + not soft-deleted;
  // a null here would be a race (deleted mid-request) → treat as 401.
  if (!actor) throw new AuthError(401, 'unauthorized');
  if (!hasPermission(actor, key)) throw new AuthError(403, 'forbidden');
  return actor;
}
