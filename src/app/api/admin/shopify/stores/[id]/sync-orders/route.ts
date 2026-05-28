import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireSuperAdmin } from '@/lib/auth/requireAuth';
import { auditCtxFromRequest } from '@/lib/auth/auditCtxFromRequest';
import { authErrorResponse } from '@/lib/auth/errors';
import { getStore } from '@/server/services/shopifyStores';
import { syncOrdersForStore } from '@/server/services/shopifyOrderSync';

// Manual order sync for one store. Pulls every Shopify order updated
// since lastOrderSyncAt (or 30 days back on first run), runs the
// per-order import cascade, and writes the result summary onto the
// store row. Runs inline; the response returns after the full batch
// finishes. Pilot scale (small order volume) makes inline fine; same
// upgrade path as the product sync if it ever needs to background.
//
// Auth: super-admin only — order import touches Customer + SO + AR.

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireSuperAdmin(req);
    const auditCtx = auditCtxFromRequest(req, user);
    const { id } = await ctx.params;

    const store = await getStore(db, id);
    if (!store) {
      return NextResponse.json({ error: 'store not found' }, { status: 404 });
    }
    if (!store.orderSyncEnabled) {
      return NextResponse.json(
        { error: 'Order sync is disabled for this store — enable it first' },
        { status: 400 },
      );
    }

    const missing: string[] = [];
    if (!store.defaultWarehouseId) missing.push('defaultWarehouseId');
    if (!store.defaultSalesRepId) missing.push('defaultSalesRepId');
    if (!store.defaultPaymentTermId) missing.push('defaultPaymentTermId');
    if (!store.defaultCustomerType) missing.push('defaultCustomerType');
    if (missing.length > 0) {
      return NextResponse.json(
        {
          error: `Store is missing order-sync defaults: ${missing.join(', ')}. Set them on the connection card before running order sync.`,
        },
        { status: 400 },
      );
    }

    const run = await syncOrdersForStore(db, id, auditCtx);
    return NextResponse.json({ ok: true, run });
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
