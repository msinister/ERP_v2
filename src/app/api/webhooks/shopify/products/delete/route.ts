import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { verifyShopifyHmac } from '@/lib/integrations/shopify/hmac';
import type { ShopifyProductDeletePayload } from '@/lib/integrations/shopify/types';
import {
  getWebhookSecret,
  isSyncEnabled,
} from '@/server/services/shopifyConfig';
import { deactivateShopifyProduct } from '@/server/services/shopifySync';

// products/delete — Shopify fires when a product is hard-deleted (not
// just unpublished). We mark every previously-synced sibling inactive
// rather than soft-deleting — same behavior as status → draft, so a
// re-publish or restore on Shopify's end is recoverable by a normal
// upsert. Truly removing the ERP row would orphan FIFO layers / SO
// lines / etc. and is never desirable from a webhook.

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

  let payload: ShopifyProductDeletePayload;
  try {
    payload = JSON.parse(raw) as ShopifyProductDeletePayload;
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }
  try {
    const results = await deactivateShopifyProduct(db, String(payload.id));
    return NextResponse.json({ ok: true, results });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 500 },
    );
  }
}
