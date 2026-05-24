/**
 * Verify the PO list "Balance" column + sort.
 *   npx tsx scripts/verify-po-balance-sort.ts            # verify + cleanup
 *   npx tsx scripts/verify-po-balance-sort.ts --cleanup-only
 *
 * Creates 3 POs for a scratch vendor with known balances, then checks
 * listPurchaseOrdersPaged({ sort: 'balance' }) orders them correctly and
 * purchaseOrderBalance computes the expected remaining balance.
 */
import { Prisma } from '../src/generated/tenant';
import { db } from '../src/lib/db';
import { createPurchaseOrder } from '../src/server/services/purchaseOrders';
import {
  listPurchaseOrdersPaged,
  purchaseOrderBalance,
} from '../src/server/services/purchaseOrders';
import { recordPoPayment } from '../src/server/services/poPayments';

const TAG = `SMOKE-POBAL-${Date.now()}`;
const PREFIX = 'SMOKE-POBAL-';
const cleanupOnly = process.argv.includes('--cleanup-only');

function ok(m: string) { console.log(`  [OK]   ${m}`); }
function fail(m: string): never { console.error(`  [FAIL] ${m}`); throw new Error(m); }

async function sweep(prefix: string) {
  const vendors = await db.vendor.findMany({
    where: { code: { startsWith: prefix } },
    select: { id: true },
  });
  const vendorIds = vendors.map((v) => v.id);
  if (vendorIds.length > 0) {
    const poPays = await db.poPayment.findMany({
      where: { vendorId: { in: vendorIds } },
      select: { id: true },
    });
    const poPayIds = poPays.map((p) => p.id);
    if (poPayIds.length > 0) {
      await db.poPayment.deleteMany({ where: { id: { in: poPayIds } } });
      const jes = await db.journalEntry.findMany({
        where: { entityType: 'PoPayment', entityId: { in: poPayIds } },
        select: { id: true },
      });
      const jeIds = jes.map((j) => j.id);
      if (jeIds.length > 0) {
        await db.journalEntryLine.deleteMany({ where: { journalEntryId: { in: jeIds } } });
        await db.journalEntry.deleteMany({ where: { id: { in: jeIds } } });
      }
      await db.auditLog.deleteMany({
        where: { entityType: 'PoPayment', entityId: { in: poPayIds } },
      });
    }
    const pos = await db.purchaseOrder.findMany({
      where: { vendorId: { in: vendorIds } },
      select: { id: true },
    });
    await db.auditLog.deleteMany({
      where: { entityType: 'PurchaseOrder', entityId: { in: pos.map((p) => p.id) } },
    });
  }
  const variants = await db.productVariant.findMany({
    where: { sku: { startsWith: prefix } },
    select: { id: true },
  });
  if (variants.length > 0) {
    await db.purchaseOrderLine.deleteMany({
      where: { variantId: { in: variants.map((v) => v.id) } },
    });
  }
  await db.purchaseOrder.deleteMany({ where: { vendor: { code: { startsWith: prefix } } } });
  if (variants.length > 0) {
    await db.productVariant.deleteMany({ where: { id: { in: variants.map((v) => v.id) } } });
  }
  await db.product.deleteMany({ where: { sku: { startsWith: prefix } } });
  await db.vendor.deleteMany({ where: { code: { startsWith: prefix } } });
  ok(`sweep complete for ${prefix}`);
}

async function main() {
  console.log(`\nVerify PO balance sort — TAG=${TAG}`);
  await sweep(PREFIX);
  if (cleanupOnly) { await db.$disconnect(); return; }

  const cash = await db.glAccount.findFirstOrThrow({ where: { code: '1110' } });
  const net30 = await db.paymentTerm.findFirstOrThrow({ where: { code: 'NET30' } });
  const wh = await db.warehouse.findFirstOrThrow({ where: { deletedAt: null } });
  const product = await db.product.create({ data: { sku: `${TAG}-P`, name: 'POBal P' } });
  const variant = await db.productVariant.create({
    data: { productId: product.id, sku: `${TAG}-V`, name: 'V' },
  });
  const vendor = await db.vendor.create({
    data: { code: `${TAG}-VEN`, name: 'POBal Vendor', paymentTermId: net30.id },
  });

  const mkPo = (qty: string, cost: string) =>
    createPurchaseOrder(db, {
      vendorId: vendor.id,
      lines: [{ variantId: variant.id, warehouseId: wh.id, qtyOrdered: qty, unitCost: cost }],
    });

  // A: total 100, no payment -> balance 100
  const a = await mkPo('10', '10');
  // B: total 50, deposit 50 -> balance 0 (fully paid)
  const b = await mkPo('5', '10');
  await recordPoPayment(db, b.id, { amount: '50', cashAccountId: cash.id });
  // C: total 200, deposit 30 -> balance 170
  const c = await mkPo('20', '10');
  await recordPoPayment(db, c.id, { amount: '30', cashAccountId: cash.id });

  const expected: Record<string, string> = { [a.id]: '100', [b.id]: '0', [c.id]: '170' };

  // Ascending: B(0), A(100), C(170)
  const asc = await listPurchaseOrdersPaged(db, { vendorId: vendor.id, sort: 'balance', dir: 'asc', take: 100 });
  const ascIds = asc.rows.map((r) => r.id);
  if (ascIds.join(',') !== [b.id, a.id, c.id].join(',')) {
    fail(`asc order wrong: ${JSON.stringify(ascIds)}`);
  }
  for (const r of asc.rows) {
    const bal = purchaseOrderBalance(r).toString();
    if (bal !== expected[r.id]) fail(`balance for ${r.number} expected ${expected[r.id]}, got ${bal}`);
  }
  ok(`ascending: ${asc.rows.map((r) => `${r.number}=${purchaseOrderBalance(r)}`).join(', ')}`);

  // Descending: C(170), A(100), B(0)
  const desc = await listPurchaseOrdersPaged(db, { vendorId: vendor.id, sort: 'balance', dir: 'desc', take: 100 });
  if (desc.rows.map((r) => r.id).join(',') !== [c.id, a.id, b.id].join(',')) {
    fail(`desc order wrong: ${JSON.stringify(desc.rows.map((r) => r.id))}`);
  }
  if (desc.total !== 3) fail(`desc total expected 3, got ${desc.total}`);
  ok(`descending: ${desc.rows.map((r) => `${r.number}=${purchaseOrderBalance(r)}`).join(', ')}`);

  // Pagination over the in-memory sort: take 2 desc -> [C, A], total 3.
  const page1 = await listPurchaseOrdersPaged(db, { vendorId: vendor.id, sort: 'balance', dir: 'desc', skip: 0, take: 2 });
  if (page1.rows.map((r) => r.id).join(',') !== [c.id, a.id].join(',') || page1.total !== 3) {
    fail(`paginated page1 wrong: ${JSON.stringify(page1.rows.map((r) => r.number))} total=${page1.total}`);
  }
  ok('pagination slices the in-memory balance sort correctly (page 1 of 2 = C, A; total 3)');

  await sweep(PREFIX);
  console.log('\n✅ PO balance sort verified.\n');
  await db.$disconnect();
}

main().catch(async (e) => {
  console.error('\n❌ verify failed:', e);
  await db.$disconnect();
  process.exit(1);
});
