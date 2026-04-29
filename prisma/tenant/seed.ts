import { PrismaClient } from '../../src/generated/tenant';

const db = new PrismaClient();

async function main() {
  const warehouse = await db.warehouse.upsert({
    where: { code: 'WH-MAIN' },
    create: { code: 'WH-MAIN', name: 'Main Warehouse' },
    update: { name: 'Main Warehouse', active: true, deletedAt: null },
  });

  const product = await db.product.upsert({
    where: { sku: 'SEED-PROD-1' },
    create: { sku: 'SEED-PROD-1', name: 'Seed Product 1' },
    update: { name: 'Seed Product 1', active: true, deletedAt: null },
  });

  const variant = await db.productVariant.upsert({
    where: { sku: 'SEED-PROD-1-RED' },
    create: {
      productId: product.id,
      sku: 'SEED-PROD-1-RED',
      name: 'Seed Product 1 / Red',
      color: 'red',
    },
    update: {
      productId: product.id,
      name: 'Seed Product 1 / Red',
      color: 'red',
      active: true,
      deletedAt: null,
    },
  });

  const inventory = await db.inventoryItem.upsert({
    where: {
      variantId_warehouseId: {
        variantId: variant.id,
        warehouseId: warehouse.id,
      },
    },
    create: {
      variantId: variant.id,
      warehouseId: warehouse.id,
      onHand: '10',
    },
    update: { onHand: '10', reserved: '0' },
  });

  console.log({
    warehouseId: warehouse.id,
    productId: product.id,
    variantId: variant.id,
    inventoryId: inventory.id,
  });
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
