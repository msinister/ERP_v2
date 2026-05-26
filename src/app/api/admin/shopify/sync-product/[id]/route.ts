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
//
// GET /api/admin/shopify/sync-product/:id?raw=1 → returns raw Shopify
// product data (variants + SKUs) without writing anything. Debug only.

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    await requireSuperAdmin(req);
    const { id } = await ctx.params;
    const url = new URL(req.url);
    const shopifyProductIdOverride = url.searchParams.get('shopifyProductId');
    let shopifyProductId = shopifyProductIdOverride;
    if (!shopifyProductId) {
      const link = await db.productShopifyVariant.findFirst({
        where: { productId: id, isPrimary: true },
        select: { shopifyProductId: true },
      });
      if (!link) {
        return NextResponse.json(
          { error: 'Product has no primary Shopify listing' },
          { status: 400 },
        );
      }
      shopifyProductId = link.shopifyProductId;
    }
    const secrets = await getSecrets(db);
    const client = new ShopifyClient({ storeUrl: secrets.storeUrl, accessToken: secrets.accessToken });
    const sp = await client.getProduct(shopifyProductId);
    return NextResponse.json({
      id: sp.id, title: sp.title, status: sp.status,
      variants: sp.variants.map(v => ({ id: v.id, sku: v.sku, title: v.title, option1: v.option1, option2: v.option2 })),
    });
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json({ error: e instanceof Error ? e.message : 'internal' }, { status: 400 });
  }
}

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
      select: { id: true, sku: true },
    });
    if (!product) {
      return NextResponse.json({ error: 'Product not found' }, { status: 404 });
    }
    const primaryLink = await db.productShopifyVariant.findFirst({
      where: { productId: product.id, isPrimary: true },
      select: { shopifyProductId: true },
    });
    if (!primaryLink) {
      return NextResponse.json(
        { error: 'This product has no primary Shopify listing' },
        { status: 400 },
      );
    }

    const secrets = await getSecrets(db);
    const client = new ShopifyClient({
      storeUrl: secrets.storeUrl,
      accessToken: secrets.accessToken,
    });
    const sp = await client.getProduct(primaryLink.shopifyProductId);
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
