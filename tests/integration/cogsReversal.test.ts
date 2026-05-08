import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CreditApplicationKind,
  InvoiceStatus,
  InventoryMovementType,
  Prisma,
  RmaStatus,
} from '@/generated/tenant';
import type { PrismaClient } from '@/generated/tenant';
import {
  closeSalesOrder,
  confirmSalesOrder,
  createSalesOrder,
} from '@/server/services/salesOrders';
import {
  createDraftReceipt,
  postReceipt,
} from '@/server/services/receipts';
import { receiveInventory } from '@/server/services/movements';
import {
  createRma,
  creditFromRma,
  transitionRma,
} from '@/server/services/rmas';
import {
  reverseCogsForCreditMemoTx,
  reverseCogsForInvoiceTx,
} from '@/server/services/cogsReversal';
import { voidInvoice } from '@/server/services/invoices';
import {
  confirmCreditMemo,
  createCreditMemoDraft,
} from '@/server/services/creditMemos';
import { hasTenantDb, makeClient } from '../helpers/db';
import { upsertTestCustomer } from '../helpers/customerStub';
import { upsertTestWarehouse } from '../helpers/warehouseStub';
import { wipeBillArtifactsForVendors } from '../helpers/wipeBillArtifacts';

const suite = hasTenantDb ? describe : describe.skip;
const TAG = 'TEST-COGSREV';

suite('COGS reversal (Part 3.5)', () => {
  let db: PrismaClient;
  let customerId: string;
  let vendorId: string;
  let warehouseAId: string;
  let warehouseBId: string;
  let productId: string;
  let variantAId: string;
  let variantBId: string;
  let returnCategoryId: string;
  let shippingDamageCategoryId: string;
  let pricingDisputeCategoryId: string;

  beforeAll(async () => {
    db = makeClient();
    const c = await upsertTestCustomer(db, {
      code: `${TAG}-CUST`,
      name: 'COGS Reversal Test Customer',
    });
    customerId = c.id;
    const v = await db.vendor.upsert({
      where: { code: `${TAG}-VEND` },
      create: { code: `${TAG}-VEND`, name: 'COGS Reversal Test Vendor' },
      update: { active: true, deletedAt: null },
    });
    vendorId = v.id;
    const wa = await upsertTestWarehouse(db, {
      code: `${TAG}-WH-A`,
      name: 'COGS Reversal WH A',
    });
    const wb = await upsertTestWarehouse(db, {
      code: `${TAG}-WH-B`,
      name: 'COGS Reversal WH B',
    });
    warehouseAId = wa.id;
    warehouseBId = wb.id;

    const product = await db.product.upsert({
      where: { sku: `${TAG}-PROD` },
      create: {
        sku: `${TAG}-PROD`,
        name: 'COGS Reversal Test Product',
        basePrice: new Prisma.Decimal('20'),
      },
      update: { active: true, deletedAt: null, basePrice: new Prisma.Decimal('20') },
    });
    productId = product.id;
    const va = await db.productVariant.upsert({
      where: { sku: `${TAG}-PROD-V1` },
      create: { productId: product.id, sku: `${TAG}-PROD-V1`, name: 'V1' },
      update: { productId: product.id, active: true, deletedAt: null },
    });
    variantAId = va.id;
    const vb = await db.productVariant.upsert({
      where: { sku: `${TAG}-PROD-V2` },
      create: { productId: product.id, sku: `${TAG}-PROD-V2`, name: 'V2' },
      update: { productId: product.id, active: true, deletedAt: null },
    });
    variantBId = vb.id;

    returnCategoryId = (
      await db.creditMemoCategory.findFirstOrThrow({ where: { code: 'RETURN' } })
    ).id;
    shippingDamageCategoryId = (
      await db.creditMemoCategory.findFirstOrThrow({
        where: { code: 'SHIPPING_DAMAGE' },
      })
    ).id;
    pricingDisputeCategoryId = (
      await db.creditMemoCategory.findFirstOrThrow({
        where: { code: 'PRICING_DISPUTE' },
      })
    ).id;
  });

  beforeEach(async () => {
    await wipe();
  });

  afterAll(async () => {
    await wipe();
    await db.productVariant.deleteMany({
      where: { id: { in: [variantAId, variantBId] } },
    });
    await db.product.deleteMany({ where: { id: productId } });
    await db.warehouse.deleteMany({
      where: { id: { in: [warehouseAId, warehouseBId] } },
    });
    await db.vendor.deleteMany({ where: { id: vendorId } });
    await db.customer.deleteMany({ where: { id: customerId } });
    await db.$disconnect();
  });

  // ==========================================================================
  // Cleanup — Phase-1B-style scoped walk through the FK graph children-first.
  // Includes the new RMA_RETURN movements and reversal-sourced FifoLayers
  // (which have sourceReceiptLineId=null but sourceMovementId set to the
  // RMA_RETURN movement). Both are cleaned via the variantId-keyed sweep
  // below, since RMA_RETURN movements share the variant-scoped lookup.
  // ==========================================================================
  async function wipe(): Promise<void> {
    const variantIds = [variantAId, variantBId];
    const warehouseIds = [warehouseAId, warehouseBId];

    // Phase 8: clear bills auto-drafted by postReceipt before any
    // variant/vendor cleanup hits BillLine RESTRICT FKs.
    await wipeBillArtifactsForVendors(db, [vendorId]);

    const sos = await db.salesOrder.findMany({
      where: { customerId },
      select: { id: true },
    });
    const soIds = sos.map((s) => s.id);

    const invoices = await db.invoice.findMany({
      where: { OR: [{ salesOrderId: { in: soIds } }, { customerId }] },
      select: { id: true },
    });
    const invoiceIds = invoices.map((i) => i.id);

    const cms = await db.creditMemo.findMany({
      where: {
        OR: [{ invoiceId: { in: invoiceIds } }, { customerId }],
      },
      select: { id: true },
    });
    const cmIds = cms.map((c) => c.id);

    const rmas = await db.rma.findMany({
      where: { invoiceId: { in: invoiceIds } },
      select: { id: true },
    });
    const rmaIds = rmas.map((r) => r.id);

    if (cmIds.length > 0) {
      const cmJes = await db.journalEntry.findMany({
        where: { entityType: 'CreditMemo', entityId: { in: cmIds } },
        select: { id: true },
      });
      const cmJeIds = cmJes.map((j) => j.id);
      if (cmJeIds.length > 0) {
        await db.journalEntryLine.deleteMany({
          where: { journalEntryId: { in: cmJeIds } },
        });
        await db.journalEntry.deleteMany({ where: { id: { in: cmJeIds } } });
      }
      await db.auditLog.deleteMany({
        where: { entityType: 'CreditMemo', entityId: { in: cmIds } },
      });
    }
    if (invoiceIds.length > 0) {
      const invJes = await db.journalEntry.findMany({
        where: { entityType: 'Invoice', entityId: { in: invoiceIds } },
        select: { id: true },
      });
      const invJeIds = invJes.map((j) => j.id);
      if (invJeIds.length > 0) {
        await db.journalEntryLine.deleteMany({
          where: { journalEntryId: { in: invJeIds } },
        });
        await db.journalEntry.deleteMany({ where: { id: { in: invJeIds } } });
      }
      await db.auditLog.deleteMany({
        where: { entityType: 'Invoice', entityId: { in: invoiceIds } },
      });
    }
    if (cmIds.length > 0) {
      await db.creditApplication.deleteMany({
        where: { creditMemoId: { in: cmIds } },
      });
    }
    if (invoiceIds.length > 0) {
      await db.creditApplication.deleteMany({
        where: { invoiceId: { in: invoiceIds } },
      });
    }
    if (rmaIds.length > 0) {
      await db.rmaLine.deleteMany({ where: { rmaId: { in: rmaIds } } });
      await db.auditLog.deleteMany({
        where: { entityType: 'Rma', entityId: { in: rmaIds } },
      });
      // Null Rma.creditMemoId so we can delete CMs without FK trouble.
      await db.rma.updateMany({
        where: { id: { in: rmaIds } },
        data: { creditMemoId: null },
      });
      await db.rma.deleteMany({ where: { id: { in: rmaIds } } });
    }
    if (cmIds.length > 0) {
      await db.creditMemoLine.deleteMany({
        where: { creditMemoId: { in: cmIds } },
      });
      await db.creditMemo.deleteMany({ where: { id: { in: cmIds } } });
    }
    await db.customerActivity.deleteMany({ where: { customerId } });
    if (invoiceIds.length > 0) {
      await db.invoiceLine.deleteMany({
        where: { invoiceId: { in: invoiceIds } },
      });
      await db.invoice.deleteMany({ where: { id: { in: invoiceIds } } });
    }
    if (soIds.length > 0) {
      await db.salesOrderLine.updateMany({
        where: { salesOrderId: { in: soIds } },
        data: { inventoryMovementId: null },
      });
      await db.salesOrderLine.deleteMany({
        where: { salesOrderId: { in: soIds } },
      });
      await db.auditLog.deleteMany({
        where: { entityType: 'SalesOrder', entityId: { in: soIds } },
      });
      await db.salesOrder.deleteMany({ where: { id: { in: soIds } } });
    }

    const layers = await db.fifoLayer.findMany({
      where: { variantId: { in: variantIds } },
      select: { id: true },
    });
    const layerIds = layers.map((l) => l.id);
    const movements = await db.inventoryMovement.findMany({
      where: { variantId: { in: variantIds } },
      select: { id: true },
    });
    const movementIds = movements.map((m) => m.id);

    if (layerIds.length > 0) {
      await db.fifoConsumption.deleteMany({
        where: { layerId: { in: layerIds } },
      });
      await db.auditLog.deleteMany({
        where: { entityType: 'FifoLayer', entityId: { in: layerIds } },
      });
      await db.fifoLayer.deleteMany({ where: { id: { in: layerIds } } });
    }
    if (movementIds.length > 0) {
      await db.fifoConsumption.deleteMany({
        where: { movementId: { in: movementIds } },
      });
      await db.auditLog.deleteMany({
        where: { entityType: 'InventoryMovement', entityId: { in: movementIds } },
      });
      await db.receiptLine.updateMany({
        where: { inventoryMovementId: { in: movementIds } },
        data: { inventoryMovementId: null },
      });
    }
    await db.receiptLine.deleteMany({ where: { variantId: { in: variantIds } } });
    await db.receipt.deleteMany({ where: { vendorId } });
    if (movementIds.length > 0) {
      await db.inventoryMovement.deleteMany({
        where: { id: { in: movementIds } },
      });
    }
    await db.inventoryItem.deleteMany({
      where: { variantId: { in: variantIds }, warehouseId: { in: warehouseIds } },
    });
  }

  // ==========================================================================
  // Helpers
  // ==========================================================================
  async function stockBinViaReceipt(
    qty: string,
    unitCost: string,
    opts?: { variant?: string; warehouse?: string },
  ): Promise<void> {
    const v = opts?.variant ?? variantAId;
    const w = opts?.warehouse ?? warehouseAId;
    const draft = await createDraftReceipt(db, {
      vendorId,
      warehouseId: w,
      lines: [{ variantId: v, warehouseId: w, qtyReceived: qty, unitCost }],
    });
    await postReceipt(db, draft.id);
  }

  async function closeSOSingleLine(
    qty: string,
    opts?: { variant?: string; warehouse?: string },
  ): Promise<{ soId: string; invoiceId: string }> {
    const v = opts?.variant ?? variantAId;
    const w = opts?.warehouse ?? warehouseAId;
    const so = await createSalesOrder(db, {
      customerId,
      warehouseId: w,
      lines: [{ variantId: v, warehouseId: w, qtyOrdered: qty }],
    });
    await confirmSalesOrder(db, so.id);
    await closeSalesOrder(db, so.id, undefined);
    const invoice = await db.invoice.findUniqueOrThrow({
      where: { salesOrderId: so.id },
    });
    return { soId: so.id, invoiceId: invoice.id };
  }

  async function buildAndInspectRma(
    invoiceId: string,
    rmaLines: Array<{ invoiceLineId: string; qty: string }>,
    opts?: { returnless?: boolean },
  ): Promise<string> {
    const rma = await createRma(db, {
      customerId,
      invoiceId,
      returnless: opts?.returnless ?? false,
      lines: rmaLines.map((l) => ({
        invoiceLineId: l.invoiceLineId,
        qty: l.qty,
      })),
    });
    await transitionRma(db, { rmaId: rma.id, to: RmaStatus.APPROVED });
    await transitionRma(db, { rmaId: rma.id, to: RmaStatus.RECEIVED });
    await transitionRma(db, { rmaId: rma.id, to: RmaStatus.INSPECTED });
    return rma.id;
  }

  async function getInvoiceLines(invoiceId: string) {
    // Tiebreaker on id: multi-line invoices created in a single Prisma
    // create call land with identical createdAt at millisecond resolution
    // (Postgres TIMESTAMP(3) + statement-level now()), so sorting on
    // createdAt alone leaves order implementation-defined. id-ascending
    // keeps tests that index by position deterministic.
    return db.invoiceLine.findMany({
      where: { invoiceId, deletedAt: null },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }

  async function getJEsForEntity(entityType: 'Invoice' | 'CreditMemo', entityId: string) {
    return db.journalEntry.findMany({
      where: { entityType, entityId },
      include: { lines: { include: { account: true } } },
      orderBy: { createdAt: 'asc' },
    });
  }

  // ==========================================================================
  // voidInvoice path (tests 1-6)
  // ==========================================================================

  it('(1) full void with cogsPosted=true reverses COGS, creates RMA_RETURN + new layer + JE, sets cogsReversed', async () => {
    await stockBinViaReceipt('10', '4');
    const { invoiceId } = await closeSOSingleLine('6');

    const inv = await db.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect(inv.cogsPosted).toBe(true);
    expect(inv.cogsReversed).toBe(false);

    await voidInvoice(db, invoiceId, 'test void');

    const after = await db.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect(after.cogsReversed).toBe(true);
    expect(after.status).toBe(InvoiceStatus.VOIDED);

    const returns = await db.inventoryMovement.findMany({
      where: { variantId: variantAId, type: InventoryMovementType.RMA_RETURN },
    });
    expect(returns).toHaveLength(1);
    expect(returns[0].qty.toString()).toBe(new Prisma.Decimal('6').toString());
    expect(returns[0].unitCost!.toFixed(5)).toBe(new Prisma.Decimal('4').toFixed(5));

    const layers = await db.fifoLayer.findMany({
      where: { sourceMovementId: returns[0].id },
    });
    expect(layers).toHaveLength(1);
    expect(layers[0].sourceReceiptLineId).toBeNull();
    expect(layers[0].qtyRemaining.toString()).toBe(new Prisma.Decimal('6').toString());
    expect(layers[0].unitCost.toFixed(5)).toBe(new Prisma.Decimal('4').toFixed(5));

    const jes = await getJEsForEntity('Invoice', invoiceId);
    const cogsRevJe = jes.find((j) => j.description.startsWith('Reverse COGS for invoice'));
    expect(cogsRevJe).toBeDefined();
    const dr = cogsRevJe!.lines.find((l) => l.account.code === '1310')!;
    const cr = cogsRevJe!.lines.find((l) => l.account.code === '5100')!;
    expect(dr.debit.toFixed(5)).toBe(new Prisma.Decimal('24').toFixed(5));
    expect(cr.credit.toFixed(5)).toBe(new Prisma.Decimal('24').toFixed(5));

    const item = await db.inventoryItem.findUniqueOrThrow({
      where: { variantId_warehouseId: { variantId: variantAId, warehouseId: warehouseAId } },
    });
    // 10 received - 6 consumed + 6 returned = 10.
    expect(item.onHand.toString()).toBe(new Prisma.Decimal('10').toString());
  });

  it('(2) idempotency: re-call reverseCogsForInvoiceTx after voidInvoice → already_reversed, no second JE', async () => {
    await stockBinViaReceipt('10', '4');
    const { invoiceId } = await closeSOSingleLine('6');
    await voidInvoice(db, invoiceId, 'first');

    const result = await db.$transaction((tx) =>
      reverseCogsForInvoiceTx(tx, invoiceId),
    );
    expect(result.skipped).toBe('already_reversed');
    expect(result.jeId).toBeNull();

    const reversalJes = await db.journalEntry.count({
      where: {
        entityType: 'Invoice',
        entityId: invoiceId,
        description: { startsWith: 'Reverse COGS for invoice' },
      },
    });
    expect(reversalJes).toBe(1);

    const returnMvs = await db.inventoryMovement.count({
      where: { variantId: variantAId, type: InventoryMovementType.RMA_RETURN },
    });
    expect(returnMvs).toBe(1);
  });

  it('(3) refuses when CreditApplication exists (existing AR-side precondition regression)', async () => {
    await stockBinViaReceipt('10', '4');
    const { invoiceId } = await closeSOSingleLine('5');

    // Manually craft a payment + CreditApplication to simulate "live AR
    // applied" without going through the payments service.
    const pmt = await db.payment.create({
      data: {
        number: `${TAG}-PMT-${Math.random().toString(36).slice(2, 8)}`,
        customerId,
        method: 'CHECK',
        amount: new Prisma.Decimal('100'),
      },
    });
    await db.creditApplication.create({
      data: {
        kind: CreditApplicationKind.PAYMENT_TO_INVOICE,
        paymentId: pmt.id,
        invoiceId,
        amount: new Prisma.Decimal('100'),
      },
    });

    await expect(voidInvoice(db, invoiceId, 'with payment')).rejects.toThrow(
      /Cannot void invoice with applied payments/,
    );

    // Cleanup: reverse the app + null the payment FK so wipe can sweep.
    await db.creditApplication.deleteMany({ where: { paymentId: pmt.id } });
    await db.payment.deleteMany({ where: { id: pmt.id } });
  });

  it('(4) refuses void when a CM with cogsReversed=true exists for the invoice (new precondition)', async () => {
    await stockBinViaReceipt('10', '4');
    const { invoiceId } = await closeSOSingleLine('5');

    const lines = await getInvoiceLines(invoiceId);
    expect(lines).toHaveLength(1);

    await buildAndInspectRma(invoiceId, [
      { invoiceLineId: lines[0].id, qty: '5' },
    ]);
    const cm = await creditFromRma(
      db,
      (await db.rma.findFirstOrThrow({ where: { invoiceId } })).id,
      {
        lines: [
          {
            invoiceLineId: lines[0].id,
            qty: '5',
            unitPrice: '20',
            description: 'Return',
          },
        ],
      },
    );
    expect(cm.creditMemo.cogsReversed).toBe(true);

    // The auto-app blocks the AR-side precondition; reverse it so the new
    // precondition is the one that fires.
    await db.creditApplication.updateMany({
      where: { creditMemoId: cm.creditMemo.id, reversedAt: null },
      data: { reversedAt: new Date(), notes: 'test setup: clear for void check' },
    });

    await expect(voidInvoice(db, invoiceId, 'try void')).rejects.toThrow(
      /credit memo .* has already had its COGS reversed/,
    );
  });

  it('(5) zero-COGS invoice: voidInvoice runs but reversal hits zero_reversal path; only AR-reversal JE posts', async () => {
    // Seed via receiveInventory (back-compat path) → no FifoLayer → close
    // SO sets cogsPosted=true but produces zero FifoConsumption rows.
    // voidInvoice's reversal walks lines, every line skips with zero_cogs,
    // aggregate is empty, finalize hits zero-reversal short-circuit.
    // Only AR-reversal JE posts.
    await receiveInventory(db, {
      variantId: variantAId,
      warehouseId: warehouseAId,
      qty: '10',
      reference: `${TAG}-NOLAYER-SEED`,
    });
    const { invoiceId } = await closeSOSingleLine('6');

    const inv = await db.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect(inv.cogsPosted).toBe(true);

    await voidInvoice(db, invoiceId, 'zero-COGS void');

    const after = await db.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect(after.cogsReversed).toBe(true);

    const returnMvs = await db.inventoryMovement.count({
      where: { variantId: variantAId, type: InventoryMovementType.RMA_RETURN },
    });
    expect(returnMvs).toBe(0);

    const reversalLayers = await db.fifoLayer.count({
      where: { variantId: variantAId, sourceReceiptLineId: null },
    });
    expect(reversalLayers).toBe(0);

    const jes = await getJEsForEntity('Invoice', invoiceId);
    const cogsRevJe = jes.find((j) =>
      j.description.startsWith('Reverse COGS for invoice'),
    );
    expect(cogsRevJe).toBeUndefined();
    const voidJe = jes.find((j) => j.description.startsWith('Void of invoice'));
    expect(voidJe).toBeDefined();
  });

  it('(6) multi-warehouse void: 2 RMA_RETURN movements, 2 layers, JE with 2 DR + 1 CR', async () => {
    await stockBinViaReceipt('5', '5', { variant: variantAId, warehouse: warehouseAId });
    await stockBinViaReceipt('3', '7', { variant: variantBId, warehouse: warehouseBId });

    const so = await createSalesOrder(db, {
      customerId,
      warehouseId: warehouseAId,
      lines: [
        { variantId: variantAId, warehouseId: warehouseAId, qtyOrdered: '5' },
        { variantId: variantBId, warehouseId: warehouseBId, qtyOrdered: '3' },
      ],
    });
    await confirmSalesOrder(db, so.id);
    await closeSalesOrder(db, so.id, undefined);
    const invoice = await db.invoice.findUniqueOrThrow({ where: { salesOrderId: so.id } });

    await voidInvoice(db, invoice.id, 'multi-wh void');

    const returnMvs = await db.inventoryMovement.findMany({
      where: { variantId: { in: [variantAId, variantBId] }, type: InventoryMovementType.RMA_RETURN },
    });
    expect(returnMvs).toHaveLength(2);

    const reversalLayers = await db.fifoLayer.findMany({
      where: { sourceMovementId: { in: returnMvs.map((m) => m.id) } },
    });
    expect(reversalLayers).toHaveLength(2);

    const jes = await getJEsForEntity('Invoice', invoice.id);
    const cogsRevJe = jes.find((j) => j.description.startsWith('Reverse COGS for invoice'));
    expect(cogsRevJe).toBeDefined();
    // Both warehouses share account 1310 in pilot seed, so 2 DR lines
    // both targeting 1310, plus 1 CR 5100.
    const drs = cogsRevJe!.lines.filter((l) => l.debit.greaterThan(0));
    const crs = cogsRevJe!.lines.filter((l) => l.credit.greaterThan(0));
    expect(drs).toHaveLength(2);
    expect(crs).toHaveLength(1);
    expect(crs[0].account.code).toBe('5100');
    // Total: 5*5 + 3*7 = 46.
    const drTotal = drs.reduce((acc, l) => acc.plus(l.debit), new Prisma.Decimal(0));
    expect(drTotal.toFixed(5)).toBe(new Prisma.Decimal('46').toFixed(5));
    expect(crs[0].credit.toFixed(5)).toBe(new Prisma.Decimal('46').toFixed(5));
  });

  // ==========================================================================
  // creditFromRma path (tests 7-14)
  // ==========================================================================

  it('(7) goods-back full RMA reverses COGS, creates RMA_RETURN + new layer at original cost, JE posts', async () => {
    await stockBinViaReceipt('10', '5');
    const { invoiceId } = await closeSOSingleLine('10');
    const lines = await getInvoiceLines(invoiceId);
    const rmaId = await buildAndInspectRma(invoiceId, [
      { invoiceLineId: lines[0].id, qty: '10' },
    ]);

    const result = await creditFromRma(db, rmaId, {
      lines: [
        {
          invoiceLineId: lines[0].id,
          qty: '10',
          unitPrice: '20',
          description: 'Return full',
        },
      ],
    });
    expect(result.creditMemo.cogsReversed).toBe(true);

    const returns = await db.inventoryMovement.findMany({
      where: { variantId: variantAId, type: InventoryMovementType.RMA_RETURN },
    });
    expect(returns).toHaveLength(1);
    expect(returns[0].qty.toString()).toBe(new Prisma.Decimal('10').toString());
    expect(returns[0].unitCost!.toFixed(5)).toBe(new Prisma.Decimal('5').toFixed(5));

    const layers = await db.fifoLayer.findMany({
      where: { sourceMovementId: returns[0].id },
    });
    expect(layers).toHaveLength(1);
    expect(layers[0].qtyRemaining.toString()).toBe(new Prisma.Decimal('10').toString());
    expect(layers[0].unitCost.toFixed(5)).toBe(new Prisma.Decimal('5').toFixed(5));

    const cmJes = await getJEsForEntity('CreditMemo', result.creditMemo.id);
    const cogsRevJe = cmJes.find((j) => j.description.startsWith('Reverse COGS for credit memo'));
    expect(cogsRevJe).toBeDefined();
    const dr = cogsRevJe!.lines.find((l) => l.account.code === '1310')!;
    const cr = cogsRevJe!.lines.find((l) => l.account.code === '5100')!;
    expect(dr.debit.toFixed(5)).toBe(new Prisma.Decimal('50').toFixed(5));
    expect(cr.credit.toFixed(5)).toBe(new Prisma.Decimal('50').toFixed(5));
  });

  it('(8) goods-back PARTIAL: 3 of 10 → COGS reverses pro-rata at 30%, layer qty=3 at original cost', async () => {
    await stockBinViaReceipt('10', '5');
    const { invoiceId } = await closeSOSingleLine('10');
    const lines = await getInvoiceLines(invoiceId);
    const rmaId = await buildAndInspectRma(invoiceId, [
      { invoiceLineId: lines[0].id, qty: '10' },
    ]);

    const result = await creditFromRma(db, rmaId, {
      lines: [
        {
          invoiceLineId: lines[0].id,
          qty: '3',
          unitPrice: '20',
          description: 'Partial return',
        },
      ],
    });
    expect(result.creditMemo.cogsReversed).toBe(true);

    const returns = await db.inventoryMovement.findMany({
      where: { variantId: variantAId, type: InventoryMovementType.RMA_RETURN },
    });
    expect(returns).toHaveLength(1);
    expect(returns[0].qty.toString()).toBe(new Prisma.Decimal('3').toString());

    const layers = await db.fifoLayer.findMany({
      where: { sourceMovementId: returns[0].id },
    });
    expect(layers).toHaveLength(1);
    expect(layers[0].qtyReceived.toString()).toBe(new Prisma.Decimal('3').toString());
    expect(layers[0].unitCost.toFixed(5)).toBe(new Prisma.Decimal('5').toFixed(5));

    const cmJes = await getJEsForEntity('CreditMemo', result.creditMemo.id);
    const cogsRevJe = cmJes.find((j) => j.description.startsWith('Reverse COGS for credit memo'));
    expect(cogsRevJe).toBeDefined();
    const dr = cogsRevJe!.lines.find((l) => l.account.code === '1310')!;
    expect(dr.debit.toFixed(5)).toBe(new Prisma.Decimal('15').toFixed(5));
  });

  it('(9) loss-reclass full (SHIPPING_DAMAGE): JE posts DR 5920 / CR 5100, no RMA_RETURN, no new layer', async () => {
    await stockBinViaReceipt('10', '5');
    const { invoiceId } = await closeSOSingleLine('10');
    const lines = await getInvoiceLines(invoiceId);
    const rmaId = await buildAndInspectRma(invoiceId, [
      { invoiceLineId: lines[0].id, qty: '10' },
    ]);

    const result = await creditFromRma(db, rmaId, {
      categoryId: shippingDamageCategoryId,
      lines: [
        {
          invoiceLineId: lines[0].id,
          qty: '10',
          unitPrice: '20',
          description: 'Shipping damage',
        },
      ],
    });
    expect(result.creditMemo.cogsReversed).toBe(true);

    const returns = await db.inventoryMovement.count({
      where: { variantId: variantAId, type: InventoryMovementType.RMA_RETURN },
    });
    expect(returns).toBe(0);
    const reversalLayers = await db.fifoLayer.count({
      where: { variantId: variantAId, sourceReceiptLineId: null },
    });
    expect(reversalLayers).toBe(0);

    const cmJes = await getJEsForEntity('CreditMemo', result.creditMemo.id);
    const lossJe = cmJes.find((j) =>
      j.description.startsWith('Loss reclassification for credit memo'),
    );
    expect(lossJe).toBeDefined();
    const dr = lossJe!.lines.find((l) => l.account.code === '5920')!;
    const cr = lossJe!.lines.find((l) => l.account.code === '5100')!;
    expect(dr.debit.toFixed(5)).toBe(new Prisma.Decimal('50').toFixed(5));
    expect(cr.credit.toFixed(5)).toBe(new Prisma.Decimal('50').toFixed(5));
  });

  it('(10) loss-reclass PARTIAL (SHIPPING_DAMAGE, 3 of 10): JE DR 5920=15 / CR 5100=15', async () => {
    await stockBinViaReceipt('10', '5');
    const { invoiceId } = await closeSOSingleLine('10');
    const lines = await getInvoiceLines(invoiceId);
    const rmaId = await buildAndInspectRma(invoiceId, [
      { invoiceLineId: lines[0].id, qty: '10' },
    ]);

    const result = await creditFromRma(db, rmaId, {
      categoryId: shippingDamageCategoryId,
      lines: [
        {
          invoiceLineId: lines[0].id,
          qty: '3',
          unitPrice: '20',
          description: 'Partial shipping damage',
        },
      ],
    });

    const cmJes = await getJEsForEntity('CreditMemo', result.creditMemo.id);
    const lossJe = cmJes.find((j) =>
      j.description.startsWith('Loss reclassification for credit memo'),
    );
    expect(lossJe).toBeDefined();
    const dr = lossJe!.lines.find((l) => l.account.code === '5920')!;
    const cr = lossJe!.lines.find((l) => l.account.code === '5100')!;
    expect(dr.debit.toFixed(5)).toBe(new Prisma.Decimal('15').toFixed(5));
    expect(cr.credit.toFixed(5)).toBe(new Prisma.Decimal('15').toFixed(5));
  });

  it('(11) pure-AR direct call (PRICING_DISPUTE standalone CM, no RMA): skipped=pure_ar, no JE', async () => {
    await stockBinViaReceipt('10', '5');
    const { invoiceId } = await closeSOSingleLine('10');
    const lines = await getInvoiceLines(invoiceId);

    // Standalone CM (no RMA), category=PRICING_DISPUTE.
    const draft = await createCreditMemoDraft(db, {
      customerId,
      invoiceId,
      categoryId: pricingDisputeCategoryId,
      amount: '20',
      lines: [
        {
          invoiceLineId: lines[0].id,
          variantId: variantAId,
          qty: '1',
          unitPrice: '20',
          description: 'Pricing adjustment',
        },
      ],
    });
    const confirmed = await confirmCreditMemo(db, draft.id);

    const result = await db.$transaction((tx) =>
      reverseCogsForCreditMemoTx(tx, confirmed.id),
    );
    expect(result.skipped).toBe('pure_ar');
    expect(result.jeId).toBeNull();

    const cmFresh = await db.creditMemo.findUniqueOrThrow({ where: { id: confirmed.id } });
    expect(cmFresh.cogsReversed).toBe(false);

    // No COGS-reversal JE. Only the AR-side JE from confirmCreditMemoTx.
    const cmJes = await getJEsForEntity('CreditMemo', confirmed.id);
    const cogsRevJe = cmJes.find((j) => j.description.startsWith('Reverse COGS for credit memo'));
    expect(cogsRevJe).toBeUndefined();
  });

  it('(12) pure-AR via creditFromRma when RMA is returnless (RETURN category): no COGS JE, cogsReversed stays false', async () => {
    await stockBinViaReceipt('10', '5');
    const { invoiceId } = await closeSOSingleLine('10');
    const lines = await getInvoiceLines(invoiceId);

    // Returnless RMA still walks the state machine to INSPECTED — the
    // returnless flag is a metadata-only signal, not a state shortcut.
    const rmaId = await buildAndInspectRma(
      invoiceId,
      [{ invoiceLineId: lines[0].id, qty: '10' }],
      { returnless: true },
    );

    const result = await creditFromRma(db, rmaId, {
      lines: [
        {
          invoiceLineId: lines[0].id,
          qty: '10',
          unitPrice: '20',
          description: 'Returnless return',
        },
      ],
    });
    expect(result.creditMemo.cogsReversed).toBe(false);

    const cmJes = await getJEsForEntity('CreditMemo', result.creditMemo.id);
    const cogsRevJe = cmJes.find(
      (j) =>
        j.description.startsWith('Reverse COGS for credit memo') ||
        j.description.startsWith('Loss reclassification for credit memo'),
    );
    expect(cogsRevJe).toBeUndefined();

    const returns = await db.inventoryMovement.count({
      where: { variantId: variantAId, type: InventoryMovementType.RMA_RETURN },
    });
    expect(returns).toBe(0);
  });

  it('(13) idempotency: re-call reverseCogsForCreditMemoTx after creditFromRma → already_reversed, no second JE', async () => {
    await stockBinViaReceipt('10', '5');
    const { invoiceId } = await closeSOSingleLine('10');
    const lines = await getInvoiceLines(invoiceId);
    const rmaId = await buildAndInspectRma(invoiceId, [
      { invoiceLineId: lines[0].id, qty: '10' },
    ]);
    const result = await creditFromRma(db, rmaId, {
      lines: [
        {
          invoiceLineId: lines[0].id,
          qty: '10',
          unitPrice: '20',
          description: 'Return',
        },
      ],
    });

    const reCall = await db.$transaction((tx) =>
      reverseCogsForCreditMemoTx(tx, result.creditMemo.id),
    );
    expect(reCall.skipped).toBe('already_reversed');
    expect(reCall.jeId).toBeNull();

    const cogsRevJes = await db.journalEntry.count({
      where: {
        entityType: 'CreditMemo',
        entityId: result.creditMemo.id,
        description: { startsWith: 'Reverse COGS for credit memo' },
      },
    });
    expect(cogsRevJes).toBe(1);
  });

  it('(14) multi-warehouse RMA: 2 RMA_RETURN movements, 2 layers, JE with per-warehouse DR lines', async () => {
    await stockBinViaReceipt('4', '5', { variant: variantAId, warehouse: warehouseAId });
    await stockBinViaReceipt('3', '7', { variant: variantBId, warehouse: warehouseBId });

    const so = await createSalesOrder(db, {
      customerId,
      warehouseId: warehouseAId,
      lines: [
        { variantId: variantAId, warehouseId: warehouseAId, qtyOrdered: '4' },
        { variantId: variantBId, warehouseId: warehouseBId, qtyOrdered: '3' },
      ],
    });
    await confirmSalesOrder(db, so.id);
    await closeSalesOrder(db, so.id, undefined);
    const invoice = await db.invoice.findUniqueOrThrow({ where: { salesOrderId: so.id } });
    const lines = await getInvoiceLines(invoice.id);
    // Look up by variantId rather than position. Belt-and-suspenders with
    // the getInvoiceLines id-tiebreaker — makes the semantic mapping
    // explicit at the call site so any future reorder is harmless.
    const lineByVariant = new Map(lines.map((l) => [l.variantId, l]));

    const rmaId = await buildAndInspectRma(invoice.id, [
      { invoiceLineId: lineByVariant.get(variantAId)!.id, qty: '4' },
      { invoiceLineId: lineByVariant.get(variantBId)!.id, qty: '3' },
    ]);
    const result = await creditFromRma(db, rmaId, {
      lines: [
        { invoiceLineId: lineByVariant.get(variantAId)!.id, qty: '4', unitPrice: '20', description: 'A return' },
        { invoiceLineId: lineByVariant.get(variantBId)!.id, qty: '3', unitPrice: '20', description: 'B return' },
      ],
    });
    expect(result.creditMemo.cogsReversed).toBe(true);

    const returns = await db.inventoryMovement.findMany({
      where: { variantId: { in: [variantAId, variantBId] }, type: InventoryMovementType.RMA_RETURN },
    });
    expect(returns).toHaveLength(2);

    const layers = await db.fifoLayer.findMany({
      where: { sourceMovementId: { in: returns.map((m) => m.id) } },
    });
    expect(layers).toHaveLength(2);

    const cmJes = await getJEsForEntity('CreditMemo', result.creditMemo.id);
    const cogsRevJe = cmJes.find((j) => j.description.startsWith('Reverse COGS for credit memo'));
    expect(cogsRevJe).toBeDefined();
    const drs = cogsRevJe!.lines.filter((l) => l.debit.greaterThan(0));
    const crs = cogsRevJe!.lines.filter((l) => l.credit.greaterThan(0));
    expect(drs).toHaveLength(2);
    expect(crs).toHaveLength(1);
    // 4*5 + 3*7 = 41.
    const drTotal = drs.reduce((acc, l) => acc.plus(l.debit), new Prisma.Decimal(0));
    expect(drTotal.toFixed(5)).toBe(new Prisma.Decimal('41').toFixed(5));
  });

  // ==========================================================================
  // skippedLines edge cases (3 small smoke tests via direct calls)
  // ==========================================================================

  it('(15) skippedLines records no_so_link when an InvoiceLine has null salesOrderLineId', async () => {
    // Manually craft an Invoice with cogsPosted=true and one InvoiceLine
    // with salesOrderLineId=null. Direct-call reverseCogsForInvoiceTx.
    const so = await createSalesOrder(db, {
      customerId,
      warehouseId: warehouseAId,
      lines: [{ variantId: variantAId, warehouseId: warehouseAId, qtyOrdered: '1' }],
    });
    await confirmSalesOrder(db, so.id);

    const invoice = await db.invoice.create({
      data: {
        number: `${TAG}-INV-NOLINK-${Math.random().toString(36).slice(2, 8)}`,
        salesOrderId: so.id,
        customerId,
        warehouseId: warehouseAId,
        status: InvoiceStatus.OPEN,
        subtotal: new Prisma.Decimal('20'),
        total: new Prisma.Decimal('20'),
        cogsPosted: true, // simulate a Part-3-posted invoice
        lines: {
          create: [
            {
              salesOrderLineId: null,
              variantId: variantAId,
              description: 'Service line — no SO link',
              qty: new Prisma.Decimal('1'),
              unitPrice: new Prisma.Decimal('20'),
              lineTotal: new Prisma.Decimal('20'),
            },
          ],
        },
      },
      include: { lines: true },
    });

    const result = await db.$transaction((tx) =>
      reverseCogsForInvoiceTx(tx, invoice.id),
    );
    expect(result.skipped).toBe('zero_reversal');
    expect(result.skippedLines).toHaveLength(1);
    expect(result.skippedLines[0].reason).toBe('no_so_link');
    expect(result.skippedLines[0].lineId).toBe(invoice.lines[0].id);
  });

  it('(16) skippedLines records no_inventory_movement when SOLine has null inventoryMovementId', async () => {
    // SO not closed → its SOL has inventoryMovementId=null.
    const so = await createSalesOrder(db, {
      customerId,
      warehouseId: warehouseAId,
      lines: [{ variantId: variantAId, warehouseId: warehouseAId, qtyOrdered: '2' }],
    });
    await confirmSalesOrder(db, so.id);
    const sol = await db.salesOrderLine.findFirstOrThrow({
      where: { salesOrderId: so.id },
    });
    expect(sol.inventoryMovementId).toBeNull();

    const invoice = await db.invoice.create({
      data: {
        number: `${TAG}-INV-NOMV-${Math.random().toString(36).slice(2, 8)}`,
        salesOrderId: so.id,
        customerId,
        warehouseId: warehouseAId,
        status: InvoiceStatus.OPEN,
        subtotal: new Prisma.Decimal('40'),
        total: new Prisma.Decimal('40'),
        cogsPosted: true,
        lines: {
          create: [
            {
              salesOrderLineId: sol.id,
              variantId: variantAId,
              description: 'No movement',
              qty: new Prisma.Decimal('2'),
              unitPrice: new Prisma.Decimal('20'),
              lineTotal: new Prisma.Decimal('40'),
            },
          ],
        },
      },
      include: { lines: true },
    });

    const result = await db.$transaction((tx) =>
      reverseCogsForInvoiceTx(tx, invoice.id),
    );
    expect(result.skipped).toBe('zero_reversal');
    expect(result.skippedLines).toHaveLength(1);
    expect(result.skippedLines[0].reason).toBe('no_inventory_movement');
    expect(result.skippedLines[0].lineId).toBe(invoice.lines[0].id);
  });

  it('(17) skippedLines records zero_cogs when the consume movement has no FifoConsumption rows', async () => {
    // Same setup as test 5 (zero-COGS via receiveInventory back-compat).
    // After close, the SOL has inventoryMovementId set but the CONSUME
    // movement has zero FifoConsumption rows → skip with reason=zero_cogs.
    await receiveInventory(db, {
      variantId: variantAId,
      warehouseId: warehouseAId,
      qty: '5',
      reference: `${TAG}-ZEROCOGS-SEED`,
    });
    const { invoiceId } = await closeSOSingleLine('3');

    const result = await db.$transaction((tx) =>
      reverseCogsForInvoiceTx(tx, invoiceId),
    );
    expect(result.skipped).toBe('zero_reversal');
    expect(result.skippedLines).toHaveLength(1);
    expect(result.skippedLines[0].reason).toBe('zero_cogs');
  });
});
