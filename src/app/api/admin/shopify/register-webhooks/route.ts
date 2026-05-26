import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireSuperAdmin } from '@/lib/auth/requireAuth';
import { authErrorResponse } from '@/lib/auth/errors';
import {
  getSecrets,
  recordWebhookSubscriptions,
} from '@/server/services/shopifyConfig';
import {
  ShopifyApiError,
  ShopifyClient,
} from '@/lib/integrations/shopify/client';

// Register the three product webhooks (create / update / delete) on
// Shopify pointed at our /api/webhooks/shopify/... endpoints. Idempotent:
// already-registered topics are detected via listWebhooks and skipped.
//
// The webhook URL needs a publicly-reachable host — admins set
// SHOPIFY_PUBLIC_BASE_URL in their .env (e.g. https://erp.nakedkratom.com).
// Defaults to the request's own origin when unset (works in dev with
// a tunneling tool like Cloudflared).

const TOPICS = [
  'products/create',
  'products/update',
  'products/delete',
] as const;

export async function POST(req: Request) {
  try {
    const user = await requireSuperAdmin(req);
    const secrets = await getSecrets(db);
    const client = new ShopifyClient({
      storeUrl: secrets.storeUrl,
      accessToken: secrets.accessToken,
    });

    const base =
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

    await recordWebhookSubscriptions(db, subs, user.id);
    return NextResponse.json({ ok: true, base, created, skipped, subscriptions: subs });
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
