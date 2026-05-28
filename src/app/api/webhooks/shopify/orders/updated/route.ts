import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import type { ShopifyOrderWebhookPayload } from '@/lib/integrations/shopify/types';
import { authenticateShopifyWebhook } from '@/lib/integrations/shopify/webhookAuth';
import { importShopifyOrder } from '@/server/services/shopifyOrderSync';

// orders/updated — fired for any change (payment status, fulfillment,
// edit, etc.). We re-run importShopifyOrder which is idempotent: if the
// order already exists in ERP we short-circuit with 'already_imported'
// and update the external payment fields below for status changes that
// matter to AR (paid → refunded, etc.). If the order doesn't exist yet
// (we missed orders/create or it was filtered out), the import runs fresh.

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

  const order = { ...payload, id: String(payload.id) };

  try {
    // First pass: try a fresh import. Idempotent — returns
    // 'already_imported' if we've seen the order, in which case we move
    // on to the status-mirror step.
    const result = await importShopifyOrder(db, auth.storeId, order);

    if (result.outcome === 'skipped' && result.reason === 'already_imported') {
      // Mirror the latest financial status onto the SO row so reports
      // and the SO detail page see the truth from Shopify. We don't
      // touch SO status or invoice rows here — refund-driven CMs are
      // a separate manual workflow per spec.
      await db.salesOrder.updateMany({
        where: { shopifyOrderId: order.id },
        data: {
          externalPaymentStatus: order.financial_status ?? null,
          externalPaymentGateway: order.payment_gateway_names?.[0] ?? null,
        },
      });
    }
    return NextResponse.json({ ok: true, storeId: auth.storeId, result });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 500 },
    );
  }
}
