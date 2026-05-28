/**
 * Diagnostic + cleanup script for ShopifyCustomerLink.
 *
 * What it does:
 *  1. Lists every ShopifyCustomerLink row with store + customer info.
 *  2. Lists every SalesOrder that came from Shopify (has shopifyOrderId).
 *  3. Prompts before deleting anything — set DRY_RUN=false to actually delete.
 *
 * Usage:
 *   npx tsx scripts/fix-shopify-customer-links.ts
 *   DRY_RUN=false npx tsx scripts/fix-shopify-customer-links.ts
 */

import { PrismaClient } from '../src/generated/tenant';

const DRY_RUN = process.env.DRY_RUN !== 'false';

const db = new PrismaClient({
  datasourceUrl: process.env.TENANT_DATABASE_URL,
});

async function main() {
  console.log(`\n=== ShopifyCustomerLink diagnostic ===`);
  console.log(`DRY_RUN=${DRY_RUN} (set DRY_RUN=false to apply fixes)\n`);

  // ── 1. All ShopifyCustomerLink rows ──────────────────────────────────────
  const links = await db.shopifyCustomerLink.findMany({
    include: {
      store: { select: { id: true, name: true } },
      customer: { select: { id: true, name: true, primaryEmail: true } },
    },
    orderBy: { createdAt: 'asc' },
  });

  console.log(`ShopifyCustomerLink rows (${links.length} total):`);
  for (const l of links) {
    console.log(
      `  store="${l.store.name}"  shopifyCustomerId=${l.shopifyCustomerId}` +
        `  → ERP customer="${l.customer.name}" (${l.customer.primaryEmail ?? 'no email'})` +
        `  [${l.shopifyStoreId}]`,
    );
  }

  // ── 2. Sales orders that came from Shopify ───────────────────────────────
  const shopifySOs = await db.salesOrder.findMany({
    where: { shopifyOrderId: { not: null }, deletedAt: null },
    include: {
      customer: { select: { id: true, name: true } },
      shopifyStore: { select: { name: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });

  console.log(`\nShopify-sourced SalesOrders (most recent 20):`);
  for (const so of shopifySOs) {
    console.log(
      `  ${so.number}  store="${so.shopifyStore?.name ?? '?'}"  shopifyOrderId=${so.shopifyOrderId}` +
        `  customer="${so.customer.name}"  status=${so.status}`,
    );
  }

  // ── 3. Check for obvious mismatches ─────────────────────────────────────
  // A "mismatch" here means: a ShopifyCustomerLink points customer A,
  // but the most recent SO for that shopifyOrderId is under customer B.
  // We just report them; the operator decides which link to keep.

  console.log(`\n=== Mismatches (link customer ≠ SO customer) ===`);
  let mismatches = 0;
  for (const so of shopifySOs) {
    if (!so.shopifyOrderId || !so.shopifyStoreId) continue;
    // Find the link for the Shopify customer who placed this order.
    // We don't store shopifyCustomerId on the SO itself, so we can only
    // check if the SO's customer has a link for the same store.
    const link = links.find(
      (l) =>
        l.shopifyStoreId === so.shopifyStoreId &&
        l.customer.id === so.customerId,
    );
    if (!link) {
      console.log(
        `  WARNING: SO ${so.number} (store="${so.shopifyStore?.name}") customer="${so.customer.name}"` +
          ` has NO ShopifyCustomerLink for this store.`,
      );
      mismatches++;
    }
  }
  if (mismatches === 0) console.log('  None detected.');

  // ── 4. Interactive: list links and let operator delete bad ones ──────────
  console.log(`\n=== Review the links above ===`);
  console.log(
    `If any link is wrong, re-run with DRY_RUN=false and the DELETE_LINK_IDS env var:`,
  );
  console.log(
    `  DELETE_LINK_IDS="storeId1:shopifyCustId1,storeId2:shopifyCustId2" DRY_RUN=false npx tsx scripts/fix-shopify-customer-links.ts`,
  );

  // ── 5. Apply deletions if requested ─────────────────────────────────────
  const deleteRaw = process.env.DELETE_LINK_IDS;
  if (deleteRaw) {
    const pairs = deleteRaw.split(',').map((p) => {
      const [shopifyStoreId, shopifyCustomerId] = p.split(':');
      return { shopifyStoreId, shopifyCustomerId };
    });
    console.log(`\nDeleting ${pairs.length} link(s)...`);
    for (const pair of pairs) {
      if (DRY_RUN) {
        console.log(
          `  [DRY RUN] Would delete link storeId=${pair.shopifyStoreId} shopifyCustomerId=${pair.shopifyCustomerId}`,
        );
      } else {
        await db.shopifyCustomerLink.delete({
          where: {
            shopifyStoreId_shopifyCustomerId: {
              shopifyStoreId: pair.shopifyStoreId!,
              shopifyCustomerId: pair.shopifyCustomerId!,
            },
          },
        });
        console.log(
          `  Deleted link storeId=${pair.shopifyStoreId} shopifyCustomerId=${pair.shopifyCustomerId}`,
        );
      }
    }
  }

  // ── 6. Soft-delete bad SOs if requested ─────────────────────────────────
  const deleteSOs = process.env.DELETE_SO_IDS;
  if (deleteSOs) {
    const soIds = deleteSOs.split(',').map((s) => s.trim());
    console.log(`\nSoft-deleting ${soIds.length} SalesOrder(s)...`);
    for (const id of soIds) {
      const so = await db.salesOrder.findFirst({
        where: { OR: [{ id }, { number: id }], deletedAt: null },
        select: { id: true, number: true, status: true },
      });
      if (!so) {
        console.log(`  Not found or already deleted: ${id}`);
        continue;
      }
      if (so.status !== 'DRAFT' && so.status !== 'CANCELLED') {
        console.log(
          `  SKIP ${so.number}: status=${so.status} — cancel it first before deleting.`,
        );
        continue;
      }
      if (DRY_RUN) {
        console.log(`  [DRY RUN] Would soft-delete SO ${so.number} (${so.id})`);
      } else {
        await db.salesOrder.update({
          where: { id: so.id },
          data: { deletedAt: new Date() },
        });
        console.log(`  Soft-deleted SO ${so.number} (${so.id})`);
      }
    }
  }

  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
