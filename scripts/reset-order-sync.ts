/**
 * Resets lastOrderSyncAt on a ShopifyStore so the next order sync
 * re-fetches from the last 30 days instead of the last sync timestamp.
 *
 * Usage: npx tsx scripts/reset-order-sync.ts <storeId>
 *   e.g. npx tsx scripts/reset-order-sync.ts mig_c021d518bfdfaf4418b4e5ac183e3446
 */
import { PrismaClient } from '../src/generated/tenant';

const db = new PrismaClient({ datasourceUrl: process.env.TENANT_DATABASE_URL });

async function main() {
  const storeId = process.argv[2];
  if (!storeId) {
    const stores = await db.shopifyStore.findMany({ select: { id: true, name: true, lastOrderSyncAt: true } });
    console.log('Stores:');
    for (const s of stores) console.log(`  ${s.id}  "${s.name}"  lastOrderSyncAt=${s.lastOrderSyncAt}`);
    console.log('\nRe-run with a storeId argument to reset it.');
    await db.$disconnect();
    return;
  }

  const store = await db.shopifyStore.update({
    where: { id: storeId },
    data: { lastOrderSyncAt: null },
    select: { id: true, name: true, lastOrderSyncAt: true },
  });
  console.log(`Reset lastOrderSyncAt → null for store "${store.name}" (${store.id})`);
  await db.$disconnect();
}

main().catch(console.error);
