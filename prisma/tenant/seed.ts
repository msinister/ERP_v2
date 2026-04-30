import { PrismaClient, InventoryMovementType } from '../../src/generated/tenant';

const db = new PrismaClient();

// Note on the MANUAL-TEST-CUSTOMER row that may exist in this DB:
// it is created lazily by scripts/manual-test-so-flow.ts when the script
// runs, NOT by this seed file. The expand_customer_master migration
// backfills it (and any other pre-existing customer) to the seeded
// UNASSIGNED sales rep + NET30 payment term. Owned by the script —
// do not remove or duplicate here.

// Default payment terms — admin-managed in the long run, but seeded here
// so a fresh tenant has the docs/03-customers.md defaults available.
const DEFAULT_PAYMENT_TERMS: ReadonlyArray<{ code: string; label: string; netDays: number | null }> = [
  { code: 'NET30',     label: 'Net 30',              netDays: 30 },
  { code: 'COD',       label: 'COD',                 netDays: null },
  { code: 'PREPAY',    label: 'Prepay',              netDays: null },
  { code: 'DEP50',     label: '50% Deposit',         netDays: null },
  { code: 'PAYSHIP',   label: 'Pay on Shipping',     netDays: null },
  { code: 'BILLNET30', label: 'Bill later (Net 30)', netDays: 30 },
];

async function main() {
  const warehouse = await db.warehouse.upsert({
    where: { code: 'WH-MAIN' },
    create: { code: 'WH-MAIN', name: 'Main Warehouse' },
    update: { name: 'Main Warehouse', active: true, deletedAt: null },
  });

  // Default PaymentTerm rows + UNASSIGNED SalesRep. Idempotent — the
  // migration also seeds these; running the seed on top is a no-op
  // (upsert by unique code).
  for (const t of DEFAULT_PAYMENT_TERMS) {
    await db.paymentTerm.upsert({
      where: { code: t.code },
      create: { code: t.code, label: t.label, netDays: t.netDays },
      update: { label: t.label, netDays: t.netDays, active: true, deletedAt: null },
    });
  }
  await db.salesRep.upsert({
    where: { code: 'UNASSIGNED' },
    create: { code: 'UNASSIGNED', name: 'Unassigned' },
    update: { name: 'Unassigned', active: true, deletedAt: null },
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

  const existingSeedMovement = await db.inventoryMovement.findFirst({
    where: {
      variantId: variant.id,
      warehouseId: warehouse.id,
      type: InventoryMovementType.RECEIVE,
      reference: 'SEED',
    },
  });
  if (!existingSeedMovement) {
    await db.inventoryMovement.create({
      data: {
        variantId: variant.id,
        warehouseId: warehouse.id,
        type: InventoryMovementType.RECEIVE,
        qty: '10',
        reference: 'SEED',
      },
    });
  }

  const agg = await db.inventoryMovement.aggregate({
    where: { variantId: variant.id, warehouseId: warehouse.id },
    _sum: { qty: true },
  });
  const onHand = agg._sum.qty ?? 0;

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
      onHand,
    },
    update: { onHand },
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
