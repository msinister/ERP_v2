import { db } from '../src/lib/db';
import { receiveInventory, consumeInventory } from '../src/server/services/movements';

async function main() {
  const variantId = 'cmojjsb3k0003v76kaaju46c2';
  const warehouseId = 'cmojjsb350000v76kyjr648y0';

  await receiveInventory(db, { variantId, warehouseId, qty: '5' });
  await consumeInventory(db, { variantId, warehouseId, qty: '3' });

  console.log(await db.inventoryItem.findMany());
  console.log(
    await db.inventoryMovement.findMany({
      orderBy: { createdAt: 'desc' },
      take: 5,
    }),
  );
}

main()
  .catch(console.error)
  .finally(() => db.$disconnect());