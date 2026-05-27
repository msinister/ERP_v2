import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import type { ShopifyProductDeletePayload } from '@/lib/integrations/shopify/types';
import { authenticateShopifyWebhook } from '@/lib/integrations/shopify/webhookAuth';
import { deactivateShopifyProduct } from '@/server/services/shopifySync';

// products/delete — Shopify fires when a product is hard-deleted (not just
// unpublished). We remove this store's junction rows for the product and,
// if a removed row was primary in this store with no other store still
// holding it primary, mark the ERP product inactive. Never soft-deletes the
// ERP row (FIFO layers, SO lines, etc. need it).

export async function POST(req: Request) {
  const raw = await req.text();
  const auth = await authenticateShopifyWebhook(req, raw);
  if (!auth.ok) return auth.response;

  let payload: ShopifyProductDeletePayload;
  try {
    payload = JSON.parse(raw) as ShopifyProductDeletePayload;
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }
  try {
    const results = await deactivateShopifyProduct(
      db,
      auth.storeId,
      String(payload.id),
    );
    return NextResponse.json({ ok: true, storeId: auth.storeId, results });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 500 },
    );
  }
}
