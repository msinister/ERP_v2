import { Prisma, type PrismaClient } from '@/generated/tenant';
import { ShopifyClient } from '@/lib/integrations/shopify/client';
import {
  getSecretsForStore,
  recordPushRun,
  type StoredPushRun,
} from './shopifyStores';
import { matchingProductIds } from './shopifyStoreRules';

// =============================================================================
// ERP → Shopify inventory push (multi-store). For each affected product, the
// service:
//   1. Loads every ProductShopifyVariant row across all stores.
//   2. Groups rows by store.
//   3. For each store with inventoryPushEnabled = true and a configured
//      shopifyLocationId, computes the "available" quantity for the variant
//      (sum across warehouses of onHand minus reserved; clamped at zero
//      since Shopify doesn't accept negatives via /inventory_levels/set).
//   4. Looks up inventory_item_id on first push and caches it on the
//      junction row. Subsequent pushes skip the lookup.
//   5. Calls /inventory_levels/set per (store, inventory_item, location).
//
// Per-store failure isolation: an exception talking to Store A does not
// block pushes to Store B. Errors are collected and returned in the push
// run summary; one product can produce multiple error rows (one per failed
// store).
// =============================================================================

type StoreConfig = {
  storeId: string;
  storeUrl: string;
  accessToken: string;
  locationId: string;
  client: ShopifyClient;
};

async function loadStoreConfigs(
  db: PrismaClient,
  storeIds: Iterable<string>,
): Promise<Map<string, StoreConfig | { skipReason: string }>> {
  const out = new Map<string, StoreConfig | { skipReason: string }>();
  for (const storeId of storeIds) {
    if (out.has(storeId)) continue;
    try {
      const secrets = await getSecretsForStore(db, storeId);
      if (!secrets.inventoryPushEnabled) {
        out.set(storeId, { skipReason: 'inventoryPushEnabled=false' });
        continue;
      }
      if (!secrets.shopifyLocationId) {
        out.set(storeId, { skipReason: 'no shopifyLocationId configured' });
        continue;
      }
      out.set(storeId, {
        storeId,
        storeUrl: secrets.storeUrl,
        accessToken: secrets.accessToken,
        locationId: secrets.shopifyLocationId,
        client: new ShopifyClient({
          storeUrl: secrets.storeUrl,
          accessToken: secrets.accessToken,
        }),
      });
    } catch (e) {
      out.set(storeId, {
        skipReason: e instanceof Error ? e.message : 'unknown',
      });
    }
  }
  return out;
}

/**
 * Sum (onHand - reserved) across every warehouse for every variant in this
 * product. Single aggregate query — pilot scale (<10 warehouses, <10
 * variants per product) makes it cheap.
 */
async function computeAvailable(
  db: PrismaClient,
  productId: string,
): Promise<number> {
  const items = await db.inventoryItem.findMany({
    where: { variant: { productId, deletedAt: null } },
    select: { onHand: true, reserved: true },
  });
  let total = new Prisma.Decimal(0);
  for (const it of items) {
    const avail = it.onHand.minus(it.reserved);
    if (avail.greaterThan(0)) total = total.plus(avail);
  }
  // Shopify rejects negatives via inventory_levels/set; clamp.
  const n = Math.max(0, Math.floor(Number(total.toString())));
  return Number.isFinite(n) ? n : 0;
}

export type PushResult = {
  productId: string;
  storeId: string;
  variantId: string;
  shopifyVariantId: string;
  available: number;
  outcome: 'pushed' | 'skipped' | 'error';
  reason?: string;
};

/**
 * Push the current available quantity for one ERP product to every Shopify
 * store that lists it. Stores with inventoryPushEnabled=false, missing
 * location, or unconfigured credentials are skipped (with reason). One
 * failure does not abort the run.
 */
export async function pushInventoryForProduct(
  db: PrismaClient,
  productId: string,
): Promise<PushResult[]> {
  const junctionRows = await db.productShopifyVariant.findMany({
    where: { productId },
    select: {
      id: true,
      shopifyStoreId: true,
      shopifyVariantId: true,
      shopifyProductId: true,
      inventoryItemId: true,
    },
  });
  if (junctionRows.length === 0) return [];

  const storeConfigs = await loadStoreConfigs(
    db,
    junctionRows.map((r) => r.shopifyStoreId),
  );

  // One available number per product — same physical inventory, fanned out
  // to every Shopify listing across stores.
  const available = await computeAvailable(db, productId);

  // Look up a placeholder variantId for diagnostics — the first variant on
  // this product. The available number is product-wide so we don't need a
  // per-variant breakdown here.
  const anyVariant = await db.productVariant.findFirst({
    where: { productId, deletedAt: null },
    select: { id: true },
  });
  const reportVariantId = anyVariant?.id ?? '';

  const results: PushResult[] = [];
  for (const row of junctionRows) {
    const cfg = storeConfigs.get(row.shopifyStoreId);
    if (!cfg || 'skipReason' in cfg) {
      results.push({
        productId,
        storeId: row.shopifyStoreId,
        variantId: reportVariantId,
        shopifyVariantId: row.shopifyVariantId,
        available,
        outcome: 'skipped',
        reason: cfg?.skipReason ?? 'store config missing',
      });
      continue;
    }

    try {
      let inventoryItemId = row.inventoryItemId;
      if (!inventoryItemId) {
        const variant = await cfg.client.getVariant(row.shopifyVariantId);
        inventoryItemId = variant.inventory_item_id;
        await db.productShopifyVariant.update({
          where: { id: row.id },
          data: { inventoryItemId },
        });
      }
      await cfg.client.setInventoryLevel(
        cfg.locationId,
        inventoryItemId,
        available,
      );
      results.push({
        productId,
        storeId: row.shopifyStoreId,
        variantId: reportVariantId,
        shopifyVariantId: row.shopifyVariantId,
        available,
        outcome: 'pushed',
      });
    } catch (e) {
      results.push({
        productId,
        storeId: row.shopifyStoreId,
        variantId: reportVariantId,
        shopifyVariantId: row.shopifyVariantId,
        available,
        outcome: 'error',
        reason: e instanceof Error ? e.message : 'unknown',
      });
    }
  }
  return results;
}

/**
 * Push inventory for every product the given store's rules match — or
 * across all push-enabled stores if no storeId provided. Records a
 * StoredPushRun summary per store touched.
 */
export async function pushAllInventory(
  db: PrismaClient,
  storeId?: string,
): Promise<Record<string, StoredPushRun>> {
  let targetStoreIds: string[];
  if (storeId) {
    targetStoreIds = [storeId];
  } else {
    const stores = await db.shopifyStore.findMany({
      where: { active: true, deletedAt: null, inventoryPushEnabled: true },
      select: { id: true },
    });
    targetStoreIds = stores.map((s) => s.id);
  }

  const runs: Record<string, StoredPushRun> = {};
  for (const sid of targetStoreIds) {
    const startedAt = new Date();
    let pushed = 0;
    let skipped = 0;
    const errors: StoredPushRun['errors'] = [];

    const productIds = await matchingProductIds(db, sid);
    for (const productId of productIds) {
      const rs = await pushInventoryForProduct(db, productId);
      for (const r of rs) {
        if (r.storeId !== sid) continue;
        if (r.outcome === 'pushed') pushed++;
        else if (r.outcome === 'skipped') skipped++;
        else
          errors.push({
            productId: r.productId,
            storeId: r.storeId,
            message: r.reason ?? 'unknown',
          });
      }
    }

    const run: StoredPushRun = {
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      pushed,
      skipped,
      errors,
    };
    await recordPushRun(db, sid, run);
    runs[sid] = run;
  }
  return runs;
}
