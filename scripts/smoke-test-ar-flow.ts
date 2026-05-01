/**
 * End-to-end smoke test for the Invoicing/AR slice.
 *
 *   npx tsx scripts/smoke-test-ar-flow.ts                # full flow + cleanup
 *   npx tsx scripts/smoke-test-ar-flow.ts --keep         # full flow, leave rows behind
 *   npx tsx scripts/smoke-test-ar-flow.ts --cleanup-only # sweep stragglers from prior runs
 *   npx tsx scripts/smoke-test-ar-flow.ts --verbose      # extra diagnostics
 *
 * Stages:
 *   1.  Create ephemeral customer (TAG-prefixed).
 *   2.  Ensure inventory + base price on seed product.
 *   3.  Create + confirm + close SO. Auto-invoice generated as side effect.
 *   4.  Verify the auto-generated invoice + balanced JE.
 *   5.  Record partial payment + verify balanced JE + CreditApplication.
 *   5.5 voidInvoice MUST throw "applied payments" — guard against AR corruption.
 *   6.  Create + confirm partial credit memo + verify balanced JE + auto-apply.
 *   7.  Run AR aging report; verify open balance + bucket.
 *   8.  Cleanup (skipped under --keep).
 *
 * Re-runnable: prior-run stragglers (TAG prefix SMOKE-AR-) are swept at start
 * so failed runs don't block subsequent ones.
 */

import { Prisma, InvoiceStatus, PaymentMethod } from '../src/generated/tenant';
import { db } from '../src/lib/db';
import {
  closeSalesOrder,
  confirmSalesOrder,
  createSalesOrder,
} from '../src/server/services/salesOrders';
import { voidInvoice } from '../src/server/services/invoices';
import { recordPayment } from '../src/server/services/payments';
import {
  confirmCreditMemo,
  createCreditMemoDraft,
} from '../src/server/services/creditMemos';
import { agingForCustomer } from '../src/server/services/ar';

// =============================================================================
// Config
// =============================================================================

const TAG_PREFIX = 'SMOKE-AR-';
const TAG = `${TAG_PREFIX}${Date.now()}`;
const OVERRIDE_PRICE = '4.44'; // distinct from any other override
const QTY = '5';
const STOCK_BUFFER = '20'; // ADJUST +20 added at start, reversed on cleanup
const PAYMENT_AMOUNT = '7.00';
const CM_QTY = '1';
const CM_UNIT_PRICE = '4.44';
const CM_AMOUNT = '4.44';

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

// =============================================================================
// JE balance verification
// =============================================================================

type JeBalanceCheck = { jeId: string; description: string; debitSum: Prisma.Decimal; creditSum: Prisma.Decimal };

async function assertJeBalanced(
  entityType: string,
  entityId: string,
  label: string,
): Promise<JeBalanceCheck[]> {
  const jes = await db.journalEntry.findMany({
    where: { entityType, entityId },
    include: { lines: true },
    orderBy: { createdAt: 'asc' },
  });
  if (jes.length === 0) {
    fail(`${label}: no JEs posted for ${entityType}:${entityId}`);
  }
  const checks: JeBalanceCheck[] = [];
  for (const je of jes) {
    const debitSum = je.lines.reduce(
      (acc, l) => acc.plus(l.debit),
      new Prisma.Decimal(0),
    );
    const creditSum = je.lines.reduce(
      (acc, l) => acc.plus(l.credit),
      new Prisma.Decimal(0),
    );
    if (!debitSum.equals(creditSum)) {
      fail(
        `${label}: JE ${je.id} unbalanced — debits=${debitSum.toString()} credits=${creditSum.toString()}`,
      );
    }
    info(
      `JE ${je.id.slice(0, 8)} (${je.description}): debits=${debitSum.toString()} credits=${creditSum.toString()} ✓`,
    );
    checks.push({ jeId: je.id, description: je.description, debitSum, creditSum });
  }
  ok(`${label}: ${jes.length} JE(s), all balanced`);
  return checks;
}

// =============================================================================
// Cleanup
// =============================================================================

async function sweepCleanup(prefix: string): Promise<void> {
  // Find every customer whose name starts with the prefix and tear down
  // every dependent row created during a smoke run, scoped to those
  // customer ids (same pattern the integration-test wipes use).
  const customers = await db.customer.findMany({
    where: { name: { startsWith: prefix } },
    select: { id: true, code: true, name: true },
  });
  if (customers.length === 0) {
    info(`sweep: no customers with prefix ${prefix} — nothing to clean`);
    return;
  }
  const customerIds = customers.map((c) => c.id);
  console.log(`  sweeping ${customers.length} customer(s) matching prefix ${prefix}…`);

  // Snapshot child IDs BEFORE deleting child rows so audit cleanup is scoped.
  const sos = await db.salesOrder.findMany({
    where: { customerId: { in: customerIds } },
    select: { id: true, number: true },
  });
  const soIds = sos.map((s) => s.id);
  const soNumbers = sos.map((s) => s.number);

  const invoices = await db.invoice.findMany({
    where: { customerId: { in: customerIds } },
    select: { id: true },
  });
  const invIds = invoices.map((i) => i.id);

  const payments = await db.payment.findMany({
    where: { customerId: { in: customerIds } },
    select: { id: true },
  });
  const pmtIds = payments.map((p) => p.id);

  const cms = await db.creditMemo.findMany({
    where: { customerId: { in: customerIds } },
    select: { id: true },
  });
  const cmIds = cms.map((c) => c.id);

  const addresses = await db.customerAddress.findMany({
    where: { customerId: { in: customerIds } },
    select: { id: true },
  });
  const addressIds = addresses.map((a) => a.id);

  const overrides = await db.customerPriceOverride.findMany({
    where: { customerId: { in: customerIds } },
    select: { id: true },
  });
  const overrideIds = overrides.map((o) => o.id);

  // Inventory cleanup. Two classes of test-owned movements:
  //   (a) SMOKE_AR_BUFFER:<TAG>          — the +N stock buffer we added
  //   (b) <SO-number>                    — the CONSUME closeSalesOrder wrote
  // Both are deleted from the ledger; recomputing onHand from the ledger
  // afterward leaves the bin at its pre-test state (no compensating
  // ADJUST rows survive — keeps the inventory ledger clean across re-runs).
  const bufferMovements = await db.inventoryMovement.findMany({
    where: { reference: { startsWith: 'SMOKE_AR_BUFFER:' } },
    select: { id: true, variantId: true, warehouseId: true },
  });
  const consumeMovements =
    soNumbers.length > 0
      ? await db.inventoryMovement.findMany({
          where: { reference: { in: soNumbers } },
          select: { id: true, variantId: true, warehouseId: true },
        })
      : [];
  const allMovementIds = [
    ...bufferMovements.map((m) => m.id),
    ...consumeMovements.map((m) => m.id),
  ];
  if (allMovementIds.length > 0) {
    await db.auditLog.deleteMany({
      where: { entityType: 'InventoryMovement', entityId: { in: allMovementIds } },
    });
    await db.inventoryMovement.deleteMany({ where: { id: { in: allMovementIds } } });
  }
  // Recompute onHand for every bin we touched.
  const bins = [
    ...new Set(
      [...bufferMovements, ...consumeMovements].map(
        (m) => `${m.variantId}|${m.warehouseId}`,
      ),
    ),
  ];
  for (const k of bins) {
    const [variantId, warehouseId] = k.split('|');
    const agg = await db.inventoryMovement.aggregate({
      where: { variantId, warehouseId },
      _sum: { qty: true },
    });
    const reservedAgg = await db.salesOrderLine.aggregate({
      where: {
        variantId,
        warehouseId,
        salesOrder: {
          status: { in: ['CONFIRMED', 'DISPATCHED'] },
          deletedAt: null,
        },
      },
      _sum: { qtyReserved: true },
    });
    await db.inventoryItem.update({
      where: { variantId_warehouseId: { variantId, warehouseId } },
      data: {
        onHand: agg._sum.qty ?? new Prisma.Decimal(0),
        reserved: reservedAgg._sum.qtyReserved ?? new Prisma.Decimal(0),
      },
    });
  }

  // CMs: lines + applications + JEs + audit + row.
  if (cmIds.length > 0) {
    const cmJes = await db.journalEntry.findMany({
      where: { entityType: 'CreditMemo', entityId: { in: cmIds } },
      select: { id: true },
    });
    if (cmJes.length > 0) {
      const jeIds = cmJes.map((j) => j.id);
      await db.journalEntryLine.deleteMany({ where: { journalEntryId: { in: jeIds } } });
      await db.journalEntry.deleteMany({ where: { id: { in: jeIds } } });
    }
    await db.creditApplication.deleteMany({ where: { creditMemoId: { in: cmIds } } });
    await db.creditMemoLine.deleteMany({ where: { creditMemoId: { in: cmIds } } });
    await db.auditLog.deleteMany({
      where: { entityType: 'CreditMemo', entityId: { in: cmIds } },
    });
    await db.creditMemo.deleteMany({ where: { id: { in: cmIds } } });
  }

  // Payments: applications + JEs + audit + row.
  if (pmtIds.length > 0) {
    const pmtJes = await db.journalEntry.findMany({
      where: { entityType: 'Payment', entityId: { in: pmtIds } },
      select: { id: true },
    });
    if (pmtJes.length > 0) {
      const jeIds = pmtJes.map((j) => j.id);
      await db.journalEntryLine.deleteMany({ where: { journalEntryId: { in: jeIds } } });
      await db.journalEntry.deleteMany({ where: { id: { in: jeIds } } });
    }
    await db.creditApplication.deleteMany({ where: { paymentId: { in: pmtIds } } });
    await db.auditLog.deleteMany({
      where: { entityType: 'Payment', entityId: { in: pmtIds } },
    });
    await db.payment.deleteMany({ where: { id: { in: pmtIds } } });
  }

  // Invoices: lines + applications + JEs + audit + row. SO must come AFTER
  // because Invoice.salesOrderId is RESTRICT.
  if (invIds.length > 0) {
    const invJes = await db.journalEntry.findMany({
      where: { entityType: 'Invoice', entityId: { in: invIds } },
      select: { id: true },
    });
    if (invJes.length > 0) {
      const jeIds = invJes.map((j) => j.id);
      await db.journalEntryLine.deleteMany({ where: { journalEntryId: { in: jeIds } } });
      await db.journalEntry.deleteMany({ where: { id: { in: jeIds } } });
    }
    await db.creditApplication.deleteMany({ where: { invoiceId: { in: invIds } } });
    await db.auditLog.deleteMany({
      where: { entityType: 'Invoice', entityId: { in: invIds } },
    });
    await db.invoiceLine.deleteMany({ where: { invoiceId: { in: invIds } } });
    await db.invoice.deleteMany({ where: { id: { in: invIds } } });
  }

  // SOs.
  if (soIds.length > 0) {
    await db.auditLog.deleteMany({
      where: { entityType: 'SalesOrder', entityId: { in: soIds } },
    });
    await db.salesOrderLine.deleteMany({ where: { salesOrderId: { in: soIds } } });
    await db.salesOrder.deleteMany({ where: { id: { in: soIds } } });
  }

  // Customer scaffolding.
  await db.customerActivity.deleteMany({ where: { customerId: { in: customerIds } } });
  if (overrideIds.length > 0) {
    await db.auditLog.deleteMany({
      where: {
        entityType: 'CustomerPriceOverride',
        entityId: { in: overrideIds },
      },
    });
    await db.customerPriceOverride.deleteMany({ where: { id: { in: overrideIds } } });
  }
  await db.customerAddress.deleteMany({ where: { customerId: { in: customerIds } } });
  if (addressIds.length > 0) {
    await db.auditLog.deleteMany({
      where: { entityType: 'CustomerAddress', entityId: { in: addressIds } },
    });
  }
  await db.auditLog.deleteMany({
    where: { entityType: 'Customer', entityId: { in: customerIds } },
  });
  await db.customer.deleteMany({ where: { id: { in: customerIds } } });

  console.log(`  swept ${customers.length} customer(s) and dependents`);
}

// =============================================================================
// Reference-data assertions
// =============================================================================

async function requireSeed<T>(
  q: () => Promise<T | null>,
  hint: string,
): Promise<T> {
  const v = await q();
  if (!v) {
    throw new Error(
      `Missing seed: ${hint}. Run \`npm run db:seed:tenant\` (or apply the seed migrations) before running this smoke test.`,
    );
  }
  return v;
}

// =============================================================================
// Main flow
// =============================================================================

async function runFlow(): Promise<void> {
  // -------------------------------------------------------------------
  // Reference data
  // -------------------------------------------------------------------

  const warehouse = await requireSeed(
    () => db.warehouse.findFirst({ where: { code: 'WH-MAIN', deletedAt: null } }),
    'Warehouse code=WH-MAIN',
  );
  const variant = await requireSeed(
    () =>
      db.productVariant.findFirst({
        where: { sku: 'SEED-PROD-1-RED', deletedAt: null },
      }),
    'ProductVariant sku=SEED-PROD-1-RED',
  );
  const product = await requireSeed(
    () => db.product.findUnique({ where: { id: variant.productId } }),
    `Product for variant ${variant.id}`,
  );
  const term = await requireSeed(
    () => db.paymentTerm.findUnique({ where: { code: 'NET30' } }),
    'PaymentTerm code=NET30',
  );
  const rep = await requireSeed(
    () => db.salesRep.findUnique({ where: { code: 'UNASSIGNED' } }),
    'SalesRep code=UNASSIGNED',
  );
  const cmCategory = await requireSeed(
    () => db.creditMemoCategory.findUnique({ where: { code: 'RETURN' } }),
    'CreditMemoCategory code=RETURN',
  );
  for (const code of ['1110', '1210', '4100', '4500']) {
    await requireSeed(
      () => db.glAccount.findUnique({ where: { code } }),
      `GlAccount code=${code}`,
    );
  }

  // Ensure base price on seed product (idempotent) so pricing resolver
  // succeeds even if a fresh tenant skipped the manual SO script first.
  if (product.basePrice == null) {
    await db.product.update({
      where: { id: product.id },
      data: { basePrice: new Prisma.Decimal('9.99') },
    });
    info(`set basePrice=9.99 on seed product ${product.sku}`);
  }

  // -------------------------------------------------------------------
  // STAGE 1: Customer
  // -------------------------------------------------------------------

  stage('Create ephemeral customer');
  const customer = await db.$transaction(async (tx) => {
    const c = await tx.customer.create({
      data: {
        code: TAG,
        name: `${TAG} Smoke Test Customer`,
        salesRepId: rep.id,
        paymentTermId: term.id,
      },
    });
    await tx.customerAddress.create({
      data: {
        customerId: c.id,
        kind: 'BILLING',
        isDefault: true,
        line1: '1 Smoke Test Way',
        city: 'Dallas',
        region: 'TX',
        postalCode: '75201',
      },
    });
    return c;
  });
  ok(`customer ${customer.code} (id=${customer.id.slice(0, 8)})`);

  // Customer-specific price override so the SO uses a deterministic price.
  const override = await db.customerPriceOverride.create({
    data: {
      customerId: customer.id,
      variantId: variant.id,
      unitPrice: new Prisma.Decimal(OVERRIDE_PRICE),
      currency: 'USD',
    },
  });
  ok(`price override ${OVERRIDE_PRICE} on variant ${variant.sku}`);
  void override;

  // -------------------------------------------------------------------
  // STAGE 2: Inventory buffer
  // -------------------------------------------------------------------

  stage('Ensure inventory buffer on seed bin');
  await db.$transaction(async (tx) => {
    const movement = await tx.inventoryMovement.create({
      data: {
        variantId: variant.id,
        warehouseId: warehouse.id,
        type: 'ADJUST',
        qty: new Prisma.Decimal(STOCK_BUFFER),
        reference: `SMOKE_AR_BUFFER:${TAG}`,
        notes: 'Smoke-test stock buffer (reversed at cleanup)',
      },
    });
    void movement;
    const agg = await tx.inventoryMovement.aggregate({
      where: { variantId: variant.id, warehouseId: warehouse.id },
      _sum: { qty: true },
    });
    await tx.inventoryItem.upsert({
      where: {
        variantId_warehouseId: {
          variantId: variant.id,
          warehouseId: warehouse.id,
        },
      },
      create: {
        variantId: variant.id,
        warehouseId: warehouse.id,
        onHand: agg._sum.qty ?? new Prisma.Decimal(0),
        reserved: new Prisma.Decimal(0),
      },
      update: { onHand: agg._sum.qty ?? new Prisma.Decimal(0) },
    });
  });
  ok(`adjusted +${STOCK_BUFFER} on ${variant.sku}@${warehouse.code}`);

  // -------------------------------------------------------------------
  // STAGE 3: SO lifecycle (DRAFT → CONFIRMED → CLOSED, auto-invoice as side effect)
  // -------------------------------------------------------------------

  stage('Create + confirm + close SO (auto-invoice expected)');
  const draft = await createSalesOrder(db, {
    customerId: customer.id,
    warehouseId: warehouse.id,
    lines: [
      {
        variantId: variant.id,
        warehouseId: warehouse.id,
        qtyOrdered: QTY,
      },
    ],
  });
  ok(`SO created ${draft.number} status=${draft.status}`);
  if (draft.lines[0].priceRule !== 'CUSTOMER_SPECIFIC') {
    fail(
      `pricing rule: expected CUSTOMER_SPECIFIC, got ${draft.lines[0].priceRule}`,
    );
  }
  ok(`pricing rule resolved to CUSTOMER_SPECIFIC @ ${draft.lines[0].unitPrice.toString()}`);

  await confirmSalesOrder(db, draft.id);
  const closed = await closeSalesOrder(db, draft.id, undefined);
  if (closed.status !== 'CLOSED') {
    fail(`SO status: expected CLOSED, got ${closed.status}`);
  }
  ok(`SO closed ${closed.number}`);

  // -------------------------------------------------------------------
  // STAGE 4: Verify invoice was generated as a SIDE EFFECT of close
  // -------------------------------------------------------------------

  stage('Verify auto-generated invoice + balanced JE');
  const invoice = await db.invoice.findFirst({
    where: { salesOrderId: closed.id, deletedAt: null },
    include: { lines: { where: { deletedAt: null } } },
  });
  if (!invoice) {
    fail(`no invoice found for SO ${closed.id} — closeSalesOrder did not auto-generate`);
  }
  ok(`invoice ${invoice.number} status=${invoice.status} total=${invoice.total.toString()}`);
  if (invoice.status !== InvoiceStatus.OPEN) {
    fail(`invoice status: expected OPEN, got ${invoice.status}`);
  }
  // Expected total: qty * override price = 5 * 4.44 = 22.20
  const expectedTotal = new Prisma.Decimal(QTY).times(new Prisma.Decimal(OVERRIDE_PRICE));
  if (!invoice.total.equals(expectedTotal)) {
    fail(
      `invoice total: expected ${expectedTotal.toString()}, got ${invoice.total.toString()}`,
    );
  }
  ok(`invoice total matches expected ${expectedTotal.toString()}`);
  await assertJeBalanced('Invoice', invoice.id, 'invoice JE');

  // -------------------------------------------------------------------
  // STAGE 5: Partial payment
  // -------------------------------------------------------------------

  stage('Record partial payment (CHECK)');
  const payment = await recordPayment(db, {
    customerId: customer.id,
    method: PaymentMethod.CHECK,
    amount: PAYMENT_AMOUNT,
    applications: [{ invoiceId: invoice.id, amount: PAYMENT_AMOUNT }],
  });
  ok(`payment ${payment.number} amount=${payment.amount.toString()} apps=${payment.applications.length}`);
  if (payment.applications.length !== 1) {
    fail(`expected 1 CreditApplication, got ${payment.applications.length}`);
  }
  if (!payment.applications[0].amount.equals(new Prisma.Decimal(PAYMENT_AMOUNT))) {
    fail(`CreditApplication amount mismatch`);
  }
  ok(`CreditApplication links payment → invoice ${invoice.number}`);

  await assertJeBalanced('Payment', payment.id, 'payment JE');

  const invoiceAfterPayment = await db.invoice.findUniqueOrThrow({
    where: { id: invoice.id },
  });
  if (invoiceAfterPayment.status !== InvoiceStatus.PARTIAL) {
    fail(
      `invoice status after partial payment: expected PARTIAL, got ${invoiceAfterPayment.status}`,
    );
  }
  if (!invoiceAfterPayment.amountPaid.equals(new Prisma.Decimal(PAYMENT_AMOUNT))) {
    fail(
      `invoice amountPaid: expected ${PAYMENT_AMOUNT}, got ${invoiceAfterPayment.amountPaid.toString()}`,
    );
  }
  ok(`invoice flipped OPEN → PARTIAL, amountPaid=${invoiceAfterPayment.amountPaid.toString()}`);

  // -------------------------------------------------------------------
  // STAGE 5.5: voidInvoice MUST refuse with applied payments
  // -------------------------------------------------------------------

  stage('voidInvoice guard MUST throw when applied payments exist');
  let voidThrew = false;
  let voidErr: unknown;
  try {
    await voidInvoice(db, invoice.id, 'smoke test void attempt');
  } catch (e) {
    voidThrew = true;
    voidErr = e;
  }
  if (!voidThrew) {
    fail(
      'CRITICAL: voidInvoice succeeded with applied payments — AR corruption guard broken',
    );
  }
  const errMsg = voidErr instanceof Error ? voidErr.message : String(voidErr);
  if (!/applied payments|reverse/i.test(errMsg)) {
    fail(
      `voidInvoice threw, but message did not mention "applied payments" or "reverse": ${errMsg}`,
    );
  }
  ok(`voidInvoice correctly refused: "${errMsg}"`);

  // Verify invoice was NOT mutated by the failed void.
  const invoiceAfterVoidAttempt = await db.invoice.findUniqueOrThrow({
    where: { id: invoice.id },
  });
  if (invoiceAfterVoidAttempt.status !== InvoiceStatus.PARTIAL) {
    fail(
      `invoice status changed after failed void: expected PARTIAL, got ${invoiceAfterVoidAttempt.status}`,
    );
  }
  ok('invoice state unchanged after failed void attempt');

  // -------------------------------------------------------------------
  // STAGE 6: Credit memo (partial) + auto-apply
  // -------------------------------------------------------------------

  stage('Create + confirm partial credit memo');
  const cmDraft = await createCreditMemoDraft(db, {
    customerId: customer.id,
    invoiceId: invoice.id,
    categoryId: cmCategory.id,
    amount: CM_AMOUNT,
    lines: [
      {
        invoiceLineId: invoice.lines[0].id,
        variantId: variant.id,
        qty: CM_QTY,
        unitPrice: CM_UNIT_PRICE,
        description: 'smoke test partial CM',
      },
    ],
    reason: 'smoke-test partial credit',
  });
  ok(`CM draft ${cmDraft.number} amount=${cmDraft.amount.toString()} netCredit=${cmDraft.netCredit.toString()}`);

  const cm = await confirmCreditMemo(db, cmDraft.id);
  if (cm.status !== 'CONFIRMED') {
    fail(`CM status: expected CONFIRMED, got ${cm.status}`);
  }
  ok(`CM confirmed (status=${cm.status})`);
  await assertJeBalanced('CreditMemo', cm.id, 'CM JE');

  // Auto-apply check.
  const cmApps = await db.creditApplication.findMany({
    where: { creditMemoId: cm.id, reversedAt: null },
  });
  if (cmApps.length !== 1) {
    fail(`expected 1 CM auto-application, got ${cmApps.length}`);
  }
  if (cmApps[0].invoiceId !== invoice.id) {
    fail(`CM auto-applied to wrong invoice`);
  }
  if (!cmApps[0].amount.equals(cm.netCredit)) {
    fail(
      `CM auto-application amount: expected netCredit=${cm.netCredit.toString()}, got ${cmApps[0].amount.toString()}`,
    );
  }
  ok(`CM auto-applied netCredit=${cm.netCredit.toString()} → invoice ${invoice.number}`);

  // -------------------------------------------------------------------
  // STAGE 7: AR aging
  // -------------------------------------------------------------------

  stage('AR aging report — verify open balance + bucket');
  const aging = await agingForCustomer(db, customer.id);
  if (aging.invoices.length !== 1) {
    fail(`aging: expected 1 open invoice, got ${aging.invoices.length}`);
  }
  const row = aging.invoices[0];
  const expectedOpen = expectedTotal
    .minus(new Prisma.Decimal(PAYMENT_AMOUNT))
    .minus(new Prisma.Decimal(CM_AMOUNT));
  if (!row.balance.equals(expectedOpen)) {
    fail(
      `aging balance: expected ${expectedOpen.toString()}, got ${row.balance.toString()}`,
    );
  }
  ok(`aging row balance = ${row.balance.toString()} (= total ${expectedTotal.toString()} − paid ${PAYMENT_AMOUNT} − credited ${CM_AMOUNT})`);
  if (row.bucket !== 'current') {
    fail(`aging bucket: expected current (NET30, invoiced today), got ${row.bucket}`);
  }
  ok(`aging bucket = current (NET30, dueDate ${row.dueDate.toISOString().slice(0, 10)})`);

  // Cumulative sum check: total across all buckets must equal the open
  // balance. Catches a class of bugs where individual JEs balance but
  // the cumulative reporting is off.
  const bucketSum = (
    ['current', 'b1to30', 'b31to60', 'b61to90', 'b91plus'] as const
  ).reduce(
    (acc, k) => acc.plus(aging.buckets[k]),
    new Prisma.Decimal(0),
  );
  if (!bucketSum.equals(expectedOpen)) {
    fail(
      `aging buckets sum: expected ${expectedOpen.toString()}, got ${bucketSum.toString()}`,
    );
  }
  ok(`aging buckets sum = ${bucketSum.toString()} ✓ matches expected open balance`);
  if (!aging.total.equals(expectedOpen)) {
    fail(
      `aging.total: expected ${expectedOpen.toString()}, got ${aging.total.toString()}`,
    );
  }
  ok(`aging.total = ${aging.total.toString()} ✓ matches expected open balance`);

  // Audit log count check.
  const auditCount = await db.auditLog.count({
    where: {
      OR: [
        { entityType: 'Customer', entityId: customer.id },
        { entityType: 'SalesOrder', entityId: closed.id },
        { entityType: 'Invoice', entityId: invoice.id },
        { entityType: 'Payment', entityId: payment.id },
        { entityType: 'CreditMemo', entityId: cm.id },
      ],
    },
  });
  if (auditCount === 0) {
    fail('expected at least one audit row across the flow, got 0');
  }
  ok(`audit-log row count across flow: ${auditCount}`);
}

// =============================================================================
// Entry point
// =============================================================================

async function main() {
  console.log(`smoke-test-ar-flow.ts — TAG=${TAG}`);
  console.log(`flags: keep=${FLAG_KEEP} cleanup-only=${FLAG_CLEANUP_ONLY} verbose=${FLAG_VERBOSE}`);

  // Always sweep stragglers from prior runs (matches prefix SMOKE-AR-).
  // For --cleanup-only we sweep and exit.
  console.log('\n--- pre-run sweep of prior SMOKE-AR-* stragglers ---');
  await sweepCleanup(TAG_PREFIX);

  if (FLAG_CLEANUP_ONLY) {
    console.log('\n[cleanup-only] done.');
    return;
  }

  let flowError: unknown;
  try {
    await runFlow();
  } catch (e) {
    flowError = e;
  }

  if (FLAG_KEEP) {
    if (flowError) {
      console.error('\n[FAIL] flow errored under --keep; rows preserved for debugging');
      throw flowError;
    }
    console.log('\n[--keep] flow completed; rows preserved for inspection');
    console.log(`use \`--cleanup-only\` to sweep them (filter on TAG prefix ${TAG_PREFIX})`);
    return;
  }

  // Cleanup runs even on failure (try/finally semantics).
  console.log('\n--- post-run cleanup ---');
  try {
    await sweepCleanup(TAG_PREFIX);
  } catch (cleanupErr) {
    console.error('[FAIL] cleanup itself errored:', cleanupErr);
    if (flowError) throw flowError;
    throw cleanupErr;
  }

  if (flowError) {
    throw flowError;
  }

  console.log('\nALL STAGES PASSED.');
}

main()
  .catch((e) => {
    console.error('\n--- SMOKE TEST FAILED ---');
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
