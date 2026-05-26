import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { verifyShopifyHmac } from '@/lib/integrations/shopify/hmac';
import type { ShopifyProductWebhookPayload } from '@/lib/integrations/shopify/types';
import {
  getWebhookSecret,
  isSyncEnabled,
} from '@/server/services/shopifyConfig';
import { upsertProductFromShopify } from '@/server/services/shopifySync';

// products/create — Shopify fires when a new product is published. We
// upsert (the matching cascade handles both first-time-sync and re-fires
// after webhook replays). Idempotent: the upsert by shopifyProductId
// will detect existing rows and just update them.
//
// Verification MUST happen on the raw bytes of the body, before any
// JSON parse — see lib/integrations/shopify/hmac for why. We also
// short-circuit (200 OK with a flag) when syncing is disabled, so
// Shopify doesn't retry the same webhook forever during a config blackout.

export async function POST(req: Request) {
  const raw = await req.text();
  const signature = req.headers.get('x-shopify-hmac-sha256');

  const secret = await getWebhookSecret(db);
  if (!secret) {
    // No secret configured — accept silently so Shopify stops retrying;
    // tell ourselves what happened via the response body for log triage.
    return NextResponse.json({ ok: false, reason: 'no-secret' }, { status: 200 });
  }
  if (!verifyShopifyHmac(raw, signature, secret)) {
    return NextResponse.json({ error: 'invalid signature' }, { status: 401 });
  }
  if (!(await isSyncEnabled(db))) {
    return NextResponse.json({ ok: false, reason: 'disabled' }, { status: 200 });
  }

  let payload: ShopifyProductWebhookPayload;
  try {
    payload = JSON.parse(raw) as ShopifyProductWebhookPayload;
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }
  try {
    const results = await upsertProductFromShopify(db, {
      ...payload,
      id: String(payload.id),
    });
    return NextResponse.json({ ok: true, results });
  } catch (e) {
    // Return 500 so Shopify retries with backoff. Persistent failures
    // will eventually expire from Shopify's retry queue.
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 500 },
    );
  }
}
