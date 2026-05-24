/**
 * Verify the products-list extras: Qty on PO (open-PO remaining), blended
 * WAC, MPN, and cost gating (includeCost).
 *   npx tsx scripts/verify-products-list-extras.ts
 *   npx tsx scripts/verify-products-list-extras.ts --cleanup-only
 */
import { Prisma } from '../src/generated/tenant';
import { db } from '../src/lib/db';
import { listProductsPaged } from '../src/server/services/products';

const TAG = `SMOKE-PLX-${Date.now()}`;
const PREFIX = 'SMOKE-PLX-';
const cleanupOnly = process.argv.includes('--cleanup-only');
const D = (n: string) => new Prisma.Decimal(n);

function ok(m: string) { console.log(`  [OK]   ${m}`); }
function fail(m: string): never { console.error(`  [FAIL] ${m}`); throw new Error(m); }

async function sweep(prefix: string) {
  const variants = await db.productVariant.findMany({
    where: { sku: { startsWith: prefix } },
    select: { id: true },
  });
  const variantIds = variants.map((v) => v.id);
  if (variantIds.length > 0) {
    await db.fifoLayer.deleteMany({ where: { variantId: { in: variantIds } } });
    await db.purchaseOrderLine.deleteMany({ where: { variantId: { in: variantIds } } });
    await db.productVariant.deleteMany({ where: { id: { in: variantIds } } });
  }
  await db.purchaseOrder.deleteMany({ where: { number: { startsWith: prefix } } });
  await db.product.deleteMany({ where: { sku: { startsWith: prefix } } });
  await db.warehouse.deleteMany({ where: { code: { startsWith: prefix } } });
  await db.vendor.deleteMany({ where: { code: { startsWith: prefix } } });
  ok(`sweep complete for ${prefix}`);
}

async function main() {
  console.log(`\nVerify products-list extras — TAG=${TAG}`);
  await sweep(PREFIX);
  if (cleanupOnly) { await db.$disconnect(); return; }

  const vendor = await db.vendor.create({ data: { code: `${TAG}-VEN`, name: 'PLX Vendor' } });
  const wh = await db.warehouse.create({ data: { code: `${TAG}-WH`, name: 'PLX WH' } });
  const product = await db.product.create({
    data: { sku: `${TAG}-P`, name: 'PLX Product', manufacturerPartNumber: 'MPN-123', active: true },
  });
  const variant = await db.productVariant.create({
    data: { productId: product.id, sku: `${TAG}-V`, name: 'V' },
  });

  // Open POs: CONFIRMED line remaining 10-3=7; PARTIALLY_RECEIVED line
  // remaining 5-5=0; DRAFT line excluded entirely. Expected qtyOnPo = 7.
  const mkPo = async (n: string, status: 'CONFIRMED' | 'PARTIALLY_RECEIVED' | 'DRAFT', ordered: string, received: string) => {
    const po = await db.purchaseOrder.create({ data: { number: `${TAG}-${n}`, vendorId: vendor.id, status } });
    await db.purchaseOrderLine.create({
      data: {
        purchaseOrderId: po.id, variantId: variant.id, warehouseId: wh.id,
        qtyOrdered: D(ordered), qtyReceived: D(received), unitCost: D('12'),
      },
    });
  };
  await mkPo('PO1', 'CONFIRMED', '10', '3');
  await mkPo('PO2', 'PARTIALLY_RECEIVED', '5', '5');
  await mkPo('PO3', 'DRAFT', '4', '0');

  // FIFO layers → blended WAC = (4×10 + 6×15) / (4+6) = 130/10 = 13.
  const mkLayer = async (qty: string, cost: string) => {
    await db.fifoLayer.create({
      data: {
        variantId: variant.id, warehouseId: wh.id,
        qtyReceived: D(qty), qtyConsumed: D('0'), qtyRemaining: D(qty),
        unitCost: D(cost), receivedDate: new Date(),
      },
    });
  };
  await mkLayer('4', '10');
  await mkLayer('6', '15');

  console.log('\nSTAGE: includeCost = true');
  const withCost = await listProductsPaged(db, { q: TAG, status: 'all', includeCost: true });
  const row = withCost.rows.find((r) => r.id === product.id);
  if (!row) fail('product not found in list');
  if (row.qtyOnPo.toString() !== '7') fail(`qtyOnPo expected 7, got ${row.qtyOnPo.toString()}`);
  if (row.wac == null || row.wac.toString() !== '13') fail(`wac expected 13, got ${row.wac?.toString()}`);
  if (row.manufacturerPartNumber !== 'MPN-123') fail(`MPN expected MPN-123, got ${row.manufacturerPartNumber}`);
  ok(`qtyOnPo=7 (DRAFT + fully-received excluded), blended WAC=13, MPN=MPN-123`);

  console.log('\nSTAGE: includeCost = false (cost gating)');
  const noCost = await listProductsPaged(db, { q: TAG, status: 'all', includeCost: false });
  const row2 = noCost.rows.find((r) => r.id === product.id);
  if (!row2) fail('product not found in list');
  if (row2.wac !== null) fail(`wac must be null when includeCost=false, got ${row2.wac?.toString()}`);
  if (row2.qtyOnPo.toString() !== '7') fail(`qtyOnPo should still be 7, got ${row2.qtyOnPo.toString()}`);
  ok('WAC omitted (null) without cost permission; qtyOnPo still computed');

  await sweep(PREFIX);
  console.log('\n✅ Products-list extras verified.\n');
  await db.$disconnect();
}

main().catch(async (e) => {
  console.error('\n❌ verify failed:', e);
  await db.$disconnect();
  process.exit(1);
});
