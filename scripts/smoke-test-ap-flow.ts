/**
 * End-to-end smoke test for the Bills/AP slice (phase 8).
 *
 *   npx tsx scripts/smoke-test-ap-flow.ts                # full flow + cleanup
 *   npx tsx scripts/smoke-test-ap-flow.ts --keep         # full flow, leave rows behind
 *   npx tsx scripts/smoke-test-ap-flow.ts --cleanup-only # sweep stragglers
 *   npx tsx scripts/smoke-test-ap-flow.ts --verbose      # extra diagnostics
 *
 * Stages:
 *   1.  Sweep prior runs (TAG prefix SMOKE-AP-).
 *   2.  Ensure ephemeral vendor + warehouse + variant.
 *   3.  Create + confirm PO, then create + post receipt — verifies the
 *       AP slice C hook fires (auto-draft bill linked to the receipt).
 *   4.  Confirm the auto-drafted bill — JE DR 2020 / CR 2010 balanced.
 *   5.  Record partial payment — JE balanced, bill flips to PARTIAL.
 *   5.5 cancelBill MUST throw "applied payments or credits" — slice B guard.
 *   6.  Reverse the partial payment — bill flips back to UNPAID.
 *   7.  Record overpayment — auto-VC created with sourceTag, both JEs
 *       posted and balanced.
 *   8.  Create a second bill, apply the auto-VC to it (no JE on apply
 *       per spec).
 *   9.  Run AP aging — verify open balance + bucket assignment.
 *  10.  Cleanup (skipped under --keep).
 *
 * Re-runnable: prior-run stragglers are swept at start so failed runs
 * don't block subsequent ones.
 */

import {
  BillPaymentStatus,
  BillStatus,
  PaymentMethod,
  Prisma,
  ReceiptStatus,
  VendorCreditStatus,
} from '../src/generated/tenant';
import { db } from '../src/lib/db';
import {
  cancelBill,
  confirmBill,
  createBill,
} from '../src/server/services/bills';
import {
  recordBillPayment,
  reverseBillPayment,
} from '../src/server/services/billPayments';
import {
  applyVendorCreditToBill,
} from '../src/server/services/vendorCredits';
import { agingForVendor, apBalanceForVendor } from '../src/server/services/ap';
import {
  confirmPurchaseOrder,
  createPurchaseOrder,
} from '../src/server/services/purchaseOrders';
import {
  createDraftReceipt,
  postReceipt,
} from '../src/server/services/receipts';

// =============================================================================
// Config
// =============================================================================

const TAG_PREFIX = 'SMOKE-AP-';
const TAG = `${TAG_PREFIX}${Date.now()}`;
const PRODUCT_SKU = `${TAG}-PROD`;
const VARIANT_SKU = `${TAG}-V`;
const WAREHOUSE_CODE = `${TAG}-WH`;
const VENDOR_CODE = `${TAG}-VEN`;

const RECEIPT_QTY = '5';
const RECEIPT_UNIT_COST = '10'; // bill subtotal $50
const PARTIAL_PAYMENT = '30';
const OVERPAYMENT_AMOUNT = '60';

const args = new Set(process.argv.slice(2));
const FLAG_KEEP = args.has('--keep');
const FLAG_CLEANUP_ONLY = args.has('--cleanup-only');
const FLAG_VERBOSE = args.has('--verbose');

// =============================================================================
// Logging helpers
// =============================================================================

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
    fail(
      `${label}: expected ${expectedCount} JE(s), found ${jes.length}`,
    );
  }
  if (jes.length === 0) {
    fail(`${label}: no JEs posted for ${entityType}:${entityId}`);
  }
  for (const je of jes) {
    const dr = je.lines.reduce(
      (acc, l) => acc.plus(l.debit),
      new Prisma.Decimal(0),
    );
    const cr = je.lines.reduce(
      (acc, l) => acc.plus(l.credit),
      new Prisma.Decimal(0),
    );
    if (!dr.equals(cr)) {
      fail(
        `${label}: JE ${je.id} unbalanced — debits=${dr.toString()} credits=${cr.toString()}`,
      );
    }
    info(
      `JE ${je.id.slice(0, 8)} (${je.description}): debits=${dr.toString()} credits=${cr.toString()} ✓`,
    );
  }
  ok(`${label}: ${jes.length} JE(s), all balanced`);
}

// =============================================================================
// Cleanup
// =============================================================================

async function sweepCleanup(prefix: string): Promise<void> {
  const vendors = await db.vendor.findMany({
    where: { code: { startsWith: prefix } },
    select: { id: true, code: true },
  });
  if (vendors.length === 0) {
    info(`sweep: no vendors with prefix ${prefix}`);
  } else {
    console.log(`  sweeping ${vendors.length} vendor(s)…`);
    const vendorIds = vendors.map((v) => v.id);

    // Vendor credits + applications + JEs.
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
      if (apps.length > 0) {
        await db.auditLog.deleteMany({
          where: {
            entityType: 'VendorCreditApplication',
            entityId: { in: apps.map((a) => a.id) },
          },
        });
        await db.vendorCreditApplication.deleteMany({
          where: { id: { in: apps.map((a) => a.id) } },
        });
      }
      const vcJes = await db.journalEntry.findMany({
        where: { entityType: 'VendorCredit', entityId: { in: vcIds } },
        select: { id: true },
      });
      if (vcJes.length > 0) {
        const jeIds = vcJes.map((j) => j.id);
        await db.journalEntryLine.deleteMany({
          where: { journalEntryId: { in: jeIds } },
        });
        await db.journalEntry.deleteMany({ where: { id: { in: jeIds } } });
      }
      await db.vendorCreditLine.deleteMany({
        where: { vendorCreditId: { in: vcIds } },
      });
      await db.auditLog.deleteMany({
        where: { entityType: 'VendorCredit', entityId: { in: vcIds } },
      });
      await db.vendorCredit.deleteMany({ where: { id: { in: vcIds } } });
    }

    // Bill payments + JEs.
    const bps = await db.billPayment.findMany({
      where: { vendorId: { in: vendorIds } },
      select: { id: true },
    });
    const bpIds = bps.map((b) => b.id);
    if (bpIds.length > 0) {
      const bpJes = await db.journalEntry.findMany({
        where: { entityType: 'BillPayment', entityId: { in: bpIds } },
        select: { id: true },
      });
      if (bpJes.length > 0) {
        const jeIds = bpJes.map((j) => j.id);
        await db.journalEntryLine.deleteMany({
          where: { journalEntryId: { in: jeIds } },
        });
        await db.journalEntry.deleteMany({ where: { id: { in: jeIds } } });
      }
      await db.auditLog.deleteMany({
        where: { entityType: 'BillPayment', entityId: { in: bpIds } },
      });
      await db.billPayment.deleteMany({ where: { id: { in: bpIds } } });
    }

    // Bills + JEs + lines + joins (cascade handles BillReceipt + BillPurchaseOrder).
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

    // Receipts + lines + JEs (FIFO/movements/inventory items belong to
    // variant cleanup below).
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

    // POs + lines.
    const pos = await db.purchaseOrder.findMany({
      where: { vendorId: { in: vendorIds } },
      select: { id: true },
    });
    const poIds = pos.map((p) => p.id);
    if (poIds.length > 0) {
      await db.auditLog.deleteMany({
        where: { entityType: 'PurchaseOrder', entityId: { in: poIds } },
      });
    }
  }

  // Variants → movements + FIFO + inventory + receiptLines + POLines + variant.
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
      await db.fifoConsumption.deleteMany({
        where: { layerId: { in: layerIds } },
      });
      await db.auditLog.deleteMany({
        where: { entityType: 'FifoLayer', entityId: { in: layerIds } },
      });
      await db.fifoLayer.deleteMany({ where: { id: { in: layerIds } } });
    }
    const movements = await db.inventoryMovement.findMany({
      where: { variantId: { in: variantIds } },
      select: { id: true },
    });
    const movementIds = movements.map((m) => m.id);
    if (movementIds.length > 0) {
      await db.fifoConsumption.deleteMany({
        where: { movementId: { in: movementIds } },
      });
      await db.auditLog.deleteMany({
        where: { entityType: 'InventoryMovement', entityId: { in: movementIds } },
      });
    }
    await db.receiptLine.deleteMany({ where: { variantId: { in: variantIds } } });
    await db.inventoryMovement.deleteMany({
      where: { variantId: { in: variantIds } },
    });
    await db.inventoryItem.deleteMany({ where: { variantId: { in: variantIds } } });
    await db.purchaseOrderLine.deleteMany({
      where: { variantId: { in: variantIds } },
    });
  }

  // Receipts (now safe — no JEs/audit, no bills referencing).
  await db.receipt.deleteMany({ where: { vendor: { code: { startsWith: prefix } } } });
  // POs (lines deleted above).
  await db.purchaseOrder.deleteMany({
    where: { vendor: { code: { startsWith: prefix } } },
  });
  // Variants + products.
  if (variantIds.length > 0) {
    await db.productVariant.deleteMany({ where: { id: { in: variantIds } } });
  }
  await db.product.deleteMany({ where: { sku: { startsWith: prefix } } });
  // Warehouses.
  await db.warehouse.deleteMany({ where: { code: { startsWith: prefix } } });
  // Vendors.
  await db.vendor.deleteMany({ where: { code: { startsWith: prefix } } });

  ok(`sweep complete for prefix ${prefix}`);
}

// =============================================================================
// Main flow
// =============================================================================

async function main(): Promise<void> {
  console.log(`\nSmoke test: AP flow — TAG=${TAG}`);

  // -------- Sweep stragglers --------
  stage('SWEEP prior-run stragglers (TAG prefix only)');
  await sweepCleanup(TAG_PREFIX);

  if (FLAG_CLEANUP_ONLY) {
    console.log('\n--cleanup-only: done.\n');
    await db.$disconnect();
    return;
  }

  // -------- Setup --------
  stage('SETUP — vendor + warehouse + product/variant');
  const inventoryAccount = await db.glAccount.findFirstOrThrow({
    where: { code: '1310' },
  });
  const cashAccount = await db.glAccount.findFirstOrThrow({
    where: { code: '1110' },
  });
  const net30 = await db.paymentTerm.findFirstOrThrow({ where: { code: 'NET30' } });

  const wh = await db.warehouse.create({
    data: {
      code: WAREHOUSE_CODE,
      name: 'AP Smoke Warehouse',
      inventoryAccountId: inventoryAccount.id,
    },
  });
  const product = await db.product.create({
    data: { sku: PRODUCT_SKU, name: 'AP Smoke Product' },
  });
  const variant = await db.productVariant.create({
    data: { productId: product.id, sku: VARIANT_SKU, name: 'V' },
  });
  const vendor = await db.vendor.create({
    data: { code: VENDOR_CODE, name: 'AP Smoke Vendor', paymentTermId: net30.id },
  });
  ok(`vendor ${vendor.code}, warehouse ${wh.code}, variant ${variant.sku}`);

  // -------- PO + Receipt → auto-confirmed bill --------
  stage('PO + RECEIPT — postReceipt should auto-create AND auto-confirm a bill (slice C hook)');
  const po = await createPurchaseOrder(db, {
    vendorId: vendor.id,
    lines: [
      {
        variantId: variant.id,
        warehouseId: wh.id,
        qtyOrdered: RECEIPT_QTY,
        unitCost: RECEIPT_UNIT_COST,
      },
    ],
  });
  await confirmPurchaseOrder(db, po.id);
  const poFresh = await db.purchaseOrder.findUniqueOrThrow({
    where: { id: po.id },
    include: { lines: true },
  });
  const draft = await createDraftReceipt(db, {
    vendorId: vendor.id,
    warehouseId: wh.id,
    lines: [
      {
        purchaseOrderLineId: poFresh.lines[0].id,
        variantId: variant.id,
        warehouseId: wh.id,
        qtyReceived: RECEIPT_QTY,
        unitCost: RECEIPT_UNIT_COST,
      },
    ],
  });
  const posted = await postReceipt(db, draft.id);
  if (posted.status !== ReceiptStatus.POSTED) {
    fail(`receipt did not post: status=${posted.status}`);
  }
  ok(`receipt ${posted.number} POSTED`);

  const billLink = await db.billReceipt.findFirstOrThrow({
    where: { receiptId: posted.id },
  });
  const confirmed = await db.bill.findUniqueOrThrow({
    where: { id: billLink.billId },
    include: { lines: true, receipts: true, purchaseOrders: true },
  });
  // Auto-confirm runs inside postReceipt's tx, so the bill skips
  // DRAFT entirely. The DR 2020 / CR 2010 JE has already posted.
  if (confirmed.status !== BillStatus.CONFIRMED) {
    fail(`auto-bill not in CONFIRMED: ${confirmed.status}`);
  }
  if (confirmed.confirmedAt === null) {
    fail(`auto-bill confirmedAt not stamped`);
  }
  if (confirmed.dueDate === null) {
    fail(`auto-bill dueDate not computed at auto-confirm`);
  }
  if (confirmed.subtotal.toString() !== '50') {
    fail(`auto-bill subtotal mismatch: ${confirmed.subtotal.toString()} (expected 50)`);
  }
  if (confirmed.receipts.length !== 1) {
    fail(`auto-bill not linked to receipt`);
  }
  if (confirmed.purchaseOrders.length !== 1) {
    fail(`auto-bill not linked to PO`);
  }
  await assertJeBalanced('Bill', confirmed.id, 'Bill auto-confirm', 1);
  ok(
    `auto-created ${confirmed.number} (CONFIRMED, $50, linked to RCPT + PO, ` +
      `dueDate=${confirmed.dueDate?.toISOString().slice(0, 10)})`,
  );

  // -------- Partial payment --------
  stage('PARTIAL PAYMENT — bill flips to PARTIAL');
  const partial = await recordBillPayment(db, {
    billId: confirmed.id,
    amount: PARTIAL_PAYMENT,
    method: PaymentMethod.CHECK,
    cashAccountId: cashAccount.id,
    reference: 'CHK-SMOKE-1',
  });
  if (partial.overpaymentCredit !== null) {
    fail(`partial payment unexpectedly created an overpayment VC`);
  }
  await assertJeBalanced('BillPayment', partial.billPayment.id, 'Partial payment', 1);

  let billAfter = await db.bill.findUniqueOrThrow({ where: { id: confirmed.id } });
  if (billAfter.paymentStatus !== BillPaymentStatus.PARTIAL) {
    fail(`bill paymentStatus expected PARTIAL, got ${billAfter.paymentStatus}`);
  }
  if (billAfter.amountPaid.toString() !== '30') {
    fail(`amountPaid expected 30, got ${billAfter.amountPaid.toString()}`);
  }
  ok(`bill PARTIAL, amountPaid=$30`);

  // -------- Cancel guard --------
  stage('GUARD — cancelBill MUST throw with applied payments');
  let guardThrew = false;
  try {
    await cancelBill(db, confirmed.id, 'should refuse');
  } catch (e) {
    guardThrew = true;
    info(`guard threw as expected: ${(e as Error).message}`);
  }
  if (!guardThrew) {
    fail(`cancelBill did NOT throw on a bill with applied payment — slice B guard failed`);
  }
  ok(`cancelBill correctly refused`);

  // -------- Reverse partial --------
  stage('REVERSE partial payment — bill flips back to UNPAID');
  await reverseBillPayment(db, partial.billPayment.id, {
    reason: 'reverse for overpayment test',
  });
  await assertJeBalanced('BillPayment', partial.billPayment.id, 'Payment reverse', 2);
  billAfter = await db.bill.findUniqueOrThrow({ where: { id: confirmed.id } });
  if (billAfter.paymentStatus !== BillPaymentStatus.UNPAID) {
    fail(
      `bill paymentStatus expected UNPAID after reverse, got ${billAfter.paymentStatus}`,
    );
  }
  ok(`bill back to UNPAID, amountPaid=$0`);

  // -------- Overpayment → auto-VC --------
  stage('OVERPAYMENT — auto-creates CONFIRMED VC with sourceTag');
  const over = await recordBillPayment(db, {
    billId: confirmed.id,
    amount: OVERPAYMENT_AMOUNT,
    method: PaymentMethod.CHECK,
    cashAccountId: cashAccount.id,
    reference: 'CHK-SMOKE-OVER',
  });
  if (!over.overpaymentCredit) {
    fail(`overpayment did NOT create a vendor credit`);
  }
  if (over.overpaymentCredit.amount.toString() !== '10') {
    fail(`overpayment VC amount expected 10, got ${over.overpaymentCredit.amount.toString()}`);
  }
  if (over.overpaymentCredit.sourceTag !== `OVERPAYMENT:${over.billPayment.id}`) {
    fail(`overpayment VC sourceTag mismatch: ${over.overpaymentCredit.sourceTag}`);
  }
  if (over.overpaymentCredit.status !== VendorCreditStatus.CONFIRMED) {
    fail(`overpayment VC not CONFIRMED: ${over.overpaymentCredit.status}`);
  }
  await assertJeBalanced('BillPayment', over.billPayment.id, 'Overpayment payment', 1);
  await assertJeBalanced(
    'VendorCredit',
    over.overpaymentCredit.id,
    'Overpayment auto-VC confirm',
    1,
  );
  billAfter = await db.bill.findUniqueOrThrow({ where: { id: confirmed.id } });
  if (billAfter.paymentStatus !== BillPaymentStatus.PAID) {
    fail(`bill not PAID after overpayment, got ${billAfter.paymentStatus}`);
  }
  if (billAfter.amountPaid.toString() !== '50') {
    fail(`amountPaid expected to cap at 50, got ${billAfter.amountPaid.toString()}`);
  }
  ok(`bill PAID (amountPaid capped at $50), VC ${over.overpaymentCredit.number} for $10 CONFIRMED`);

  // -------- Apply VC to a second bill --------
  stage('APPLY VC to a second bill — pure denorm (no JE on apply)');
  const billB = await createBill(db, {
    vendorId: vendor.id,
    lines: [
      {
        variantId: variant.id,
        description: 'second bill for apply',
        qty: '1',
        unitCost: '25',
      },
    ],
  });
  const billBConfirmed = await confirmBill(db, billB.id);
  const application = await applyVendorCreditToBill(db, over.overpaymentCredit.id, {
    billId: billBConfirmed.id,
    amount: '10',
  });
  if (application.amount.toString() !== '10') {
    fail(`application amount mismatch: ${application.amount.toString()}`);
  }
  // Sanity: VC has only its confirm JE — no extra JE from apply.
  const vcJes = await db.journalEntry.findMany({
    where: { entityType: 'VendorCredit', entityId: over.overpaymentCredit.id },
  });
  if (vcJes.length !== 1) {
    fail(`apply posted an unexpected JE — VC has ${vcJes.length} JEs (expected 1, the confirm)`);
  }
  const billBAfter = await db.bill.findUniqueOrThrow({
    where: { id: billBConfirmed.id },
  });
  if (billBAfter.amountCredited.toString() !== '10') {
    fail(`billB amountCredited expected 10, got ${billBAfter.amountCredited.toString()}`);
  }
  if (billBAfter.paymentStatus !== BillPaymentStatus.PARTIAL) {
    fail(`billB paymentStatus expected PARTIAL, got ${billBAfter.paymentStatus}`);
  }
  ok(`VC applied $10 to billB; no JE; billB now PARTIAL ($25 - $10 = $15 remaining)`);

  // -------- AP aging --------
  stage('AP AGING — verify open balance + bucket');
  const balance = await apBalanceForVendor(db, vendor.id);
  if (balance.apBalance.toString() !== '15') {
    fail(`apBalance expected 15 (billB remaining), got ${balance.apBalance.toString()}`);
  }
  if (balance.unappliedCreditBalance.toString() !== '0') {
    fail(
      `unappliedCreditBalance expected 0 (full VC applied), got ${balance.unappliedCreditBalance.toString()}`,
    );
  }
  const aging = await agingForVendor(db, vendor.id);
  if (aging.bills.length !== 1) {
    fail(`aging expected 1 open bill, got ${aging.bills.length}`);
  }
  if (aging.bills[0].billId !== billBConfirmed.id) {
    fail(`aging bill mismatch`);
  }
  ok(
    `apBalance=$15, billB in bucket ${aging.bills[0].bucket} (daysPastDue=${aging.bills[0].daysPastDue})`,
  );

  // -------- Cleanup --------
  if (FLAG_KEEP) {
    console.log('\n--keep: leaving rows behind. TAG=' + TAG);
  } else {
    stage('CLEANUP');
    await sweepCleanup(TAG_PREFIX);
  }

  console.log('\n✅ AP smoke flow complete.\n');
  await db.$disconnect();
}

main().catch(async (e) => {
  console.error('\n❌ AP smoke flow failed:', e);
  await db.$disconnect();
  process.exit(1);
});
