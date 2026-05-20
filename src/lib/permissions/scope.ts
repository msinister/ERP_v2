import type { Prisma } from '@/generated/tenant';
import { hasPermission, type Actor } from './actor';
import { SCOPE_PAIRS, type PermissionKey } from './constants';

// =============================================================================
// Data scoping — translates an Actor's view-all / view-own permissions into
// Prisma `where` fragments that callers AND into their queries.
//
// Decision logic lives here once (resolveScope); each entity contributes a
// thin mapping from mode → its own schema shape (Customer keys on
// salesRepId directly; SalesOrder reaches it via the customer relation).
//
//   all  → {} (no restriction)
//   own  → records tied to the actor's linked sales rep
//   none → an impossible-match clause (list returns [], get returns null)
// =============================================================================

export type ScopeMode = 'all' | 'own' | 'none';

/**
 * Resolve the scope mode for an all/own permission pair. Super Admin and
 * holders of the "view all" key get 'all'; holders of "view own" get
 * 'own'; everyone else 'none'.
 */
export function resolveScope(
  actor: Actor,
  allKey: PermissionKey,
  ownKey: PermissionKey,
): ScopeMode {
  if (actor.isSuperAdmin || hasPermission(actor, allKey)) return 'all';
  if (hasPermission(actor, ownKey)) return 'own';
  return 'none';
}

// Sentinel id that no cuid will ever equal — yields a where clause matching
// zero rows. Used for 'none', and for 'own' when the user isn't linked to a
// sales rep (they own nothing, so they see nothing).
const MATCH_NONE = '__no_access__';

/** Prisma `where` fragment scoping a Customer query for this actor. */
export function customerScopeWhere(actor: Actor): Prisma.CustomerWhereInput {
  const mode = resolveScope(actor, SCOPE_PAIRS.customers.all, SCOPE_PAIRS.customers.own);
  if (mode === 'all') return {};
  if (mode === 'own') {
    return actor.salesRepId
      ? { salesRepId: actor.salesRepId }
      : { id: MATCH_NONE };
  }
  return { id: MATCH_NONE };
}

/** Prisma `where` fragment scoping a SalesOrder query for this actor. */
export function salesOrderScopeWhere(actor: Actor): Prisma.SalesOrderWhereInput {
  const mode = resolveScope(actor, SCOPE_PAIRS.salesOrders.all, SCOPE_PAIRS.salesOrders.own);
  if (mode === 'all') return {};
  if (mode === 'own') {
    return actor.salesRepId
      ? { customer: { salesRepId: actor.salesRepId } }
      : { id: MATCH_NONE };
  }
  return { id: MATCH_NONE };
}
