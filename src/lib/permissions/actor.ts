import type { PrismaClient } from '@/generated/tenant';
import {
  sanitizePermissionMap,
  type PermissionKey,
  type PermissionMap,
} from './constants';

// =============================================================================
// Actor — the authorization-relevant projection of a User, loaded once per
// request and threaded into permission checks + scope filters.
//
// `permissions` is the sanitized grant from the user's Role (empty when the
// user has no role or a soft-deleted role). `isSuperAdmin` short-circuits
// every check. `salesRepId` is the link the "view own" scope resolves
// against (User.salesRepId → Customer.salesRepId).
//
// This module is intentionally free of next/headers + the db singleton so
// it stays unit-testable. `loadActor` takes a PrismaClient/tx; the
// server-component entry point lives in getActor.ts.
// =============================================================================

export type Actor = {
  id: string;
  isSuperAdmin: boolean;
  salesRepId: string | null;
  permissions: PermissionMap;
};

type ActorDb = Pick<PrismaClient, 'user'>;

/**
 * Load the Actor for a user id in a single query (user + role.permissions).
 * Returns null when the user is missing, soft-deleted, or disabled — the
 * caller converts that to a 401 / redirect. A soft-deleted role is treated
 * as "no permissions" rather than an error so revoking a role doesn't lock
 * a session into a hard failure.
 */
export async function loadActor(
  db: ActorDb,
  userId: string,
): Promise<Actor | null> {
  const u = await db.user.findFirst({
    where: { id: userId, deletedAt: null },
    select: {
      id: true,
      isSuperAdmin: true,
      enabled: true,
      salesRepId: true,
      role: { select: { permissions: true, deletedAt: true } },
    },
  });
  if (!u || !u.enabled) return null;
  const permissions =
    u.role && !u.role.deletedAt
      ? sanitizePermissionMap(u.role.permissions)
      : {};
  return {
    id: u.id,
    isSuperAdmin: u.isSuperAdmin,
    salesRepId: u.salesRepId,
    permissions,
  };
}

/** True when the actor holds `key`. Super Admin holds everything. */
export function hasPermission(actor: Actor, key: PermissionKey): boolean {
  if (actor.isSuperAdmin) return true;
  return actor.permissions[key] === true;
}
