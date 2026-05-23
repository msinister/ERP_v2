/**
 * End-to-end smoke test for the PO direct-payment (deposit) slice.
 *
 *   npx tsx scripts/smoke-test-po-deposit-flow.ts                # full flow + cleanup
 *   npx tsx scripts/smoke-test-po-deposit-flow.ts --keep         # leave rows behind
 *   npx tsx scripts/smoke-test-po-deposit-flow.ts --cleanup-only # sweep stragglers
 *   npx tsx scripts/smoke-test-po-deposit-flow.ts --verbose
 *
 * Stages:
 *   1. Sweep prior runs (TAG prefix SMOKE-PODEP-).
 *   2. Setup vendor + warehouse + variant. PO for 10 @ $10 = $100.
 *   3. Record an $80 deposit  -> DR 1510 / CR 1110, appliedAmount 0.
 *   4. Receipt #1 (5 @ $10) auto-bills $50 and auto-applies $50 of the
 *      deposit -> bill1 PAID, deposit appliedAmount 50.
 *   5. Receipt #2 (5 @ $10) auto-bills $50 and auto-applies the remaining
 *      $30 -> bill2 PARTIAL ($20 left), deposit appliedAmount 80 (full).
 *   6. cancelBill(bill1) MUST throw (amountDeposited > 0 guard).
 *   7. Void the deposit -> cascade-reverses both applications and the cash
 *      leg; both bills back to UNPAID; deposit REVERSED; account 1510 nets
 *      to zero across all the deposit's JEs; every JE balanced.
 *   8. Cleanup (skipped under --keep).
 */

import {
  BillPaymentStatus,
  BillStatus,
  PaymentMethod,
  PaymentStatus,
  Prisma,
} from '../src/generated/tenant';
import { db } from '../src/lib/db';
import { cancelBill } from '../src/server/services/bills';
import {
  confirmPurchaseOrder,
  createPurchaseOrder,
} from '../src/server/services/purchaseOrders';
import { createDraftReceipt, postReceipt } from '../src/server/services/receipts';
import { recordPoPayment, voidPoPayment } from '../src/server/services/poPayments';

const TAG_PREFIX = 'SMOKE-PODEP-';
const TAG = `${TAG_PREFIX}${Date.now()}`;
const PRODUCT_SKU = `${TAG}-PROD`;
const VARIANT_SKU = `${TAG}-V`;
const WAREHOUSE_CODE = `${TAG}-WH`;
const VENDOR_CODE = `${TAG}-VEN`;

const args = new Set(process.argv.slice(2));
const FLAG_KEEP = args.has('--keep');
const FLAG_CLEANUP_ONLY = args.has('--cleanup-only');
const FLAG_VERBOSE = args.has('--verbose');

let stageNum = 0;
function stage(label: string) {
  stageNum += 1;
  console.log('\n' + '='.repeat(64));
  console.log(`STAGE ${stageNum}: ${label}`);
  console.log('='.repeat(64));
}
function ok(msg: string) {
  console.log(`  [OK]   ${msg}`);
}
function fail(msg: string): never {
  console.error(`  [FAIL] ${msg}`);
  throw new Error(msg);
}
function info(msg: string, obj?: unknown) {
  if (FLAG_VERBOSE) {
    if (obj !== undefined) console.log(`  [info] ${msg}`, obj);
    else console.log(`  [info] ${msg}`);
  }
}

async function assertJeBalanced(
  entityType: string,
  entityId: string,
  label: string,
  expectedCount?: number,
): Promise<void> {
  const jes = await db.journalEntry.findMany({
    where: { entityType, entityId },
    include: { lines: true },
    orderBy: { createdAt: 'asc' },
  });
  if (expectedCount !== undefined && jes.length !== expectedCount) {
    fail(`${label}: expected ${expectedCount} JE(s), found ${jes.length}`);
  }
  if (jes.length === 0) fail(`${label}: no JEs for ${entityType}:${entityId}`);
  for (const je of jes) {
    const dr = je.lines.reduce((a, l) => a.plus(l.debit), new Prisma.Decimal(0));
    const cr = je.lines.reduce((a, l) => a.plus(l.credit), new Prisma.Decimal(0));
    if (!dr.equals(cr)) {
      fail(`${label}: JE ${je.id} unbalanced — dr=${dr} cr=${cr}`);
    }
    info(`JE ${je.id.slice(0, 8)} (${je.description}): dr=${dr} cr=${cr} ✓`);
  }
  ok(`${label}: ${jes.length} JE(s), all balanced`);
}

// Net (debits - credits) on a GL account across a set of operational
// entities. Used to prove 1510 returns to zero after a full void.
async function accountNet(
  accountCode: string,
  refs: Array<{ entityType: string; entityId: string }>,
): Promise<Prisma.Decimal> {
  const account = await db.glAccount.findFirstOrThrow({ where: { code: accountCode } });
  let net = new Prisma.Decimal(0);
  for (const ref of refs) {
    const jes = await db.journalEntry.findMany({
      where: { entityType: ref.entityType, entityId: ref.entityId },
      include: { lines: { where: { accountId: account.id } } },
    });
    for (const je of jes) {
      for (const l of je.lines) net = net.plus(l.debit).minus(l.credit);
    }
  }
  return net;
}

async function sweepCleanup(prefix: string): Promise<void> {
  const vendors = await db.vendor.findMany({
    where: { code: { startsWith: prefix } },
    select: { id: true },
  });
  const vendorIds = vendors.map((v) => v.id);

  if (vendorIds.length > 0) {
    // PO payments + applications + JEs (before bills/POs they reference).
    const poPays = await db.poPayment.findMany({
      where: { vendorId: { in: vendorIds } },
      select: { id: true },
    });
    const poPayIds = poPays.map((p) => p.id);
    if (poPayIds.length > 0) {
      const apps = await db.poPaymentApplication.findMany({
        where: { poPaymentId: { in: poPayIds } },
        select: { id: true },
      });
      const appIds = apps.map((a) => a.id);
      if (appIds.length > 0) {
        const appJes = await db.journalEntry.findMany({
          where: { entityType: 'PoPaymentApplication', entityId: { in: appIds } },
          select: { id: true },
        });
        if (appJes.length > 0) {
          const jeIds = appJes.map((j) => j.id);
          await db.journalEntryLine.deleteMany({
            where: { journalEntryId: { in: jeIds } },
          });
          await db.journalEntry.deleteMany({ where: { id: { in: jeIds } } });
        }
        await db.auditLog.deleteMany({
          where: { entityType: 'PoPaymentApplication', entityId: { in: appIds } },
        });
        await db.poPaymentApplication.deleteMany({ where: { id: { in: appIds } } });
      }
      // Delete poPayments BEFORE their JEs (PoPayment.journalEntryId FK).
      await db.poPayment.deleteMany({ where: { id: { in: poPayIds } } });
      const payJes = await db.journalEntry.findMany({
        where: { entityType: 'PoPayment', entityId: { in: poPayIds } },
        select: { id: true },
      });
      if (payJes.length > 0) {
        const jeIds = payJes.map((j) => j.id);
        await db.journalEntryLine.deleteMany({
          where: { journalEntryId: { in: jeIds } },
        });
        await db.journalEntry.deleteMany({ where: { id: { in: jeIds } } });
      }
      await db.auditLog.deleteMany({
        where: { entityType: 'PoPayment', entityId: { in: poPayIds } },
      });
    }

    // Bills + JEs + lines + joins.
    const bills = await db.bill.findMany({
      where: { vendorId: { in: vendorIds } },
      select: { id: true },
    });
    const billIds = bills.map((b) => b.id);
    if (billIds.length > 0) {
      const bJes = await db.journalEntry.findMany({
        where: { entityType: 'Bill', entityId: { in: billIds } },
        select: { id: true },
      });
      if (bJes.length > 0) {
        const jeIds = bJes.map((j) => j.id);
        await db.journalEntryLine.deleteMany({
          where: { journalEntryId: { in: jeIds } },
        });
        await db.journalEntry.deleteMany({ where: { id: { in: jeIds } } });
      }
      await db.billLine.deleteMany({ where: { billId: { in: billIds } } });
      await db.auditLog.deleteMany({
        where: { entityType: 'Bill', entityId: { in: billIds } },
      });
      await db.bill.deleteMany({ where: { id: { in: billIds } } });
    }

    // Receipts + JEs.
    const receipts = await db.receipt.findMany({
      where: { vendorId: { in: vendorIds } },
      select: { id: true },
    });
    const receiptIds = receipts.map((r) => r.id);
    if (receiptIds.length > 0) {
      const rJes = await db.journalEntry.findMany({
        where: { entityType: 'Receipt', entityId: { in: receiptIds } },
        select: { id: true },
      });
      if (rJes.length > 0) {
        const jeIds = rJes.map((j) => j.id);
        await db.journalEntryLine.deleteMany({
          where: { journalEntryId: { in: jeIds } },
        });
        await db.journalEntry.deleteMany({ where: { id: { in: jeIds } } });
      }
      await db.auditLog.deleteMany({
        where: { entityType: 'Receipt', entityId: { in: receiptIds } },
      });
    }

    const pos = await db.purchaseOrder.findMany({
      where: { vendorId: { in: vendorIds } },
      select: { id: true },
    });
    const poIds = pos.map((p) => p.id);
    if (poIds.length > 0) {
      await db.poShipment.deleteMany({ where: { purchaseOrderId: { in: poIds } } });
      await db.auditLog.deleteMany({
        where: { entityType: 'PurchaseOrder', entityId: { in: poIds } },
      });
    }
  }

  // Variant-scoped inventory artifacts.
  const variants = await db.productVariant.findMany({
    where: { sku: { startsWith: prefix } },
    select: { id: true },
  });
  const variantIds = variants.map((v) => v.id);
  if (variantIds.length > 0) {
    const layers = await db.fifoLayer.findMany({
      where: { variantId: { in: variantIds } },
      select: { id: true },
    });
    const layerIds = layers.map((l) => l.id);
    if (layerIds.length > 0) {
      await db.fifoConsumption.deleteMany({ where: { layerId: { in: layerIds } } });
      await db.fifoLayer.deleteMany({ where: { id: { in: layerIds } } });
    }
    await db.receiptLine.deleteMany({ where: { variantId: { in: variantIds } } });
    await db.inventoryMovement.deleteMany({ where: { variantId: { in: variantIds } } });
    await db.inventoryItem.deleteMany({ where: { variantId: { in: variantIds } } });
    await db.purchaseOrderLine.deleteMany({ where: { variantId: { in: variantIds } } });
  }

  await db.receipt.deleteMany({ where: { vendor: { code: { startsWith: prefix } } } });
  await db.purchaseOrder.deleteMany({
    where: { vendor: { code: { startsWith: prefix } } },
  });
  if (variantIds.length > 0) {
    await db.productVariant.deleteMany({ where: { id: { in: variantIds } } });
  }
  await db.product.deleteMany({ where: { sku: { startsWith: prefix } } });
  await db.warehouse.deleteMany({ where: { code: { startsWith: prefix } } });
  await db.vendor.deleteMany({ where: { code: { startsWith: prefix } } });
  ok(`sweep complete for prefix ${prefix}`);
}

async function main(): Promise<void> {
  console.log(`\nSmoke test: PO deposit flow — TAG=${TAG}`);

  stage('SWEEP prior-run stragglers');
  await sweepCleanup(TAG_PREFIX);
  if (FLAG_CLEANUP_ONLY) {
    console.log('\n--cleanup-only: done.\n');
    await db.$disconnect();
    return;
  }

  stage('SETUP — vendor + warehouse + variant; PO for 10 @ $10 = $100');
  const inventoryAccount = await db.glAccount.findFirstOrThrow({ where: { code: '1310' } });
  const cashAccount = await db.glAccount.findFirstOrThrow({ where: { code: '1110' } });
  const deposits = await db.glAccount.findFirstOrThrow({ where: { code: '1510' } });
  const net30 = await db.paymentTerm.findFirstOrThrow({ where: { code: 'NET30' } });

  const wh = await db.warehouse.create({
    data: { code: WAREHOUSE_CODE, name: 'PODep WH', inventoryAccountId: inventoryAccount.id },
  });
  const product = await db.product.create({ data: { sku: PRODUCT_SKU, name: 'PODep Product' } });
  const variant = await db.productVariant.create({
    data: { productId: product.id, sku: VARIANT_SKU, name: 'V' },
  });
  const vendor = await db.vendor.create({
    data: { code: VENDOR_CODE, name: 'PODep Vendor', paymentTermId: net30.id },
  });
  const po = await createPurchaseOrder(db, {
    vendorId: vendor.id,
    lines: [{ variantId: variant.id, warehouseId: wh.id, qtyOrdered: '10', unitCost: '10' }],
  });
  await confirmPurchaseOrder(db, po.id);
  const poFresh = await db.purchaseOrder.findUniqueOrThrow({
    where: { id: po.id },
    include: { lines: true },
  });
  ok(`vendor ${vendor.code}, deposits acct ${deposits.code}, PO ${po.number} confirmed`);

  stage('RECORD DEPOSIT — $80 wire (DR 1510 / CR 1110)');
  const { poPayment } = await recordPoPayment(db, po.id, {
    amount: '80',
    method: PaymentMethod.WIRE,
    cashAccountId: cashAccount.id,
    reference: 'WIRE-PODEP-1',
  });
  if (poPayment.appliedAmount.toString() !== '0') {
    fail(`fresh deposit appliedAmount expected 0, got ${poPayment.appliedAmount}`);
  }
  await assertJeBalanced('PoPayment', poPayment.id, 'Deposit record', 1);
  ok(`deposit ${poPayment.number} $80 RECORDED, unapplied`);

  stage('RECEIPT #1 (5 @ $10) — auto-bill $50, auto-apply $50 of deposit');
  const r1 = await createDraftReceipt(db, {
    vendorId: vendor.id,
    warehouseId: wh.id,
    lines: [
      {
        purchaseOrderLineId: poFresh.lines[0].id,
        variantId: variant.id,
        warehouseId: wh.id,
        qtyReceived: '5',
        unitCost: '10',
      },
    ],
  });
  await postReceipt(db, r1.id);
  const bill1Link = await db.billReceipt.findFirstOrThrow({ where: { receiptId: r1.id } });
  const bill1 = await db.bill.findUniqueOrThrow({ where: { id: bill1Link.billId } });
  if (bill1.status !== BillStatus.CONFIRMED) fail(`bill1 not CONFIRMED: ${bill1.status}`);
  if (bill1.amountDeposited.toString() !== '50') {
    fail(`bill1 amountDeposited expected 50, got ${bill1.amountDeposited}`);
  }
  if (bill1.paymentStatus !== BillPaymentStatus.PAID) {
    fail(`bill1 expected PAID, got ${bill1.paymentStatus}`);
  }
  let dep = await db.poPayment.findUniqueOrThrow({ where: { id: poPayment.id } });
  if (dep.appliedAmount.toString() !== '50') {
    fail(`deposit appliedAmount expected 50, got ${dep.appliedAmount}`);
  }
  const app1 = await db.poPaymentApplication.findFirstOrThrow({
    where: { poPaymentId: poPayment.id, billId: bill1.id, reversedAt: null },
  });
  await assertJeBalanced('PoPaymentApplication', app1.id, 'Apply #1', 1);
  ok(`bill1 ${bill1.number} PAID via $50 deposit apply; deposit appliedAmount=$50`);

  stage('RECEIPT #2 (5 @ $10) — auto-bill $50, auto-apply remaining $30');
  const r2 = await createDraftReceipt(db, {
    vendorId: vendor.id,
    warehouseId: wh.id,
    lines: [
      {
        purchaseOrderLineId: poFresh.lines[0].id,
        variantId: variant.id,
        warehouseId: wh.id,
        qtyReceived: '5',
        unitCost: '10',
      },
    ],
  });
  await postReceipt(db, r2.id);
  const bill2Link = await db.billReceipt.findFirstOrThrow({ where: { receiptId: r2.id } });
  const bill2 = await db.bill.findUniqueOrThrow({ where: { id: bill2Link.billId } });
  if (bill2.amountDeposited.toString() !== '30') {
    fail(`bill2 amountDeposited expected 30, got ${bill2.amountDeposited}`);
  }
  if (bill2.paymentStatus !== BillPaymentStatus.PARTIAL) {
    fail(`bill2 expected PARTIAL ($20 remaining), got ${bill2.paymentStatus}`);
  }
  dep = await db.poPayment.findUniqueOrThrow({ where: { id: poPayment.id } });
  if (dep.appliedAmount.toString() !== '80') {
    fail(`deposit appliedAmount expected 80 (fully applied), got ${dep.appliedAmount}`);
  }
  const app2 = await db.poPaymentApplication.findFirstOrThrow({
    where: { poPaymentId: poPayment.id, billId: bill2.id, reversedAt: null },
  });
  await assertJeBalanced('PoPaymentApplication', app2.id, 'Apply #2', 1);
  ok(`bill2 ${bill2.number} PARTIAL; remaining $30 of deposit applied; deposit fully applied ($80)`);

  stage('GUARD — cancelBill(bill1) MUST throw (amountDeposited > 0)');
  let threw = false;
  try {
    await cancelBill(db, bill1.id, 'should refuse');
  } catch (e) {
    threw = true;
    info(`guard threw: ${(e as Error).message}`);
  }
  if (!threw) fail('cancelBill did NOT refuse a bill with an applied deposit');
  ok('cancelBill correctly refused');

  stage('VOID DEPOSIT — cascade-unwind both applications + cash leg');
  await voidPoPayment(db, po.id, poPayment.id, { reason: 'smoke void' });
  dep = await db.poPayment.findUniqueOrThrow({ where: { id: poPayment.id } });
  if (dep.status !== PaymentStatus.REVERSED) fail(`deposit not REVERSED: ${dep.status}`);
  if (dep.appliedAmount.toString() !== '0') {
    fail(`deposit appliedAmount expected 0 after void, got ${dep.appliedAmount}`);
  }
  const bill1After = await db.bill.findUniqueOrThrow({ where: { id: bill1.id } });
  const bill2After = await db.bill.findUniqueOrThrow({ where: { id: bill2.id } });
  if (bill1After.amountDeposited.toString() !== '0' || bill1After.paymentStatus !== BillPaymentStatus.UNPAID) {
    fail(`bill1 not restored: amountDeposited=${bill1After.amountDeposited} status=${bill1After.paymentStatus}`);
  }
  if (bill2After.amountDeposited.toString() !== '0' || bill2After.paymentStatus !== BillPaymentStatus.UNPAID) {
    fail(`bill2 not restored: amountDeposited=${bill2After.amountDeposited} status=${bill2After.paymentStatus}`);
  }
  // 2 JEs each: deposit (record+reverse), each application (apply+reverse).
  await assertJeBalanced('PoPayment', poPayment.id, 'Deposit record+reverse', 2);
  await assertJeBalanced('PoPaymentApplication', app1.id, 'Apply #1 + reverse', 2);
  await assertJeBalanced('PoPaymentApplication', app2.id, 'Apply #2 + reverse', 2);
  const net1510 = await accountNet('1510', [
    { entityType: 'PoPayment', entityId: poPayment.id },
    { entityType: 'PoPaymentApplication', entityId: app1.id },
    { entityType: 'PoPaymentApplication', entityId: app2.id },
  ]);
  if (!net1510.equals(0)) {
    fail(`account 1510 net expected 0 after full void, got ${net1510}`);
  }
  ok('both bills back to UNPAID; deposit REVERSED; 1510 nets to $0; all JEs balanced');

  if (FLAG_KEEP) {
    console.log('\n--keep: leaving rows behind. TAG=' + TAG);
  } else {
    stage('CLEANUP');
    await sweepCleanup(TAG_PREFIX);
  }

  console.log('\n✅ PO deposit smoke flow complete.\n');
  await db.$disconnect();
}

main().catch(async (e) => {
  console.error('\n❌ PO deposit smoke flow failed:', e);
  await db.$disconnect();
  process.exit(1);
});
