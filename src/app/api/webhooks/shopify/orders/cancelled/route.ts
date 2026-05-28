import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import type { ShopifyOrderWebhookPayload } from '@/lib/integrations/shopify/types';
import { authenticateShopifyWebhook } from '@/lib/integrations/shopify/webhookAuth';
import { handleShopifyOrderCancellation } from '@/server/services/shopifyOrderSync';

// orders/cancelled — fired when a Shopify order is cancelled. We cancel
// the corresponding SO if it's still in a cancellable state (DRAFT /
// CONFIRMED). CLOSED orders need a manual CM workflow per spec and are
// reported as 'already_cancelled' here (the route doesn't try to
// auto-CM). Returns 200 even when the SO is missing so Shopify stops
// retrying — we intentionally don't auto-import on a cancellation
// webhook.

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
    const result = await handleShopifyOrderCancellation(
      db,
      auth.storeId,
      String(payload.id),
      payload.cancel_reason ?? null,
    );
    return NextResponse.json({ ok: true, storeId: auth.storeId, result });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 500 },
    );
  }
}
