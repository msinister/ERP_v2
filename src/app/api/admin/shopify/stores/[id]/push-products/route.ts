import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireSuperAdmin } from '@/lib/auth/requireAuth';
import { auditCtxFromRequest } from '@/lib/auth/auditCtxFromRequest';
import { authErrorResponse } from '@/lib/auth/errors';
import { getStore } from '@/server/services/shopifyStores';
import { pushAllMatchingProducts } from '@/server/services/shopifySync';

// ERP → Shopify bulk product creation. Walks the store's routing-rule
// matches and creates Shopify listings for any product that doesn't already
// have one in this store. Runs INLINE per pilot scale; browser tab must
// stay open until the response returns. The run summary persists to
// ShopifyStore.lastSyncResult so it survives a closed tab.
//
// Auth: super-admin only (creates Shopify listings; commercial impact).

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
    if (!store.syncEnabled) {
      return NextResponse.json(
        { error: 'Shopify sync is disabled for this store — enable it first' },
        { status: 400 },
      );
    }

    const run = await pushAllMatchingProducts(db, id, auditCtx);
    return NextResponse.json(run);
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
