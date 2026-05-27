import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireSuperAdmin } from '@/lib/auth/requireAuth';
import { auditCtxFromRequest } from '@/lib/auth/auditCtxFromRequest';
import { authErrorResponse } from '@/lib/auth/errors';
import { getStore } from '@/server/services/shopifyStores';
import { runFullSync } from '@/server/services/shopifySync';

// Runs INLINE per pilot scale (~40 SKUs at Naked Kratom). The browser tab
// must stay open until the response returns; if it closes, sync still
// completes server-side and the result summary is persisted to the
// ShopifyStore row (lastSyncResult / lastProductSyncAt). Upgrade path:
// move runFullSync into an Inngest job so the route returns immediately
// and the UI polls.
//
// Auth: super-admin only (sync touches every product row).

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

    const run = await runFullSync(db, id, auditCtx);
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
