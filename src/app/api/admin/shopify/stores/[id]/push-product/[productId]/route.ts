import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireSuperAdmin } from '@/lib/auth/requireAuth';
import { authErrorResponse } from '@/lib/auth/errors';
import { getStore } from '@/server/services/shopifyStores';
import { pushProductToShopify } from '@/server/services/shopifySync';
import { ShopifyApiError } from '@/lib/integrations/shopify/client';

// Single-product version of /push-products. Operator surface: per-row
// "Create on Shopify" action on the product detail page (UI ships
// separately). Returns the per-product result envelope so the caller can
// render a precise toast — created / skipped + reason / error + reason.
//
// Auth: super-admin only — same gate as the bulk variant.

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string; productId: string }> },
) {
  try {
    await requireSuperAdmin(req);
    const { id, productId } = await ctx.params;

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

    const result = await pushProductToShopify(db, id, productId);
    return NextResponse.json({ ok: result.outcome !== 'error', result });
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    if (e instanceof ShopifyApiError) {
      return NextResponse.json(
        { ok: false, status: e.status, error: e.message },
        { status: 400 },
      );
    }
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
