/**
 * End-to-end smoke test for the Vendor Ledger (entityLedger service).
 *
 *   npx tsx scripts/smoke-test-vendor-ledger.ts            # full flow + cleanup
 *   npx tsx scripts/smoke-test-vendor-ledger.ts --keep     # leave rows behind
 *   npx tsx scripts/smoke-test-vendor-ledger.ts --cleanup-only
 *
 * Exercises the single-net-balance model + the overpayment double-count
 * guard. Scenario (PO 10 @ $10 = $100):
 *   - $30 PO deposit, then receipt #1 (5 @ $10) auto-bills $50 and
 *     auto-applies the deposit; pay the $20 remainder -> bill1 settled.
 *   - $15 manual vendor credit (unapplied) -> we're $15 in credit.
 *   - receipt #2 (5 @ $10) auto-bills $50; overpay $60 -> $10 overpayment
 *     vendor credit auto-created (must be balance-NEUTRAL in the ledger).
 *
 * Expected net balance = bills(100) − payments(80) − deposit(30)
 *   − manual VC(15) − overpayment VC(neutral) = −25  (i.e. $25 in our favor).
 */

import { Prisma } from '../src/generated/tenant';
import { db } from '../src/lib/db';
import {
  confirmPurchaseOrder,
  createPurchaseOrder,
} from '../src/server/services/purchaseOrders';
import { createDraftReceipt, postReceipt } from '../src/server/services/receipts';
import { recordPoPayment } from '../src/server/services/poPayments';
import { recordBillPayment } from '../src/server/services/billPayments';
import {
  confirmVendorCredit,
  createVendorCreditDraft,
} from '../src/server/services/vendorCredits';
import { getVendorLedger } from '../src/server/services/entityLedger';

const TAG_PREFIX = 'SMOKE-VLED-';
const TAG = `${TAG_PREFIX}${Date.now()}`;

const args = new Set(process.argv.slice(2));
const FLAG_KEEP = args.has('--keep');
const FLAG_CLEANUP_ONLY = args.has('--cleanup-only');

let stageNum = 0;
function stage(label: string) {
  stageNum += 1;
  console.log('\n' + '='.repeat(60) + `\nSTAGE ${stageNum}: ${label}\n` + '='.repeat(60));
}
function ok(msg: string) {
  console.log(`  [OK]   ${msg}`);
}
function fail(msg: string): never {
  console.error(`  [FAIL] ${msg}`);
  throw new Error(msg);
}

async function sweep(prefix: string): Promise<void> {
  const vendors = await db.vendor.findMany({
    where: { code: { startsWith: prefix } },
    select: { id: true },
  });
  const vendorIds = vendors.map((v) => v.id);
  const delJEs = async (entityType: string, ids: string[]) => {
    if (ids.length === 0) return;
    const jes = await db.journalEntry.findMany({
      where: { entityType, entityId: { in: ids } },
      select: { id: true },
    });
    const jeIds = jes.map((j) => j.id);
    if (jeIds.length > 0) {
      await db.journalEntryLine.deleteMany({ where: { journalEntryId: { in: jeIds } } });
      await db.journalEntry.deleteMany({ where: { id: { in: jeIds } } });
    }
    await db.auditLog.deleteMany({ where: { entityType, entityId: { in: ids } } });
  };

  if (vendorIds.length > 0) {
    // PO payments + applications.
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
      await delJEs('PoPaymentApplication', appIds);
      await db.poPaymentApplication.deleteMany({ where: { id: { in: appIds } } });
      await db.poPayment.deleteMany({ where: { id: { in: poPayIds } } });
      await delJEs('PoPayment', poPayIds);
    }

    // Vendor credits + applications.
    const vcs = await db.vendorCredit.findMany({
      where: { vendorId: { in: vendorIds } },
      select: { id: true },
    });
    const vcIds = vcs.map((v) => v.id);
    if (vcIds.length > 0) {
      const apps = await db.vendorCreditApplication.findMany({
        where: { vendorCreditId: { in: vcIds } },
        select: { id: true },
      });
      const appIds = apps.map((a) => a.id);
      await delJEs('VendorCreditApplication', appIds);
      await db.vendorCreditApplication.deleteMany({ where: { id: { in: appIds } } });
      await delJEs('VendorCredit', vcIds);
      await db.vendorCreditLine.deleteMany({ where: { vendorCreditId: { in: vcIds } } });
      await db.vendorCredit.deleteMany({ where: { id: { in: vcIds } } });
    }

    // Bill payments.
    const bps = await db.billPayment.findMany({
      where: { vendorId: { in: vendorIds } },
      select: { id: true },
    });
    const bpIds = bps.map((b) => b.id);
    if (bpIds.length > 0) {
      await delJEs('BillPayment', bpIds);
      await db.billPayment.deleteMany({ where: { id: { in: bpIds } } });
    }

    // Bills.
    const bills = await db.bill.findMany({
      where: { vendorId: { in: vendorIds } },
      select: { id: true },
    });
    const billIds = bills.map((b) => b.id);
    if (billIds.length > 0) {
      await delJEs('Bill', billIds);
      await db.billLine.deleteMany({ where: { billId: { in: billIds } } });
      await db.bill.deleteMany({ where: { id: { in: billIds } } });
    }

    // Receipts.
    const receipts = await db.receipt.findMany({
      where: { vendorId: { in: vendorIds } },
      select: { id: true },
    });
    const receiptIds = receipts.map((r) => r.id);
    await delJEs('Receipt', receiptIds);

    const pos = await db.purchaseOrder.findMany({
      where: { vendorId: { in: vendorIds } },
      select: { id: true },
    });
    await delJEs('PurchaseOrder', pos.map((p) => p.id));
  }

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
  await db.purchaseOrder.deleteMany({ where: { vendor: { code: { startsWith: prefix } } } });
  if (variantIds.length > 0) {
    await db.productVariant.deleteMany({ where: { id: { in: variantIds } } });
  }
  await db.product.deleteMany({ where: { sku: { startsWith: prefix } } });
  await db.warehouse.deleteMany({ where: { code: { startsWith: prefix } } });
  await db.vendor.deleteMany({ where: { code: { startsWith: prefix } } });
  ok(`sweep complete for ${prefix}`);
}

async function main(): Promise<void> {
  console.log(`\nSmoke test: vendor ledger — TAG=${TAG}`);
  stage('SWEEP prior runs');
  await sweep(TAG_PREFIX);
  if (FLAG_CLEANUP_ONLY) {
    await db.$disconnect();
    return;
  }

  stage('SETUP + activity');
  const inv = await db.glAccount.findFirstOrThrow({ where: { code: '1310' } });
  const cash = await db.glAccount.findFirstOrThrow({ where: { code: '1110' } });
  const net30 = await db.paymentTerm.findFirstOrThrow({ where: { code: 'NET30' } });
  const wh = await db.warehouse.create({
    data: { code: `${TAG}-WH`, name: 'VLed WH', inventoryAccountId: inv.id },
  });
  const product = await db.product.create({ data: { sku: `${TAG}-P`, name: 'VLed P' } });
  const variant = await db.productVariant.create({
    data: { productId: product.id, sku: `${TAG}-V`, name: 'V' },
  });
  const vendor = await db.vendor.create({
    data: { code: `${TAG}-VEN`, name: 'VLed Vendor', paymentTermId: net30.id },
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
  const poLineId = poFresh.lines[0].id;

  // $30 deposit, receipt #1 -> bill1 $50 (auto-apply $30), pay $20 remainder.
  await recordPoPayment(db, po.id, { amount: '30', cashAccountId: cash.id });
  const r1 = await createDraftReceipt(db, {
    vendorId: vendor.id,
    warehouseId: wh.id,
    lines: [{ purchaseOrderLineId: poLineId, variantId: variant.id, warehouseId: wh.id, qtyReceived: '5', unitCost: '10' }],
  });
  await postReceipt(db, r1.id);
  const bill1 = await db.bill.findFirstOrThrow({
    where: { receipts: { some: { receipt: { id: r1.id } } } },
  });
  await recordBillPayment(db, { billId: bill1.id, amount: '20', method: 'CHECK', cashAccountId: cash.id });

  // $15 manual vendor credit (unapplied).
  const vc = await createVendorCreditDraft(db, {
    vendorId: vendor.id,
    lines: [{ description: 'manual credit', amount: '15' }],
  });
  await confirmVendorCredit(db, vc.id);

  // receipt #2 -> bill2 $50, overpay $60 -> $10 overpayment VC (neutral).
  const r2 = await createDraftReceipt(db, {
    vendorId: vendor.id,
    warehouseId: wh.id,
    lines: [{ purchaseOrderLineId: poLineId, variantId: variant.id, warehouseId: wh.id, qtyReceived: '5', unitCost: '10' }],
  });
  await postReceipt(db, r2.id);
  const bill2 = await db.bill.findFirstOrThrow({
    where: { receipts: { some: { receipt: { id: r2.id } } } },
  });
  const over = await recordBillPayment(db, { billId: bill2.id, amount: '60', method: 'CHECK', cashAccountId: cash.id });
  if (!over.overpaymentCredit) fail('expected an overpayment vendor credit');
  ok('built: 2 bills, deposit, 2 payments, 1 manual VC, 1 overpayment VC');

  stage('LEDGER — assert net balance + row directions');
  const ledger = await getVendorLedger(db, vendor.id, { sort: 'oldest', take: 1000 });

  const byType = (t: string) => ledger.rows.filter((r) => r.type === t);
  const sumDebit = ledger.rows.reduce((a, r) => a.plus(r.debit), new Prisma.Decimal(0));
  const sumCredit = ledger.rows.reduce((a, r) => a.plus(r.credit), new Prisma.Decimal(0));

  // Net balance.
  if (!ledger.currentBalance.equals(new Prisma.Decimal('-25'))) {
    fail(`currentBalance expected -25, got ${ledger.currentBalance.toString()}`);
  }
  // Bills are debits totalling 100.
  const billDebits = byType('BILL').reduce((a, r) => a.plus(r.debit), new Prisma.Decimal(0));
  if (!billDebits.equals(100)) fail(`bill debits expected 100, got ${billDebits}`);
  // Deposit is a credit of 30.
  const deposit = byType('PO_DEPOSIT');
  if (deposit.length !== 1 || !deposit[0].credit.equals(30)) {
    fail(`expected one $30 deposit credit, got ${JSON.stringify(deposit.map((d) => d.credit.toString()))}`);
  }
  // Bill payments are credits totalling 80.
  const payCredits = byType('BILL_PAYMENT').reduce((a, r) => a.plus(r.credit), new Prisma.Decimal(0));
  if (!payCredits.equals(80)) fail(`payment credits expected 80, got ${payCredits}`);
  // Manual VC is a $15 credit; overpayment VC is balance-neutral.
  const vcs = byType('VENDOR_CREDIT');
  const manualVc = vcs.find((r) => r.credit.equals(15));
  const overVc = vcs.find((r) => r.description.includes('overpayment'));
  if (!manualVc) fail('expected a $15 manual vendor-credit row');
  if (!overVc) fail('expected an overpayment vendor-credit row');
  if (!overVc.debit.equals(0) || !overVc.credit.equals(0)) {
    fail(`overpayment VC must be balance-neutral, got debit=${overVc.debit} credit=${overVc.credit}`);
  }
  // Deposit application is balance-neutral.
  const depApp = byType('PO_DEPOSIT_APPLIED');
  if (depApp.length !== 1 || !depApp[0].debit.equals(0) || !depApp[0].credit.equals(0)) {
    fail('expected one balance-neutral deposit-applied row');
  }
  // Total debits/credits sanity: 100 debit, 30+80+15 = 125 credit, net -25.
  if (!sumDebit.equals(100)) fail(`total debits expected 100, got ${sumDebit}`);
  if (!sumCredit.equals(125)) fail(`total credits expected 125, got ${sumCredit}`);
  ok(`net balance -25 (= $25 in our favor); bills +100, deposit/payments/VC −125; overpayment VC + deposit-applied neutral`);

  stage('LEDGER — type filter keeps all-time running balance');
  const filtered = await getVendorLedger(db, vendor.id, { type: 'BILL_PAYMENT', take: 1000 });
  if (filtered.rows.length !== 2) fail(`expected 2 payment rows, got ${filtered.rows.length}`);
  if (!filtered.currentBalance.equals(new Prisma.Decimal('-25'))) {
    fail(`filtered currentBalance should stay -25, got ${filtered.currentBalance}`);
  }
  if (!filtered.windowDebits.equals(0) || !filtered.windowCredits.equals(80)) {
    fail(`filtered window totals expected debits 0 / credits 80, got ${filtered.windowDebits}/${filtered.windowCredits}`);
  }
  ok('type filter shows 2 payment rows, window credits $80, all-time balance still -25');

  if (FLAG_KEEP) {
    console.log('\n--keep: leaving rows behind. TAG=' + TAG);
  } else {
    stage('CLEANUP');
    await sweep(TAG_PREFIX);
  }
  console.log('\n✅ Vendor ledger smoke flow complete.\n');
  await db.$disconnect();
}

main().catch(async (e) => {
  console.error('\n❌ Vendor ledger smoke flow failed:', e);
  await db.$disconnect();
  process.exit(1);
});
