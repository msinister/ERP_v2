import type { NextResponse } from 'next/server';
import { NextResponse as NR } from 'next/server';
import { db } from '@/lib/db';
import { verifyShopifyHmac } from './hmac';
import {
  getStoreByUrl,
  getWebhookSecretForStore,
} from '@/server/services/shopifyStores';

// =============================================================================
// Shared webhook authentication for multi-store Shopify routes. Each route
// (products/create, products/update, products/delete, orders/create,
// orders/updated, orders/cancelled) calls
// `authenticateShopifyWebhook(req, raw, { gate })` before its own dispatch.
//
// Auth flow:
//   1. Read X-Shopify-Shop-Domain header → identifies the source store.
//   2. Look up the ShopifyStore by storeUrl. If missing/archived → 200 with
//      a no-store flag (so Shopify stops retrying — we know about this
//      tenant; we've decided to ignore it).
//   3. Fetch that store's webhook secret. If absent → 200 no-secret.
//   4. Verify HMAC against the raw bytes of the body — anything mismatched
//      gets 401 so Shopify reports a security alert.
//   5. If the topic-specific gate flag is off (syncEnabled for product
//      webhooks, orderSyncEnabled for order webhooks) → 200 disabled.
//
// On success the helper returns { storeId, storeUrl }; the caller then
// parses the body and dispatches with store.id.
// =============================================================================

export type WebhookGate = 'product' | 'order';

export type ShopifyWebhookAuthResult =
  | { ok: true; storeId: string; storeUrl: string }
  | { ok: false; response: NextResponse };

export async function authenticateShopifyWebhook(
  req: Request,
  raw: string,
  opts: { gate: WebhookGate } = { gate: 'product' },
): Promise<ShopifyWebhookAuthResult> {
  const shopDomain = req.headers.get('x-shopify-shop-domain');
  if (!shopDomain) {
    return {
      ok: false,
      response: NR.json(
        { ok: false, reason: 'missing-shop-domain' },
        { status: 401 },
      ),
    };
  }

  const store = await getStoreByUrl(db, shopDomain.trim().toLowerCase());
  if (!store || store.deletedAt != null) {
    // Unknown / archived store — acknowledge so Shopify gives up retrying.
    return {
      ok: false,
      response: NR.json(
        { ok: false, reason: 'unknown-store' },
        { status: 200 },
      ),
    };
  }

  const secret = await getWebhookSecretForStore(db, store.id);
  if (!secret) {
    return {
      ok: false,
      response: NR.json({ ok: false, reason: 'no-secret' }, { status: 200 }),
    };
  }

  const signature = req.headers.get('x-shopify-hmac-sha256');
  if (!verifyShopifyHmac(raw, signature, secret)) {
    return {
      ok: false,
      response: NR.json({ error: 'invalid signature' }, { status: 401 }),
    };
  }

  const gateOn =
    opts.gate === 'order' ? store.orderSyncEnabled : store.syncEnabled;
  if (!gateOn) {
    return {
      ok: false,
      response: NR.json(
        { ok: false, reason: 'disabled', gate: opts.gate },
        { status: 200 },
      ),
    };
  }

  return { ok: true, storeId: store.id, storeUrl: store.storeUrl };
}
