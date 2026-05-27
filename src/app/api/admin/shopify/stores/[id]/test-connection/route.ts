import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireSuperAdmin } from '@/lib/auth/requireAuth';
import { authErrorResponse } from '@/lib/auth/errors';
import { getSecretsForStore } from '@/server/services/shopifyStores';
import {
  ShopifyApiError,
  ShopifyClient,
} from '@/lib/integrations/shopify/client';

// Calls Shopify's /products/count.json with this store's stored access token.
// A 200 means the token + store URL are valid; 401 means revoked/wrong
// token; 404 means wrong store URL. Returns the count on success so the
// admin sees a useful "Connected — N products" confirmation per store.

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    await requireSuperAdmin(req);
    const { id } = await ctx.params;
    const secrets = await getSecretsForStore(db, id);
    const client = new ShopifyClient({
      storeUrl: secrets.storeUrl,
      accessToken: secrets.accessToken,
    });
    const count = await client.productCount();
    return NextResponse.json({ ok: true, productCount: count });
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
