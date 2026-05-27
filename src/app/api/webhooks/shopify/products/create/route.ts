import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import type { ShopifyProductWebhookPayload } from '@/lib/integrations/shopify/types';
import { authenticateShopifyWebhook } from '@/lib/integrations/shopify/webhookAuth';
import { upsertProductFromShopify } from '@/server/services/shopifySync';

// products/create — Shopify fires when a new product is published. We upsert
// (the match cascade handles both first-time-sync and re-fires after webhook
// replays). Multi-store: the X-Shopify-Shop-Domain header identifies the
// source store; HMAC is verified against THAT store's secret.

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
    // Return 500 so Shopify retries with backoff. Persistent failures
    // expire from Shopify's retry queue.
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 500 },
    );
  }
}
