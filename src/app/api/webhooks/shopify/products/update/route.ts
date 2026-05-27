import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import type { ShopifyProductWebhookPayload } from '@/lib/integrations/shopify/types';
import { authenticateShopifyWebhook } from '@/lib/integrations/shopify/webhookAuth';
import { upsertProductFromShopify } from '@/server/services/shopifySync';

// products/update — same handler shape as create, deliberately. The upsert
// path treats both events identically (match cascade → update or adopt).
// Keeping create/update as separate route files mirrors Shopify's topic
// naming and makes registration / unregistration map 1:1 to filesystem paths.

export async function POST(req: Request) {
  const raw = await req.text();
  const auth = await authenticateShopifyWebhook(req, raw);
  if (!auth.ok) return auth.response;

  let payload: ShopifyProductWebhookPayload;
  try {
    payload = JSON.parse(raw) as ShopifyProductWebhookPayload;
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }
  try {
    const results = await upsertProductFromShopify(db, auth.storeId, {
      ...payload,
      id: String(payload.id),
    });
    return NextResponse.json({ ok: true, storeId: auth.storeId, results });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 500 },
    );
  }
}
