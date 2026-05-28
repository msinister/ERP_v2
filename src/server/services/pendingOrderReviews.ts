import { AuditAction, Prisma } from '@/generated/tenant';
import type {
  PendingOrderReview,
  PrismaClient,
} from '@/generated/tenant';
import { audit, type AuditContext } from '@/lib/audit/audit';
import type {
  ShopifyAddress,
  ShopifyOrder,
} from '@/lib/integrations/shopify/types';
import {
  createCustomerFromShopifyOrder,
  StoreNotConfiguredForOrderSyncError,
} from '@/server/services/shopifyCustomerMatch';
import { importShopifyOrder } from '@/server/services/shopifyOrderSync';

// =============================================================================
// Pending-order-review resolution service.
//
// Three operator actions:
//   - use_existing: bind the queued Shopify order to an existing Customer
//     (the matched one or any selected by the operator), then re-run the
//     importer against that customer.
//   - create_new: ignore any existing customer, force creation of a new
//     ERP customer from the Shopify payload (store defaults supply the
//     missing fields), then import.
//   - dismiss: park the review as DISMISSED without importing anything.
//
// Each action is idempotent — re-clicking after a partial failure picks
// up where the previous attempt left off. Resolved rows store the
// resulting SalesOrder.id (or null on dismiss) so the review history
// has a clear audit trail.
// =============================================================================

export type ResolveReviewAction =
  | { action: 'use_existing'; customerId: string; addAsNewAddress?: boolean }
  | { action: 'create_new' }
  | { action: 'dismiss'; reason?: string };

export type ResolveReviewResult =
  | {
      outcome: 'imported';
      salesOrderId: string;
      reviewStatus: 'RESOLVED_EXISTING' | 'RESOLVED_NEW';
    }
  | {
      outcome: 'dismissed';
    }
  | {
      outcome: 'pending_review';
      pendingReviewId: string;
      reason: string;
    }
  | {
      outcome: 'error';
      message: string;
    };

export async function resolvePendingOrderReview(
  db: PrismaClient,
  reviewId: string,
  input: ResolveReviewAction,
  ctx?: AuditContext,
): Promise<ResolveReviewResult> {
  const review = await db.pendingOrderReview.findUnique({ where: { id: reviewId } });
  if (!review) return { outcome: 'error', message: `PendingOrderReview not found: ${reviewId}` };
  if (review.status !== 'PENDING') {
    return {
      outcome: 'error',
      message: `Review ${reviewId} already resolved (status=${review.status})`,
    };
  }

  if (input.action === 'dismiss') {
    await markResolved(db, review, {
      status: 'DISMISSED',
      salesOrderId: null,
      notes: input.reason ?? null,
      ctx,
    });
    return { outcome: 'dismissed' };
  }

  const order = review.shopifyOrderData as unknown as ShopifyOrder;

  if (input.action === 'use_existing') {
    // Link the Shopify customer id onto the chosen ERP customer (so
    // future orders short-circuit on the shopify-id branch in the
    // matching service). If the operator opted to add Shopify's
    // ship-to as a new address, do that too.
    if (review.shopifyCustomerId) {
      await db.customer.update({
        where: { id: input.customerId },
        data: { shopifyCustomerId: review.shopifyCustomerId },
      });
    }
    if (input.addAsNewAddress && order.shipping_address) {
      await addShippingAddress(db, input.customerId, order.shipping_address);
    }
    const r = await importShopifyOrder(db, review.shopifyStoreId, order, ctx);
    return finalizeAfterImport(db, review, r, 'RESOLVED_EXISTING', ctx);
  }

  // create_new
  const store = await db.shopifyStore.findUnique({ where: { id: review.shopifyStoreId } });
  if (!store) {
    return { outcome: 'error', message: `Store ${review.shopifyStoreId} not found` };
  }
  try {
    // Force-create a fresh customer regardless of email collisions —
    // the operator's already seen the side-by-side compare and chose
    // "create new". We side-step matchOrCreate by calling the create
    // helper directly. Email-uniqueness isn't enforced on Customer; the
    // unique constraint is on (citext) name and createCustomerFromShopify
    // Order's uniqueDisplayName helper handles that.
    await createCustomerFromShopifyOrder(db, order, store, ctx);
  } catch (e) {
    if (e instanceof StoreNotConfiguredForOrderSyncError) {
      return { outcome: 'error', message: e.message };
    }
    throw e;
  }
  // The new customer now exists with shopifyCustomerId pre-set, so the
  // import path's id-match branch finds them immediately.
  const r = await importShopifyOrder(db, review.shopifyStoreId, order, ctx);
  return finalizeAfterImport(db, review, r, 'RESOLVED_NEW', ctx);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function finalizeAfterImport(
  db: PrismaClient,
  review: PendingOrderReview,
  importResult: Awaited<ReturnType<typeof importShopifyOrder>>,
  successStatus: 'RESOLVED_EXISTING' | 'RESOLVED_NEW',
  ctx: AuditContext | undefined,
): Promise<ResolveReviewResult> {
  if (importResult.outcome === 'imported') {
    await markResolved(db, review, {
      status: successStatus,
      salesOrderId: importResult.salesOrderId,
      notes: null,
      ctx,
    });
    return {
      outcome: 'imported',
      salesOrderId: importResult.salesOrderId,
      reviewStatus: successStatus,
    };
  }
  if (importResult.outcome === 'skipped' && importResult.salesOrderId) {
    // The order was already imported by a concurrent path. Resolve
    // anyway so the review row gets out of the queue.
    await markResolved(db, review, {
      status: successStatus,
      salesOrderId: importResult.salesOrderId,
      notes: 'order was already imported when review was resolved',
      ctx,
    });
    return {
      outcome: 'imported',
      salesOrderId: importResult.salesOrderId,
      reviewStatus: successStatus,
    };
  }
  if (importResult.outcome === 'pending_review') {
    return {
      outcome: 'pending_review',
      pendingReviewId: importResult.pendingReviewId,
      reason: importResult.reason,
    };
  }
  if (importResult.outcome === 'error') {
    return { outcome: 'error', message: importResult.message };
  }
  return { outcome: 'error', message: `Unexpected import outcome: ${JSON.stringify(importResult)}` };
}

async function markResolved(
  db: PrismaClient,
  review: PendingOrderReview,
  args: {
    status: 'RESOLVED_EXISTING' | 'RESOLVED_NEW' | 'DISMISSED';
    salesOrderId: string | null;
    notes: string | null;
    ctx?: AuditContext;
  },
): Promise<void> {
  await db.$transaction(async (tx) => {
    const after = await tx.pendingOrderReview.update({
      where: { id: review.id },
      data: {
        status: args.status,
        resolvedAt: new Date(),
        resolvedById: args.ctx?.userId ?? null,
        resolvedSalesOrderId: args.salesOrderId,
        notes: args.notes ?? review.notes,
      },
    });
    await audit(tx, {
      action: AuditAction.STATUS_CHANGE,
      entityType: 'PendingOrderReview',
      entityId: review.id,
      before: review,
      after,
      ctx: args.ctx,
    });
  });
}

async function addShippingAddress(
  db: PrismaClient,
  customerId: string,
  a: ShopifyAddress,
): Promise<void> {
  // Inserted as a non-default ship-to so the customer's existing
  // default is preserved. No service-level invariant work needed.
  await db.customerAddress.create({
    data: {
      customerId,
      kind: 'SHIPPING',
      isDefault: false,
      label: `Shopify ship-to ${new Date().toISOString().slice(0, 10)}`,
      line1: (a.address1 ?? '').trim() || '(no street)',
      line2: a.address2?.trim() || null,
      city: (a.city ?? '').trim() || '(no city)',
      region: (a.province_code ?? a.province ?? '').trim() || 'XX',
      postalCode: (a.zip ?? '').trim() || '00000',
      country: (a.country_code ?? '').trim().toUpperCase().slice(0, 2) || 'US',
      attention:
        [a.first_name, a.last_name].filter(Boolean).join(' ').trim() || null,
      phone: a.phone?.trim() || null,
    },
  });
}

// ---------------------------------------------------------------------------
// Listing helpers used by the admin UI + dashboard widget
// ---------------------------------------------------------------------------

export type PendingReviewListItem = PendingOrderReview & {
  store: { id: string; name: string };
  matchedCustomer: {
    id: string;
    name: string;
    primaryEmail: string | null;
    primaryPhone: string | null;
    shopifyCustomerId: string | null;
  } | null;
};

export async function listPendingReviews(
  db: PrismaClient,
  opts?: {
    status?: 'PENDING' | 'RESOLVED_EXISTING' | 'RESOLVED_NEW' | 'DISMISSED';
    storeId?: string;
    limit?: number;
  },
): Promise<PendingReviewListItem[]> {
  return db.pendingOrderReview.findMany({
    where: {
      ...(opts?.status === undefined ? {} : { status: opts.status }),
      ...(opts?.storeId ? { shopifyStoreId: opts.storeId } : {}),
    },
    include: {
      store: { select: { id: true, name: true } },
      matchedCustomer: {
        select: {
          id: true,
          name: true,
          primaryEmail: true,
          primaryPhone: true,
          shopifyCustomerId: true,
        },
      },
    },
    orderBy: { createdAt: 'desc' },
    take: opts?.limit ?? 100,
  });
}

export async function pendingReviewCount(db: PrismaClient): Promise<number> {
  return db.pendingOrderReview.count({ where: { status: 'PENDING' } });
}

export type MatchedCustomerEnrichment = {
  orderCount: number;
  lifetimeRevenue: string;
  openArBalance: string;
  addressCount: number;
};

export type ReviewWithEnrichment = PendingReviewListItem & {
  matchedCustomerEnrichment: MatchedCustomerEnrichment | null;
};

// Detail-page helper. Fetches the review plus enrichment fields about
// the candidate ERP customer (order count, lifetime revenue, open AR,
// address count) so the side-by-side compare can render without further
// round-trips.
export async function getReviewWithEnrichment(
  db: PrismaClient,
  id: string,
): Promise<ReviewWithEnrichment | null> {
  const review = await db.pendingOrderReview.findUnique({
    where: { id },
    include: {
      store: { select: { id: true, name: true } },
      matchedCustomer: {
        select: {
          id: true,
          name: true,
          primaryEmail: true,
          primaryPhone: true,
          shopifyCustomerId: true,
        },
      },
    },
  });
  if (!review) return null;

  let enrichment: MatchedCustomerEnrichment | null = null;
  if (review.matchedCustomerId) {
    const [orderCount, revenueAgg, openArAgg, addressCount] = await Promise.all([
      db.salesOrder.count({
        where: { customerId: review.matchedCustomerId, deletedAt: null },
      }),
      db.invoice.aggregate({
        _sum: { total: true },
        where: { customerId: review.matchedCustomerId, deletedAt: null },
      }),
      db.invoice.aggregate({
        _sum: { total: true, amountPaid: true, amountCredited: true },
        where: {
          customerId: review.matchedCustomerId,
          deletedAt: null,
          status: { in: ['OPEN', 'PARTIAL'] },
        },
      }),
      db.customerAddress.count({
        where: { customerId: review.matchedCustomerId, deletedAt: null },
      }),
    ]);
    const ar = new Prisma.Decimal(openArAgg._sum.total ?? 0)
      .minus(openArAgg._sum.amountPaid ?? 0)
      .minus(openArAgg._sum.amountCredited ?? 0);
    enrichment = {
      orderCount,
      lifetimeRevenue: (revenueAgg._sum.total ?? new Prisma.Decimal(0)).toString(),
      openArBalance: ar.toString(),
      addressCount,
    };
  }

  return { ...review, matchedCustomerEnrichment: enrichment };
}
