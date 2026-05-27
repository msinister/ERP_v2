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
// (products/create, products/update, products/delete) calls
// `authenticateShopifyWebhook(req, raw)` before its own dispatch logic.
//
// Auth flow:
//   1. Read X-Shopify-Shop-Domain header → identifies the source store.
//   2. Look up the ShopifyStore by storeUrl. If missing/archived → 200 with
//      a no-store flag (so Shopify stops retrying — we know about this
//      tenant; we've decided to ignore it).
//   3. Fetch that store's webhook secret. If absent → 200 no-secret.
//   4. Verify HMAC against the raw bytes of the body — anything mismatched
//      gets 401 so Shopify reports a security alert.
//   5. If store has syncEnabled = false → 200 disabled (intentional).
//
// On success the helper returns { store }; the caller then parses the body
// and dispatches with store.id.
// =============================================================================

export type ShopifyWebhookAuthResult =
  | { ok: true; storeId: string; storeUrl: string }
  | { ok: false; response: NextResponse };

export async function authenticateShopifyWebhook(
  req: Request,
  raw: string,
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

  if (!store.syncEnabled) {
    return {
      ok: false,
      response: NR.json({ ok: false, reason: 'disabled' }, { status: 200 }),
    };
  }

  return { ok: true, storeId: store.id, storeUrl: store.storeUrl };
}
