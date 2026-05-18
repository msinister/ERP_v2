/**
 * End-to-end smoke test for the GL/Reports/Period-Close arc (phase 9).
 *
 *   npx tsx scripts/smoke-test-financial-close.ts                # full flow + cleanup
 *   npx tsx scripts/smoke-test-financial-close.ts --keep         # leave rows behind
 *   npx tsx scripts/smoke-test-financial-close.ts --cleanup-only # sweep stragglers
 *   npx tsx scripts/smoke-test-financial-close.ts --verbose
 *
 * Stages:
 *   1.  Sweep prior-run stragglers.
 *   2.  Setup: vendor + customer + warehouse + product/variant.
 *   3.  Receive inventory (creates FIFO layer + GL Inventory leg + auto-confirmed bill).
 *   4.  Pay the auto-confirmed bill (DR Inventory cleared on confirm + AP paid).
 *   5.  Sell inventory: SO → confirm → close → invoice generated.
 *   6.  Receive customer payment.
 *   7.  Run financial reports (TB, BS, IS, GL detail, journal).
 *   8.  Run operational reports (sales by customer + by item, inventory valuation).
 *   9.  Run dashboard widgets.
 *  10.  Run reconciliation checks for the period.
 *  11.  Soft-close → hard-close (with override since real DB has cross-test state).
 *  12.  Try posting into HARD_CLOSED period → blocked.
 *  13.  Override post → allowed + audit captured.
 *  14.  Reopen period.
 *  15.  Cleanup (skipped under --keep).
 */

import { Prisma, PaymentMethod } from '../src/generated/tenant';
import { db } from '../src/lib/db';
import { post } from '../src/lib/gl/post';
import {
  closeSalesOrder,
  confirmSalesOrder,
  createSalesOrder,
} from '../src/server/services/salesOrders';
import { recordPayment } from '../src/server/services/payments';
import {
  confirmPurchaseOrder,
  createPurchaseOrder,
} from '../src/server/services/purchaseOrders';
import {
  createDraftReceipt,
  postReceipt,
} from '../src/server/services/receipts';
import { cancelBill } from '../src/server/services/bills';
import {
  recordBillPayment,
} from '../src/server/services/billPayments';
import {
  getOrCreatePeriodForDate,
  hardClosePeriod,
  reopenPeriod,
  softClosePeriod,
} from '../src/server/services/fiscalPeriods';
import { runAllReconChecks } from '../src/server/services/reconciliation';
import {
  balanceSheet,
  glDetail,
  incomeStatement,
  journalReport,
  trialBalance,
} from '../src/server/services/reports/financial';
import {
  cashPosition,
  inventoryValuation,
  salesByCustomer,
  salesByItem,
} from '../src/server/services/reports/operational';
import {
  apAgingWidget,
  arAgingWidget,
  cashPositionWidget,
  openPosWidget,
  openSosWidget,
  todaysSalesWidget,
} from '../src/server/services/reports/dashboard';
import { createCustomer } from '../src/server/services/customers';

// =============================================================================
// Config
// =============================================================================

const TAG_PREFIX = 'SMOKE-FCL-';
const TAG = `${TAG_PREFIX}${Date.now()}`;
const PRODUCT_SKU = `${TAG}-PROD`;
const VARIANT_SKU = `${TAG}-V`;
const WAREHOUSE_CODE = `${TAG}-WH`;
const VENDOR_CODE = `${TAG}-VEN`;

const RECEIVE_QTY = '20';
const RECEIVE_UNIT_COST = '5';   // bill subtotal $100
const SELL_QTY = '8';
const SELL_UNIT_PRICE = '15';    // invoice line $120
const PAYMENT_AMOUNT = '120';

const args = new Set(process.argv.slice(2));
const FLAG_KEEP = args.has('--keep');
const FLAG_CLEANUP_ONLY = args.has('--cleanup-only');
const FLAG_VERBOSE = args.has('--verbose');

// =============================================================================
// Logging
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

// =============================================================================
// Cleanup
// =============================================================================

async function sweepCleanup(prefix: string): Promise<void> {
  // Customers
  const customers = await db.customer.findMany({
    where: { name: { startsWith: prefix } },
    select: { id: true },
  });
  const customerIds = customers.map((c) => c.id);

  // Vendors
  const vendors = await db.vendor.findMany({
    where: { code: { startsWith: prefix } },
    select: { id: true },
  });
  const vendorIds = vendors.map((v) => v.id);

  if (customerIds.length === 0 && vendorIds.length === 0) {
    info(`sweep: nothing for prefix ${prefix}`);
    return;
  }

  console.log(`  sweeping ${customerIds.length} customer(s) + ${vendorIds.length} vendor(s)…`);

  // SOs + invoices + payments + JEs (customer side).
  if (customerIds.length > 0) {
    const sos = await db.salesOrder.findMany({
      where: { customerId: { in: customerIds } },
      select: { id: true },
    });
    const soIds = sos.map((s) => s.id);
    const invoices = await db.invoice.findMany({
      where: { salesOrderId: { in: soIds } },
      select: { id: true },
    });
    const invIds = invoices.map((i) => i.id);
    const payments = await db.payment.findMany({
      where: { customerId: { in: customerIds } },
      select: { id: true },
    });
    const pmtIds = payments.map((p) => p.id);

    // Drop JEs by entity.
    for (const [type, ids] of [
      ['Invoice', invIds],
      ['Payment', pmtIds],
      ['SalesOrder', soIds],
    ] as const) {
      if (ids.length === 0) continue;
      const jes = await db.journalEntry.findMany({
        where: { entityType: type, entityId: { in: ids } },
        select: { id: true },
      });
      if (jes.length > 0) {
        const jeIds = jes.map((j) => j.id);
        await db.journalEntryLine.deleteMany({
          where: { journalEntryId: { in: jeIds } },
        });
        await db.journalEntry.deleteMany({ where: { id: { in: jeIds } } });
      }
      await db.auditLog.deleteMany({
        where: { entityType: type, entityId: { in: ids } },
      });
    }
    if (pmtIds.length > 0) {
      await db.creditApplication.deleteMany({ where: { paymentId: { in: pmtIds } } });
      await db.payment.deleteMany({ where: { id: { in: pmtIds } } });
    }
    if (invIds.length > 0) {
      await db.creditApplication.deleteMany({ where: { invoiceId: { in: invIds } } });
      await db.invoiceLine.deleteMany({ where: { invoiceId: { in: invIds } } });
      await db.invoice.deleteMany({ where: { id: { in: invIds } } });
    }
    if (soIds.length > 0) {
      await db.salesOrderLine.deleteMany({ where: { salesOrderId: { in: soIds } } });
      await db.salesOrder.deleteMany({ where: { id: { in: soIds } } });
    }
    await db.customerActivity.deleteMany({ where: { customerId: { in: customerIds } } });
    await db.customerAddress.deleteMany({ where: { customerId: { in: customerIds } } });
    await db.auditLog.deleteMany({
      where: { entityType: 'Customer', entityId: { in: customerIds } },
    });
    await db.customer.deleteMany({ where: { id: { in: customerIds } } });
  }

  // Vendor-side cleanup (mirror smoke-test-ap-flow.ts approach).
  if (vendorIds.length > 0) {
    // Vendor credits + apps + JEs.
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
        const appIds = apps.map((a) => a.id);
        await db.auditLog.deleteMany({
          where: {
            entityType: 'VendorCreditApplication',
            entityId: { in: appIds },
          },
        });
        await db.vendorCreditApplication.deleteMany({
          where: { id: { in: appIds } },
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
    // Receipts + lines + JEs.
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
    // POs.
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

  // Variants + movements + layers (scoped to test variant SKU).
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
      await db.fifoConsumption.deleteMany({ where: { movementId: { in: movementIds } } });
      await db.auditLog.deleteMany({
        where: { entityType: 'InventoryMovement', entityId: { in: movementIds } },
      });
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

  ok(`sweep complete for prefix ${prefix}`);
}

// =============================================================================
// Main
// =============================================================================

async function main(): Promise<void> {
  console.log(`\nSmoke test: financial close — TAG=${TAG}`);

  stage('SWEEP prior-run stragglers');
  await sweepCleanup(TAG_PREFIX);

  if (FLAG_CLEANUP_ONLY) {
    console.log('\n--cleanup-only: done.\n');
    await db.$disconnect();
    return;
  }

  // -------- Setup --------
  stage('SETUP');
  const inventoryAccount = await db.glAccount.findFirstOrThrow({ where: { code: '1310' } });
  const cashAccount = await db.glAccount.findFirstOrThrow({ where: { code: '1110' } });
  const apAccount = await db.glAccount.findFirstOrThrow({ where: { code: '2010' } });
  void apAccount;

  const net30 = await db.paymentTerm.findFirstOrThrow({ where: { code: 'NET30' } });
  const salesRep = await db.salesRep.findFirstOrThrow({ where: { code: 'UNASSIGNED' } });

  const wh = await db.warehouse.create({
    data: {
      code: WAREHOUSE_CODE,
      name: 'Smoke Close Warehouse',
      inventoryAccountId: inventoryAccount.id,
    },
  });
  const product = await db.product.create({
    data: {
      sku: PRODUCT_SKU,
      name: 'Smoke Close Product',
      basePrice: new Prisma.Decimal(SELL_UNIT_PRICE),
    },
  });
  const variant = await db.productVariant.create({
    data: { productId: product.id, sku: VARIANT_SKU, name: 'V' },
  });
  const vendor = await db.vendor.create({
    data: { code: VENDOR_CODE, name: 'Smoke Close Vendor', paymentTermId: net30.id },
  });
  const customer = await createCustomer(db, {
    name: `${TAG} Customer`,
    salesRepId: salesRep.id,
    paymentTermId: net30.id,
    billingAddress: {
      kind: 'BILLING',
      line1: '1 Smoke St',
      city: 'Dallas',
      region: 'TX',
      postalCode: '75201',
    },
  });
  ok(`vendor ${vendor.code}, customer ${customer.code}, warehouse ${wh.code}, variant ${variant.sku}`);

  // -------- Receive inventory --------
  stage('RECEIVE inventory (PO → receipt → auto-confirmed bill + GL Inventory leg)');
  const po = await createPurchaseOrder(db, {
    vendorId: vendor.id,
    lines: [
      {
        variantId: variant.id,
        warehouseId: wh.id,
        qtyOrdered: RECEIVE_QTY,
        unitCost: RECEIVE_UNIT_COST,
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
        qtyReceived: RECEIVE_QTY,
        unitCost: RECEIVE_UNIT_COST,
      },
    ],
  });
  const posted = await postReceipt(db, draft.id);
  ok(`receipt ${posted.number} POSTED — qty ${RECEIVE_QTY} @ $${RECEIVE_UNIT_COST}`);

  const billLink = await db.billReceipt.findFirstOrThrow({ where: { receiptId: posted.id } });
  // postReceipt auto-confirms the draft bill in the same tx, so the
  // bill is already CONFIRMED with its AP JE posted. No manual
  // confirmBill needed before recordBillPayment.
  ok(`auto-confirmed bill linked to ${posted.number}`);

  await recordBillPayment(db, {
    billId: billLink.billId,
    amount: '100',
    method: PaymentMethod.CHECK,
    cashAccountId: cashAccount.id,
    reference: 'CHK-SMK-1',
  });
  ok(`bill paid $100 (cash out)`);

  // -------- Sell inventory --------
  stage('SELL inventory (SO → confirm → close → invoice)');
  const so = await createSalesOrder(db, {
    customerId: customer.id,
    warehouseId: wh.id,
    lines: [{ variantId: variant.id, warehouseId: wh.id, qtyOrdered: SELL_QTY, manualUnitPrice: SELL_UNIT_PRICE }],
  });
  await confirmSalesOrder(db, so.id);
  await closeSalesOrder(db, so.id, undefined);
  const invoice = await db.invoice.findFirstOrThrow({
    where: { salesOrderId: so.id },
    include: { lines: { where: { deletedAt: null } } },
  });
  ok(`invoice ${invoice.number} OPEN — total $${invoice.total.toString()}`);

  // -------- Customer payment --------
  stage('CUSTOMER PAYMENT');
  await recordPayment(db, {
    customerId: customer.id,
    method: PaymentMethod.ACH,
    amount: PAYMENT_AMOUNT,
    applications: [{ invoiceId: invoice.id, amount: PAYMENT_AMOUNT }],
  });
  ok(`payment $${PAYMENT_AMOUNT} ACH applied to invoice ${invoice.number}`);

  // -------- Financial reports --------
  stage('FINANCIAL REPORTS — TB, BS, IS, GL detail, journal');
  const periodEnd = new Date(Date.UTC(2099, 0, 1)); // far future; covers all activity
  const tb = await trialBalance(db, { to: periodEnd });
  if (!tb.totals.totalEndingDebit.equals(tb.totals.totalEndingCredit)) {
    fail(`Trial Balance not balanced: dr=${tb.totals.totalEndingDebit} cr=${tb.totals.totalEndingCredit}`);
  }
  ok(`trial balance: dr=cr=$${tb.totals.totalEndingDebit.toString()}, ${tb.rows.length} rows`);

  const bs = await balanceSheet(db, periodEnd);
  if (!bs.imbalance.equals(0)) {
    fail(`Balance sheet imbalance: ${bs.imbalance.toString()}`);
  }
  ok(`balance sheet: A=$${bs.assets.total} L=$${bs.liabilities.total} E=$${bs.equity.total} balanced`);

  const is = await incomeStatement(db, { to: periodEnd });
  ok(`income statement: revenue=$${is.revenue.total} expenses=$${is.expenses.total} net=$${is.netIncome}`);

  const gl = await glDetail(db, { accountCode: '1110', to: periodEnd });
  ok(`GL detail 1110: ${gl.rows.length} row(s), ending balance $${gl.endingBalance.toString()}`);

  const journal = await journalReport(db, { to: periodEnd, take: 5 });
  ok(`journal report: ${journal.entries.length} entry(s) (limit 5)`);

  // -------- Operational reports --------
  stage('OPERATIONAL REPORTS — sales, inventory, cash');
  const salesC = await salesByCustomer(db, { to: periodEnd });
  ok(`sales by customer: ${salesC.rows.length} customer(s), total $${salesC.totalGrossSales.toString()}`);

  const salesI = await salesByItem(db, { to: periodEnd });
  ok(`sales by item: ${salesI.rows.length} item(s), total $${salesI.totalGrossSales.toString()}`);

  const inv = await inventoryValuation(db, { warehouseId: wh.id });
  if (inv.rows.length === 0) fail(`inventory valuation empty for our warehouse`);
  ok(`inventory valuation (${wh.code}): ${inv.rows.length} variant(s), total $${inv.totalValue.toString()}`);

  const cash = await cashPosition(db);
  ok(`cash position: $${cash.glBalance.toString()}`);

  // -------- Dashboard widgets --------
  stage('DASHBOARD WIDGETS');
  const sos = await openSosWidget(db);
  const pos = await openPosWidget(db);
  const ts = await todaysSalesWidget(db);
  const cw = await cashPositionWidget(db);
  const ar = await arAgingWidget(db);
  const ap = await apAgingWidget(db);
  ok(`open SOs total: ${sos.totalCount}`);
  ok(`open POs total: ${pos.totalCount}`);
  ok(`today's sales: ${ts.invoiceCount} invoice(s), $${ts.grossSales.toString()}`);
  ok(`cash widget: $${cw.glBalance.toString()}`);
  ok(`AR aging total: $${ar.total.toString()} across ${ar.customerCount} customer(s)`);
  ok(`AP aging total: $${ap.total.toString()} across ${ap.vendorCount} vendor(s)`);

  // -------- Recon + close --------
  stage('PERIOD CLOSE — recon + soft + hard');
  const period = await getOrCreatePeriodForDate(db, new Date());
  const recon = await runAllReconChecks(db, period.id);
  const passed = recon.filter((r) => r.passed).length;
  const failed = recon.filter((r) => !r.passed).length;
  ok(`recon: ${passed}/${recon.length} passed (${failed} failed)`);

  await softClosePeriod(db, period.id);
  ok(`period ${period.code} → SOFT_CLOSED`);

  // hardClose runs recon again. With cross-test ledger noise, force-close
  // is required.
  await hardClosePeriod(db, period.id, {
    forceCloseWithDiscrepancies: { reason: 'smoke test: known cross-test ledger noise' },
  });
  ok(`period ${period.code} → HARD_CLOSED (force, recon noise expected)`);

  // -------- Post into closed period --------
  stage('POST into HARD_CLOSED period — block then override');
  let blocked = false;
  try {
    await db.$transaction((tx) =>
      post(tx, {
        entityType: 'TestSmokeClose',
        entityId: `block-${Date.now()}`,
        description: 'smoke: should block',
        postedAt: new Date(),
        lines: [
          { accountCode: cashAccount.code, debit: '1' },
          { accountCode: '2010', credit: '1' },
        ],
      }),
    );
  } catch {
    blocked = true;
  }
  if (!blocked) fail(`post into HARD_CLOSED period was NOT blocked`);
  ok(`block fired correctly`);

  await db.$transaction((tx) =>
    post(tx, {
      entityType: 'TestSmokeClose',
      entityId: `override-${Date.now()}`,
      description: 'smoke: override allowed',
      postedAt: new Date(),
      closedPeriodOverride: { reason: 'smoke test override', userId: null },
      lines: [
        { accountCode: cashAccount.code, debit: '1' },
        { accountCode: '2010', credit: '1' },
      ],
    }),
  );
  ok(`override post succeeded; check audit log`);

  // -------- Reopen --------
  stage('REOPEN period');
  await reopenPeriod(db, period.id, 'smoke test reopen');
  ok(`period ${period.code} reopened`);

  // -------- Cleanup --------
  if (FLAG_KEEP) {
    console.log('\n--keep: leaving rows behind. TAG=' + TAG);
  } else {
    stage('CLEANUP');
    // Drop the test JEs from override post first.
    const testJes = await db.journalEntry.findMany({
      where: { entityType: 'TestSmokeClose' },
      select: { id: true },
    });
    if (testJes.length > 0) {
      const jeIds = testJes.map((j) => j.id);
      await db.journalEntryLine.deleteMany({
        where: { journalEntryId: { in: jeIds } },
      });
      await db.journalEntry.deleteMany({ where: { id: { in: jeIds } } });
    }
    // Drop our test period + its recon snapshots + audit.
    const ourPeriod = await db.fiscalPeriod.findFirst({
      where: { id: period.id },
    });
    if (ourPeriod) {
      await db.periodReconciliationCheck.deleteMany({
        where: { fiscalPeriodId: ourPeriod.id },
      });
      await db.auditLog.deleteMany({
        where: { entityType: 'FiscalPeriod', entityId: ourPeriod.id },
      });
      await db.fiscalPeriod.delete({ where: { id: ourPeriod.id } });
    }
    await sweepCleanup(TAG_PREFIX);
  }

  console.log('\n✅ Financial close smoke flow complete.\n');
  await db.$disconnect();
}

main().catch(async (e) => {
  console.error('\n❌ Financial close smoke flow failed:', e);
  await db.$disconnect();
  process.exit(1);
});
