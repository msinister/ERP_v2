import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireSuperAdmin } from '@/lib/auth/requireAuth';
import { auditCtxFromRequest } from '@/lib/auth/auditCtxFromRequest';
import { authErrorResponse } from '@/lib/auth/errors';
import { getSecrets } from '@/server/services/shopifyConfig';
import { upsertProductFromShopify } from '@/server/services/shopifySync';
import {
  ShopifyApiError,
  ShopifyClient,
} from '@/lib/integrations/shopify/client';

// Re-pull ONE product from Shopify by ERP product id and re-run the
// upsert. Used by the "Sync this product" button on the product detail
// page. The :id in the route is the ERP product id (not the Shopify
// product id) so the URL stays consistent with the rest of /products.

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireSuperAdmin(req);
    const auditCtx = auditCtxFromRequest(req, user);
    const { id } = await ctx.params;

    const product = await db.product.findUnique({
      where: { id },
      select: { id: true, sku: true, shopifyProductId: true },
    });
    if (!product) {
      return NextResponse.json({ error: 'Product not found' }, { status: 404 });
    }
    if (!product.shopifyProductId) {
      return NextResponse.json(
        { error: 'This product is not linked to a Shopify product' },
        { status: 400 },
      );
    }

    const secrets = await getSecrets(db);
    const client = new ShopifyClient({
      storeUrl: secrets.storeUrl,
      accessToken: secrets.accessToken,
    });
    const sp = await client.getProduct(product.shopifyProductId);
    const results = await upsertProductFromShopify(db, sp, auditCtx);
    return NextResponse.json({ ok: true, results });
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
