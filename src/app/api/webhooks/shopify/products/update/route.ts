import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { verifyShopifyHmac } from '@/lib/integrations/shopify/hmac';
import type { ShopifyProductWebhookPayload } from '@/lib/integrations/shopify/types';
import {
  getWebhookSecret,
  isSyncEnabled,
} from '@/server/services/shopifyConfig';
import { upsertProductFromShopify } from '@/server/services/shopifySync';

// products/update — same handler shape as create, deliberately. The
// upsert path treats both events identically (match cascade → update or
// adopt). Keeping create/update as separate route files mirrors
// Shopify's topic naming and makes registration / unregistration map
// 1:1 to filesystem paths.

export async function POST(req: Request) {
  const raw = await req.text();
  const signature = req.headers.get('x-shopify-hmac-sha256');

  const secret = await getWebhookSecret(db);
  if (!secret) {
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
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 500 },
    );
  }
}
