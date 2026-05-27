import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireSuperAdmin } from '@/lib/auth/requireAuth';
import { auditCtxFromRequest } from '@/lib/auth/auditCtxFromRequest';
import { authErrorResponse } from '@/lib/auth/errors';
import { getSecretsForStore } from '@/server/services/shopifyStores';
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
// Multi-store resolution: if no ?storeId is passed, we pick the primary
// junction row with the smallest store.sortOrder (deterministic "canonical
// store" for products listed across multiple stores). Operators can override
// with ?storeId=... to force a specific store as the source.
//
// GET /api/admin/shopify/sync-product/:id?raw=1 → returns raw Shopify
// product data (variants + SKUs) without writing anything. Debug only.

type ResolvedTarget = {
  storeId: string;
  shopifyProductId: string;
};

async function resolveTarget(
  productId: string,
  url: URL,
): Promise<ResolvedTarget | { error: string; status: number }> {
  const storeIdOverride = url.searchParams.get('storeId');
  const shopifyProductIdOverride = url.searchParams.get('shopifyProductId');

  if (storeIdOverride && shopifyProductIdOverride) {
    return { storeId: storeIdOverride, shopifyProductId: shopifyProductIdOverride };
  }

  const links = await db.productShopifyVariant.findMany({
    where: {
      productId,
      isPrimary: true,
      ...(storeIdOverride ? { shopifyStoreId: storeIdOverride } : {}),
    },
    select: {
      shopifyStoreId: true,
      shopifyProductId: true,
      store: { select: { sortOrder: true, deletedAt: true, active: true } },
    },
  });

  const usable = links
    .filter((l) => l.store.deletedAt == null && l.store.active)
    .sort((a, b) => a.store.sortOrder - b.store.sortOrder);

  const link = usable[0];
  if (!link) {
    return {
      error: storeIdOverride
        ? 'Product has no primary Shopify listing in the requested store'
        : 'Product has no primary Shopify listing',
      status: 400,
    };
  }

  return {
    storeId: link.shopifyStoreId,
    shopifyProductId: shopifyProductIdOverride ?? link.shopifyProductId,
  };
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    await requireSuperAdmin(req);
    const { id } = await ctx.params;
    const url = new URL(req.url);
    const target = await resolveTarget(id, url);
    if ('error' in target) {
      return NextResponse.json({ error: target.error }, { status: target.status });
    }
    const secrets = await getSecretsForStore(db, target.storeId);
    const client = new ShopifyClient({
      storeUrl: secrets.storeUrl,
      accessToken: secrets.accessToken,
    });
    const sp = await client.getProduct(target.shopifyProductId);
    return NextResponse.json({
      id: sp.id,
      title: sp.title,
      status: sp.status,
      storeId: target.storeId,
      variants: sp.variants.map((v) => ({
        id: v.id,
        sku: v.sku,
        title: v.title,
        option1: v.option1,
        option2: v.option2,
      })),
    });
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
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

    const target = await resolveTarget(id, new URL(req.url));
    if ('error' in target) {
      return NextResponse.json({ error: target.error }, { status: target.status });
    }

    const secrets = await getSecretsForStore(db, target.storeId);
    const client = new ShopifyClient({
      storeUrl: secrets.storeUrl,
      accessToken: secrets.accessToken,
    });
    const sp = await client.getProduct(target.shopifyProductId);
    const results = await upsertProductFromShopify(
      db,
      target.storeId,
      sp,
      auditCtx,
    );
    return NextResponse.json({ ok: true, storeId: target.storeId, results });
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
