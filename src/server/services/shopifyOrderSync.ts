import {
  AuditAction,
  PaymentMethod,
  PriceResolutionRule,
  Prisma,
  SalesOrderSource,
  SalesOrderStatus,
} from '@/generated/tenant';
import type { PrismaClient } from '@/generated/tenant';
import { audit, type AuditContext } from '@/lib/audit/audit';
import { ShopifyClient } from '@/lib/integrations/shopify/client';
import type {
  ShopifyAddress,
  ShopifyOrder,
} from '@/lib/integrations/shopify/types';
import { getNextSequence } from '@/lib/sequences/sequences';
import { recordPayment } from '@/server/services/payments';
import {
  closeSalesOrder,
  confirmSalesOrder,
  cancelSalesOrder,
} from '@/server/services/salesOrders';
import {
  getSecretsForStore,
  type StoredOrderSyncRun,
} from '@/server/services/shopifyStores';
import {
  createCustomerFromShopifyOrder,
  matchCustomerForShopifyOrder,
  StoreNotConfiguredForOrderSyncError,
} from '@/server/services/shopifyCustomerMatch';

// =============================================================================
// Shopify → ERP order import.
//
// importShopifyOrder is idempotent on (storeId, shopifyOrderId). It runs the
// customer match + per-line SKU resolution; on any ambiguity it parks a
// PendingOrderReview and returns 'pending_review' without touching the SO
// tables. On success it creates a SalesOrder (status=CONFIRMED, source=
// SHOPIFY) and — for B2C (isExternalPayment from store routing) — closes
// the SO immediately, generating the invoice and recording an EXTERNAL
// payment that zeros the AR balance. B2B orders stop at CONFIRMED for the
// operator to pick / pack / close through the normal flow.
//
// syncOrdersForStore wraps importShopifyOrder over a paged result set from
// Shopify, then records the run summary on the store row.
// =============================================================================

const SO_SEQUENCE_NAME = 'sales_order';
const SO_PREFIX = 'SO';

// Methods Shopify uses for financial_status when the customer has
// effectively paid (or committed to pay via deferred capture). Anything
// outside this set is skipped by the sync (refunded / voided already-
// imported orders are handled via the orders/updated webhook path).
const IMPORTABLE_FINANCIAL_STATUSES = new Set([
  'paid',
  'pending',
  'authorized',
  'partially_paid',
]);

// Statuses we treat as "already settled by Shopify" → B2C external-pay
// path that auto-records a payment. "pending" + "authorized" lean B2B
// (terms-style invoicing), so the operator handles AR.
const PAID_FINANCIAL_STATUSES = new Set([
  'paid',
  'partially_paid',
  'partially_refunded',
  'refunded',
]);

export type ImportOutcome =
  | {
      outcome: 'imported';
      salesOrderId: string;
      salesOrderNumber: string;
      closed: boolean;
    }
  | {
      outcome: 'skipped';
      reason: 'already_imported' | 'pending_review_exists' | 'unsupported_status';
      salesOrderId?: string;
      pendingReviewId?: string;
    }
  | {
      outcome: 'pending_review';
      pendingReviewId: string;
      reason: 'EMAIL_MATCH_DIFFERENT_ID' | 'MULTIPLE_EMAIL_MATCHES' | 'UNKNOWN_SKU';
    }
  | {
      outcome: 'error';
      message: string;
    };

export type SyncOrdersResult = StoredOrderSyncRun;

// ---------------------------------------------------------------------------
// importShopifyOrder
// ---------------------------------------------------------------------------

export async function importShopifyOrder(
  db: PrismaClient,
  storeId: string,
  order: ShopifyOrder,
  ctx?: AuditContext,
): Promise<ImportOutcome> {
  // 0. Sanity: the matching service will need store defaults; fetch the
  // store row once up front so we fail fast on misconfigured stores
  // instead of midway through a half-built order.
  const store = await db.shopifyStore.findUnique({ where: { id: storeId } });
  if (!store || store.deletedAt != null) {
    return { outcome: 'error', message: `ShopifyStore not found / archived: ${storeId}` };
  }

  // 1. Idempotency: skip if we already imported this order.
  const existing = await db.salesOrder.findFirst({
    where: { shopifyOrderId: order.id },
    select: { id: true },
  });
  if (existing) {
    return {
      outcome: 'skipped',
      reason: 'already_imported',
      salesOrderId: existing.id,
    };
  }

  // 2. Idempotency: a PENDING review for this order already exists.
  const existingReview = await db.pendingOrderReview.findFirst({
    where: {
      shopifyStoreId: storeId,
      shopifyOrderId: order.id,
      status: 'PENDING',
    },
    select: { id: true },
  });
  if (existingReview) {
    return {
      outcome: 'skipped',
      reason: 'pending_review_exists',
      pendingReviewId: existingReview.id,
    };
  }

  // 3. Filter on financial_status — skip refunded / voided / null.
  const financial = order.financial_status ?? '';
  if (!IMPORTABLE_FINANCIAL_STATUSES.has(financial)) {
    return { outcome: 'skipped', reason: 'unsupported_status' };
  }

  // 4. Customer match.
  const matchResult = await matchCustomerForShopifyOrder(db, order);
  if (matchResult.kind === 'ambiguous') {
    const review = await createPendingReview(db, {
      storeId,
      order,
      reason: matchResult.reason,
      matchedCustomerId: matchResult.matchedCustomerId,
      unknownSku: null,
      ctx,
    });
    return {
      outcome: 'pending_review',
      pendingReviewId: review.id,
      reason: matchResult.reason,
    };
  }

  let customerId: string;
  if (matchResult.kind === 'matched') {
    customerId = matchResult.customerId;
  } else {
    // no_match → auto-create from store defaults. Surface the misconfig
    // error as a typed import error so the sync run logs the cause.
    try {
      const created = await createCustomerFromShopifyOrder(db, order, store, ctx);
      customerId = created.id;
    } catch (e) {
      if (e instanceof StoreNotConfiguredForOrderSyncError) {
        return { outcome: 'error', message: e.message };
      }
      throw e;
    }
  }

  // 5. Line / SKU resolution. Every line_item.sku must resolve to an
  // active ProductVariant; any miss queues the whole order for review.
  const resolvedLines: ResolvedLine[] = [];
  for (const li of order.line_items) {
    const sku = (li.sku ?? '').trim();
    if (!sku) {
      const review = await createPendingReview(db, {
        storeId,
        order,
        reason: 'UNKNOWN_SKU',
        matchedCustomerId: null,
        unknownSku: '(blank sku)',
        ctx,
      });
      return { outcome: 'pending_review', pendingReviewId: review.id, reason: 'UNKNOWN_SKU' };
    }
    const variant = await db.productVariant.findFirst({
      where: { sku, deletedAt: null, active: true },
      select: { id: true },
    });
    if (!variant) {
      const review = await createPendingReview(db, {
        storeId,
        order,
        reason: 'UNKNOWN_SKU',
        matchedCustomerId: null,
        unknownSku: sku,
        ctx,
      });
      return { outcome: 'pending_review', pendingReviewId: review.id, reason: 'UNKNOWN_SKU' };
    }
    resolvedLines.push({
      variantId: variant.id,
      sku,
      qty: new Prisma.Decimal(li.quantity),
      unitPrice: new Prisma.Decimal(li.price),
      discountAmount: new Prisma.Decimal(li.total_discount || '0'),
    });
  }

  // 6. Store defaults for warehouse — required at SO create time.
  if (!store.defaultWarehouseId) {
    return {
      outcome: 'error',
      message: `ShopifyStore ${storeId} has no defaultWarehouseId — set it before importing orders.`,
    };
  }
  const warehouseId = store.defaultWarehouseId;

  // 7. Determine the B2C external-pay path. Customer.type === RETAIL is
  // the trigger — set per-store via defaultCustomerType. We re-fetch the
  // customer here in case auto-create just made them.
  const customer = await db.customer.findUniqueOrThrow({
    where: { id: customerId },
    select: { type: true, name: true },
  });
  const isExternalPayment =
    customer.type === 'RETAIL' && PAID_FINANCIAL_STATUSES.has(financial);

  // 8. SO header + line create inside one transaction. We bypass the
  // standard createSalesOrder service because (a) the unit price MUST
  // come from Shopify verbatim — no resolver runs — and (b) we need to
  // populate the Shopify-provenance columns. We still mirror its
  // sequence / audit conventions exactly.
  const orderDate = new Date(order.created_at);
  const created = await db.$transaction(async (tx) => {
    const seq = await getNextSequence(tx, {
      name: SO_SEQUENCE_NAME,
      prefix: SO_PREFIX,
      useYear: true,
    });
    const shippingAmount = parseDecimal(
      order.total_shipping_price_set?.shop_money.amount,
    );
    const so = await tx.salesOrder.create({
      data: {
        number: seq.formatted,
        customerId,
        warehouseId,
        status: SalesOrderStatus.DRAFT,
        source: SalesOrderSource.SHOPIFY,
        currency: order.currency || 'USD',
        orderDate,
        shippingAmount,
        shippingAddress: order.shipping_address
          ? formatAddressOneLine(order.shipping_address)
          : null,
        customerNotes: order.note?.slice(0, 2000) ?? null,
        internalNotes: buildInternalNotes(order),
        createdById: ctx?.userId ?? null,
        shopifyOrderId: order.id,
        shopifyOrderNumber: order.name,
        shopifyStoreId: storeId,
        isExternalPayment,
        externalPaymentStatus: order.financial_status ?? null,
        externalPaymentGateway: order.payment_gateway_names?.[0] ?? null,
        lines: {
          create: resolvedLines.map((l) => ({
            variantId: l.variantId,
            warehouseId,
            qtyOrdered: l.qty,
            unitPrice: l.unitPrice,
            // Shopify gave us the price directly; flag as MANUAL_OVERRIDE
            // so downstream filters that look at priceRule see "operator
            // set this" semantics. (No BUNDLE / TIER / CUSTOMER_SPECIFIC
            // pricing on the import path by design.)
            priceRule: PriceResolutionRule.MANUAL_OVERRIDE,
            discountAmount: l.discountAmount.greaterThan(0) ? l.discountAmount : null,
          })),
        },
      },
    });
    await audit(tx, {
      action: AuditAction.CREATE,
      entityType: 'SalesOrder',
      entityId: so.id,
      after: { ...so, _source: 'shopify_import' },
      ctx,
    });
    return so;
  });

  // 9. Confirm. Reserves inventory. For B2B this is the end state.
  try {
    await confirmSalesOrder(db, created.id, ctx);
  } catch (e) {
    // Confirm can fail if a credit-limit / AR-hold guard trips. Surface
    // the cause and leave the SO at DRAFT so the operator can intervene.
    return {
      outcome: 'error',
      message: `SO created but confirm failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  let closed = false;
  if (isExternalPayment) {
    // B2C path: close immediately to generate the invoice + post COGS,
    // then auto-record the external payment.
    try {
      await closeSalesOrder(db, created.id, undefined, ctx);
      closed = true;
    } catch (e) {
      // Insufficient stock at close is the common failure here — Shopify
      // already shipped the goods but ERP inventory is out of sync. Leave
      // the SO Confirmed and let the operator fix inventory before
      // re-closing. Don't fail the whole import — half-imported is worse
      // than imported-and-flagged.
      const msg = e instanceof Error ? e.message : String(e);
      await audit(db, {
        action: AuditAction.STATUS_CHANGE,
        entityType: 'SalesOrder',
        entityId: created.id,
        after: { _shopifyImport: 'close_failed', message: msg },
        ctx,
      });
      return {
        outcome: 'imported',
        salesOrderId: created.id,
        salesOrderNumber: created.number,
        closed: false,
      };
    }
    // 10. Record the external payment against the freshly-generated
    // invoice. recordPayment uses default cash account 1110 when
    // cashAccountId is omitted — fine for the pilot Shopify-clearing
    // account isn't wired yet. Reference carries the Shopify order #.
    try {
      const invoice = await db.invoice.findFirst({
        where: { salesOrderId: created.id, deletedAt: null },
        select: { id: true, total: true, amountPaid: true, amountCredited: true },
      });
      if (invoice) {
        const due = new Prisma.Decimal(invoice.total)
          .minus(invoice.amountPaid)
          .minus(invoice.amountCredited);
        if (due.greaterThan(0)) {
          await recordPayment(
            db,
            {
              customerId,
              method: PaymentMethod.EXTERNAL,
              amount: due.toString(),
              currency: order.currency || 'USD',
              receivedAt: orderDate,
              reference: `Shopify ${order.name}`,
              notes: `Auto-recorded from Shopify Payments (${order.payment_gateway_names?.[0] ?? 'unknown gateway'})`,
              applications: [{ invoiceId: invoice.id, amount: due.toString() }],
            },
            ctx,
          );
        }
      }
    } catch (e) {
      // Payment recording failed after a successful close — log + return
      // a soft success so the SO+invoice are preserved. Operator can
      // record the payment manually.
      const msg = e instanceof Error ? e.message : String(e);
      await audit(db, {
        action: AuditAction.STATUS_CHANGE,
        entityType: 'SalesOrder',
        entityId: created.id,
        after: { _shopifyImport: 'external_payment_failed', message: msg },
        ctx,
      });
    }
  }

  return {
    outcome: 'imported',
    salesOrderId: created.id,
    salesOrderNumber: created.number,
    closed,
  };
}

// ---------------------------------------------------------------------------
// Webhook-companion: orders/cancelled handling.
//
// Idempotency: cancelling an SO that's already cancelled / closed has its
// own handling in cancelSalesOrder. We do the lookup first to keep the
// service contract clean.
// ---------------------------------------------------------------------------

export async function handleShopifyOrderCancellation(
  db: PrismaClient,
  storeId: string,
  shopifyOrderId: string,
  reason: string | null,
  ctx?: AuditContext,
): Promise<{ outcome: 'cancelled' | 'not_found' | 'already_cancelled' }> {
  const so = await db.salesOrder.findFirst({
    where: { shopifyOrderId, shopifyStoreId: storeId, deletedAt: null },
    select: { id: true, status: true },
  });
  if (!so) return { outcome: 'not_found' };
  if (
    so.status === SalesOrderStatus.CANCELLED ||
    so.status === SalesOrderStatus.CLOSED
  ) {
    return { outcome: 'already_cancelled' };
  }
  await cancelSalesOrder(
    db,
    so.id,
    { reason: `Shopify cancellation: ${reason ?? 'no reason supplied'}` },
    ctx,
  );
  return { outcome: 'cancelled' };
}

// ---------------------------------------------------------------------------
// syncOrdersForStore — paged pull + per-order import + run summary write.
// ---------------------------------------------------------------------------

export async function syncOrdersForStore(
  db: PrismaClient,
  storeId: string,
  ctx?: AuditContext,
): Promise<SyncOrdersResult> {
  const startedAt = new Date();
  const secrets = await getSecretsForStore(db, storeId);
  const store = await db.shopifyStore.findUnique({ where: { id: storeId } });
  if (!store) throw new Error(`ShopifyStore not found: ${storeId}`);
  if (!store.orderSyncEnabled) {
    throw new Error(
      `ShopifyStore ${storeId} has orderSyncEnabled=false — enable it before running order sync`,
    );
  }

  const since = store.lastOrderSyncAt ?? thirtyDaysAgo();
  const client = new ShopifyClient({
    storeUrl: secrets.storeUrl,
    accessToken: secrets.accessToken,
  });

  let imported = 0;
  let skipped = 0;
  let pendingReview = 0;
  const errors: SyncOrdersResult['errors'] = [];

  for await (const batch of client.iterateOrders({
    status: 'any',
    financialStatus: 'paid,pending,authorized,partially_paid',
    updatedAtMin: since.toISOString(),
  })) {
    for (const order of batch) {
      try {
        const r = await importShopifyOrder(db, storeId, order, ctx);
        if (r.outcome === 'imported') imported++;
        else if (r.outcome === 'skipped') skipped++;
        else if (r.outcome === 'pending_review') pendingReview++;
        else if (r.outcome === 'error') {
          errors.push({
            shopifyOrderId: order.id,
            shopifyOrderNumber: order.name,
            message: r.message,
          });
        }
      } catch (e) {
        errors.push({
          shopifyOrderId: order.id,
          shopifyOrderNumber: order.name,
          message: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  const finishedAt = new Date();
  const run: StoredOrderSyncRun = {
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    imported,
    skipped,
    pendingReview,
    errors,
  };
  await db.shopifyStore.update({
    where: { id: storeId },
    data: {
      lastOrderSyncAt: finishedAt,
      lastOrderSyncResult: JSON.parse(JSON.stringify(run)) as Prisma.InputJsonValue,
    },
  });
  return run;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ResolvedLine = {
  variantId: string;
  sku: string;
  qty: Prisma.Decimal;
  unitPrice: Prisma.Decimal;
  discountAmount: Prisma.Decimal;
};

type CreateReviewArgs = {
  storeId: string;
  order: ShopifyOrder;
  reason: 'EMAIL_MATCH_DIFFERENT_ID' | 'MULTIPLE_EMAIL_MATCHES' | 'UNKNOWN_SKU';
  matchedCustomerId: string | null;
  unknownSku: string | null;
  ctx?: AuditContext;
};

async function createPendingReview(
  db: PrismaClient,
  args: CreateReviewArgs,
): Promise<{ id: string }> {
  return db.$transaction(async (tx) => {
    const created = await tx.pendingOrderReview.create({
      data: {
        shopifyStoreId: args.storeId,
        shopifyOrderId: args.order.id,
        shopifyOrderNumber: args.order.name,
        shopifyCustomerEmail: (args.order.customer?.email ?? args.order.email ?? '').trim(),
        shopifyCustomerId: args.order.customer?.id?.toString() ?? null,
        shopifyOrderData: JSON.parse(JSON.stringify(args.order)) as Prisma.InputJsonValue,
        reason: args.reason,
        matchedCustomerId: args.matchedCustomerId,
        unknownSku: args.unknownSku,
      },
    });
    await audit(tx, {
      action: AuditAction.CREATE,
      entityType: 'PendingOrderReview',
      entityId: created.id,
      after: created,
      ctx: args.ctx,
    });
    return { id: created.id };
  });
}

function buildInternalNotes(order: ShopifyOrder): string {
  const lines: string[] = [
    `Imported from Shopify order ${order.name}`,
    `financial_status=${order.financial_status ?? 'null'}`,
    `fulfillment_status=${order.fulfillment_status ?? 'null'}`,
  ];
  if (order.payment_gateway_names?.length) {
    lines.push(`gateway=${order.payment_gateway_names.join(', ')}`);
  }
  if (order.tags) lines.push(`shopify_tags=${order.tags}`);
  return lines.join('\n').slice(0, 2000);
}

function formatAddressOneLine(a: ShopifyAddress): string {
  const parts = [
    a.name ?? `${a.first_name ?? ''} ${a.last_name ?? ''}`.trim(),
    a.company,
    a.address1,
    a.address2,
    [a.city, a.province_code ?? a.province, a.zip].filter(Boolean).join(' '),
    a.country_code ?? a.country,
  ].filter((s): s is string => !!s && s.trim() !== '');
  return parts.join(', ').slice(0, 2000);
}

function parseDecimal(s: string | undefined | null): Prisma.Decimal | null {
  if (s == null || s === '') return null;
  const d = new Prisma.Decimal(s);
  return d.greaterThan(0) ? d : null;
}

function thirtyDaysAgo(): Date {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return d;
}

