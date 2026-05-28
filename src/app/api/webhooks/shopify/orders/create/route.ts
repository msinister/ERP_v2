import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import type { ShopifyOrderWebhookPayload } from '@/lib/integrations/shopify/types';
import { authenticateShopifyWebhook } from '@/lib/integrations/shopify/webhookAuth';
import { importShopifyOrder } from '@/server/services/shopifyOrderSync';

// orders/create — fired by Shopify when a new order is placed. Goes through
// the same per-store match cascade as the manual sync; ambiguous matches
// or unknown SKUs park a PendingOrderReview and ack 200 (the operator
// resolves later from /admin/pending-orders). HMAC verified against THIS
// store's secret via authenticateShopifyWebhook.

export async function POST(req: Request) {
  const raw = await req.text();
  const auth = await authenticateShopifyWebhook(req, raw, { gate: 'order' });
  if (!auth.ok) return auth.response;

  let payload: ShopifyOrderWebhookPayload;
  try {
    payload = JSON.parse(raw) as ShopifyOrderWebhookPayload;
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  try {
    const result = await importShopifyOrder(db, auth.storeId, {
      ...payload,
      id: String(payload.id),
    });
    return NextResponse.json({ ok: true, storeId: auth.storeId, result });
  } catch (e) {
    // 500 → Shopify retries. Persistent failures expire from its queue.
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 500 },
    );
  }
}
