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

// Shared shape for the customer-relation scopers below (Credit Memo, RMA,
// Payment) — each links to a customer directly, so "own" filters through
// `customer.salesRepId`. (Unlike SalesOrder, these carry no per-order rep
// override, so there's no OR branch.)
function customerRelationScope<W extends { customer?: unknown; id?: unknown }>(
  actor: Actor,
  allKey: PermissionKey,
  ownKey: PermissionKey,
): W {
  const mode = resolveScope(actor, allKey, ownKey);
  if (mode === 'all') return {} as W;
  if (mode === 'own') {
    return (
      actor.salesRepId
        ? { customer: { salesRepId: actor.salesRepId } }
        : { id: MATCH_NONE }
    ) as W;
  }
  return { id: MATCH_NONE } as W;
}

/** Prisma `where` fragment scoping a CreditMemo query for this actor. */
export function creditMemoScopeWhere(
  actor: Actor,
): Prisma.CreditMemoWhereInput {
  return customerRelationScope<Prisma.CreditMemoWhereInput>(
    actor,
    SCOPE_PAIRS.creditMemos.all,
    SCOPE_PAIRS.creditMemos.own,
  );
}

/** Prisma `where` fragment scoping an Rma query for this actor. */
export function rmaScopeWhere(actor: Actor): Prisma.RmaWhereInput {
  return customerRelationScope<Prisma.RmaWhereInput>(
    actor,
    SCOPE_PAIRS.rmas.all,
    SCOPE_PAIRS.rmas.own,
  );
}

/** Prisma `where` fragment scoping a Payment query for this actor. */
export function paymentScopeWhere(actor: Actor): Prisma.PaymentWhereInput {
  return customerRelationScope<Prisma.PaymentWhereInput>(
    actor,
    SCOPE_PAIRS.payments.all,
    SCOPE_PAIRS.payments.own,
  );
}

/**
 * The customer.salesRepId a dashboard widget should scope to for this
 * actor, gated on their sales-order view scope:
 *   - 'all' (Super Admin / sales_orders.view_all) → null (no scope)
 *   - 'none' (no SO view perm — e.g. an accountant role) → null
 *     (don't regress non-rep roles; the feature targets sales reps)
 *   - 'own' → the actor's linked salesRepId, or MATCH_NONE when they have
 *             view_own but no linked rep (sees nothing, mirroring the lists)
 * Widgets treat null as unscoped and a string as `customer.salesRepId == it`.
 */
export function dashboardScopeSalesRepId(actor: Actor): string | null {
  const mode = resolveScope(
    actor,
    SCOPE_PAIRS.salesOrders.all,
    SCOPE_PAIRS.salesOrders.own,
  );
  if (mode !== 'own') return null;
  return actor.salesRepId ?? MATCH_NONE;
}

/** Prisma `where` fragment scoping a SalesOrder query for this actor. */
export function salesOrderScopeWhere(actor: Actor): Prisma.SalesOrderWhereInput {
  const mode = resolveScope(actor, SCOPE_PAIRS.salesOrders.all, SCOPE_PAIRS.salesOrders.own);
  if (mode === 'all') return {};
  if (mode === 'own') {
    if (!actor.salesRepId) return { id: MATCH_NONE };
    // Effective rep: orders explicitly overridden to me, OR orders with
    // no override whose customer's rep is me. Mirrors salesOrderWhere's
    // rep filter so a reassigned order moves between reps' "view own".
    return {
      OR: [
        { salesRepId: actor.salesRepId },
        { salesRepId: null, customer: { salesRepId: actor.salesRepId } },
      ],
    };
  }
  return { id: MATCH_NONE };
}
