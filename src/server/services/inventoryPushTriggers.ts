import type { PrismaClient } from '@/generated/tenant';
import { db } from '@/lib/db';
import { pushInventoryForProduct } from './shopifyInventoryPush';

// =============================================================================
// Inventory push debouncer. Call sites (post receipt, close SO, post
// adjustment, confirm credit memo, complete work order, reverse receipt)
// pass a Set<productId> to markProductsDirty() AFTER their transaction
// commits. We coalesce all dirty product ids in a module-level set and flush
// after a short quiescence window — typically several inventory movements
// in the same operation collapse into a single push per product.
//
// Why "after commit": pushing inventory for a rolled-back movement would
// publish stale numbers to Shopify. The trigger always runs after the
// caller's tx returns, so the on-hand state we read in
// pushInventoryForProduct reflects what actually happened.
//
// Pilot-scale design: in-process timer + Set. Survives within one Next.js
// process; a server restart drops the queue. Acceptable since the next
// inventory movement will re-queue. If we need durable retry / cross-process
// dedup, promote to Inngest (CLAUDE.md tech stack) — listed as upgrade path.
// =============================================================================

const FLUSH_DELAY_MS = 5_000;

const dirty = new Set<string>();
let timer: NodeJS.Timeout | null = null;

// Disabled during tests; the inventory push talks to live Shopify and we
// don't want unit tests to hit the network.
const ENABLED = process.env.NODE_ENV !== 'test';

export function markProductsDirty(productIds: Iterable<string>): void {
  if (!ENABLED) return;
  let added = false;
  for (const id of productIds) {
    if (!id) continue;
    if (!dirty.has(id)) {
      dirty.add(id);
      added = true;
    }
  }
  if (added) scheduleFlush();
}

/**
 * Convenience for orchestrators that have variantIds (sales orders,
 * receipts, work orders) — batch-resolves to productIds then marks dirty.
 * Pass the outer `db`, not a tx client: this is meant to run AFTER the
 * caller's tx commits so the dirty set reflects committed state only.
 */
export async function markProductsDirtyFromVariants(
  client: PrismaClient,
  variantIds: Iterable<string>,
): Promise<void> {
  if (!ENABLED) return;
  const ids = [...new Set(variantIds)].filter(Boolean);
  if (ids.length === 0) return;
  const variants = await client.productVariant.findMany({
    where: { id: { in: ids } },
    select: { productId: true },
  });
  markProductsDirty(variants.map((v) => v.productId));
}

function scheduleFlush(): void {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    void flush();
  }, FLUSH_DELAY_MS);
  // Don't keep the process alive solely for the debounce timer.
  if (typeof timer.unref === 'function') timer.unref();
}

async function flush(): Promise<void> {
  if (dirty.size === 0) return;
  const batch = [...dirty];
  dirty.clear();
  for (const productId of batch) {
    try {
      await pushInventoryForProduct(db, productId);
    } catch (err) {
      // Per-store errors are already isolated inside pushInventoryForProduct.
      // A thrown error here is something unexpected (loadStoreConfigs panic,
      // db connectivity, etc.) — log and move on; the next inventory
      // movement will re-queue.
      console.error(
        '[inventoryPushTriggers] flush error for product',
        productId,
        err,
      );
    }
  }
}

/**
 * Test/operator override — force the queue to drain immediately. Production
 * code paths should use markProductsDirty + the debounce; this exists so
 * smoke scripts and unit tests can deterministically observe results.
 */
export async function flushNowForTesting(): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  await flush();
}

/** Inspect the dirty set — diagnostic / test helper only. */
export function inspectDirtyForTesting(): readonly string[] {
  return [...dirty];
}
