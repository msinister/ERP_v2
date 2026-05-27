import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireSuperAdmin } from '@/lib/auth/requireAuth';
import { authErrorResponse } from '@/lib/auth/errors';
import {
  getSecretsForStore,
  recordWebhookSubscriptions,
} from '@/server/services/shopifyStores';
import {
  ShopifyApiError,
  ShopifyClient,
} from '@/lib/integrations/shopify/client';

// Register the three product webhooks (create / update / delete) on this
// store, pointed at our shared /api/webhooks/shopify/products/... endpoints.
// Idempotent: already-registered topics with a matching address are detected
// via listWebhooks and skipped.
//
// The webhook URL is the same for every store — handlers look up the store
// by X-Shopify-Shop-Domain header. SHOPIFY_PUBLIC_BASE_URL env var sets the
// public origin; defaults to request origin (dev with cloudflared / ngrok).

const TOPICS = [
  'products/create',
  'products/update',
  'products/delete',
] as const;

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    await requireSuperAdmin(req);
    const { id } = await ctx.params;
    const secrets = await getSecretsForStore(db, id);
    const client = new ShopifyClient({
      storeUrl: secrets.storeUrl,
      accessToken: secrets.accessToken,
    });

    let bodyBaseUrl: string | undefined;
    try {
      const body = await req.json();
      if (typeof body?.baseUrl === 'string') {
        bodyBaseUrl = body.baseUrl.replace(/\/+$/, '');
      }
    } catch {
      /* no body — fine */
    }

    const base =
      bodyBaseUrl ||
      process.env.SHOPIFY_PUBLIC_BASE_URL?.replace(/\/+$/, '') ||
      new URL(req.url).origin;

    const existing = await client.listWebhooks();
    const existingByTopic = new Map(existing.map((w) => [w.topic, w]));

    const subs: Record<string, string> = {};
    const created: string[] = [];
    const skipped: string[] = [];
    for (const topic of TOPICS) {
      const want = `${base}/api/webhooks/shopify/${topic}`;
      const e = existingByTopic.get(topic);
      if (e && e.address === want) {
        subs[topic] = e.id;
        skipped.push(topic);
        continue;
      }
      const sub = await client.createWebhook(topic, want);
      subs[topic] = sub.id;
      created.push(topic);
    }

    await recordWebhookSubscriptions(db, id, subs);
    return NextResponse.json({
      ok: true,
      base,
      created,
      skipped,
      subscriptions: subs,
    });
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    if (e instanceof ShopifyApiError) {
      return NextResponse.json(
        { ok: false, status: e.status, error: e.message },
        { status: 400 },
      );
    }
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
