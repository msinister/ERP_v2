import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  Prisma,
  PurchaseOrderStatus,
  ReceiptStatus,
  InventoryMovementType,
} from '@/generated/tenant';
import type { PrismaClient } from '@/generated/tenant';
import {
  confirmPurchaseOrder,
  createPurchaseOrder,
} from '@/server/services/purchaseOrders';
import {
  cancelReceipt,
  createDraftReceipt,
  postReceipt,
} from '@/server/services/receipts';
import { hasTenantDb, makeClient } from '../helpers/db';
import { upsertTestWarehouse } from '../helpers/warehouseStub';

const suite = hasTenantDb ? describe : describe.skip;

suite('Receipt service', () => {
  let db: PrismaClient;
  let vendorId: string;
  let warehouseId: string;
  let productId: string;
  let variantAId: string;
  let variantBId: string;

  beforeAll(async () => {
    db = makeClient();
    const v = await db.vendor.upsert({
      where: { code: 'TEST-VEND-RCPT' },
      create: { code: 'TEST-VEND-RCPT', name: 'Test Receipt Vendor' },
      update: { active: true, deletedAt: null },
    });
    vendorId = v.id;
    // Use upsertTestWarehouse so the warehouse gets the 1310 inventory
    // account link. postReceipt now requires the warehouse-link for its
    // GL leg (Module 08 GL counterpart-leg slice).
    const wh = await upsertTestWarehouse(db, {
      code: 'TEST-WH-RCPT',
      name: 'Test Receipt Warehouse',
    });
    warehouseId = wh.id;
    const product = await db.product.upsert({
      where: { sku: 'TEST-PROD-RCPT' },
      create: { sku: 'TEST-PROD-RCPT', name: 'Test Receipt Product' },
      update: { active: true, deletedAt: null },
    });
    productId = product.id;
    const va = await db.productVariant.upsert({
      where: { sku: 'TEST-PROD-RCPT-A' },
      create: { productId: product.id, sku: 'TEST-PROD-RCPT-A', name: 'Variant A' },
      update: { productId: product.id, active: true, deletedAt: null },
    });
    const vb = await db.productVariant.upsert({
      where: { sku: 'TEST-PROD-RCPT-B' },
      create: { productId: product.id, sku: 'TEST-PROD-RCPT-B', name: 'Variant B' },
      update: { productId: product.id, active: true, deletedAt: null },
    });
    variantAId = va.id;
    variantBId = vb.id;
  });

  beforeEach(async () => {
    await wipeRow();
  });

  afterAll(async () => {
    await wipeRow();
    const variantIds = [variantAId, variantBId];
    await db.productVariant.deleteMany({ where: { id: { in: variantIds } } });
    await db.product.deleteMany({ where: { id: productId } });
    await db.warehouse.deleteMany({ where: { id: warehouseId } });
    await db.vendor.deleteMany({ where: { id: vendorId } });
    await db.$disconnect();
  });

  // Scoped cleanup helper — extended in Phase 1B to wipe FifoLayer +
  // FifoConsumption rows that postReceipt now creates. Snapshots
  // test-owned ids first, deletes children before parents, scopes every
  // deleteMany. Same pattern as fifoLayers.test.ts.
  async function wipeRow(): Promise<void> {
    const variantIds = [variantAId, variantBId];
    const ourMovements = await db.inventoryMovement.findMany({
      where: { variantId: { in: variantIds } },
      select: { id: true },
    });
    const movementIds = ourMovements.map((m) => m.id);

    const ourLayers = await db.fifoLayer.findMany({
      where: { variantId: { in: variantIds } },
      select: { id: true },
    });
    const layerIds = ourLayers.map((l) => l.id);

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
    }
    await db.receiptLine.deleteMany({ where: { variantId: { in: variantIds } } });
    await db.receipt.deleteMany({ where: { vendorId, warehouseId } });
    await db.purchaseOrderLine.deleteMany({ where: { variantId: { in: variantIds } } });
    await db.purchaseOrder.deleteMany({ where: { vendorId } });
    await db.inventoryMovement.deleteMany({ where: { variantId: { in: variantIds } } });
    await db.inventoryItem.deleteMany({ where: { variantId: { in: variantIds } } });
  }

  it('createDraftReceipt + postReceipt against a single PO updates inventory and PO state', async () => {
    const po = await createPurchaseOrder(db, {
      vendorId,
      lines: [
        { variantId: variantAId, warehouseId, qtyOrdered: '20', unitCost: '5' },
        { variantId: variantBId, warehouseId, qtyOrdered: '10', unitCost: '8' },
      ],
    });
    await confirmPurchaseOrder(db, po.id);
    const poFresh = await db.purchaseOrder.findUnique({ where: { id: po.id }, include: { lines: true } });
    const lineA = poFresh!.lines.find((l) => l.variantId === variantAId)!;
    const lineB = poFresh!.lines.find((l) => l.variantId === variantBId)!;

    const draft = await createDraftReceipt(db, {
      vendorId,
      warehouseId,
      lines: [
        { purchaseOrderLineId: lineA.id, variantId: variantAId, warehouseId, qtyReceived: '15', unitCost: '5' },
        { purchaseOrderLineId: lineB.id, variantId: variantBId, warehouseId, qtyReceived: '10', unitCost: '8' },
      ],
    });
    expect(draft.status).toBe(ReceiptStatus.DRAFT);
    expect(draft.number).toMatch(/^RCPT-\d{4}-\d{5}$/);

    const posted = await postReceipt(db, draft.id);
    expect(posted.status).toBe(ReceiptStatus.POSTED);
    expect(posted.wasOverReceived).toBe(false);

    // Inventory updated through the movements service.
    const invA = await db.inventoryItem.findUnique({
      where: { variantId_warehouseId: { variantId: variantAId, warehouseId } },
    });
    expect(invA!.onHand.toString()).toBe(new Prisma.Decimal('15').toString());

    // Each ReceiptLine has its inventoryMovementId set.
    const lines = await db.receiptLine.findMany({ where: { receiptId: posted.id }, orderBy: { createdAt: 'asc' } });
    for (const l of lines) {
      expect(l.inventoryMovementId).not.toBeNull();
      const mv = await db.inventoryMovement.findUnique({ where: { id: l.inventoryMovementId! } });
      expect(mv!.type).toBe(InventoryMovementType.RECEIVE);
      expect(mv!.reference).toBe(posted.number);
    }

    // PO is partially received (15/20 on A, 10/10 on B → not all lines fully met).
    const poAfter = await db.purchaseOrder.findUnique({ where: { id: po.id } });
    expect(poAfter!.status).toBe(PurchaseOrderStatus.PARTIALLY_RECEIVED);
    const lineAAfter = await db.purchaseOrderLine.findUnique({ where: { id: lineA.id } });
    expect(lineAAfter!.qtyReceived.toString()).toBe(new Prisma.Decimal('15').toString());
  });

  it('KEYSTONE: one Receipt spanning two POs rolls each PO up independently', async () => {
    const po1 = await createPurchaseOrder(db, {
      vendorId,
      lines: [{ variantId: variantAId, warehouseId, qtyOrdered: '10', unitCost: '5' }],
    });
    const po2 = await createPurchaseOrder(db, {
      vendorId,
      lines: [{ variantId: variantBId, warehouseId, qtyOrdered: '6', unitCost: '8' }],
    });
    await confirmPurchaseOrder(db, po1.id);
    await confirmPurchaseOrder(db, po2.id);

    const lineA = (await db.purchaseOrderLine.findFirst({ where: { purchaseOrderId: po1.id } }))!;
    const lineB = (await db.purchaseOrderLine.findFirst({ where: { purchaseOrderId: po2.id } }))!;

    // ONE shipment from the vendor containing items from BOTH POs.
    const draft = await createDraftReceipt(db, {
      vendorId,
      warehouseId,
      lines: [
        // Partial fill of PO1 line.
        { purchaseOrderLineId: lineA.id, variantId: variantAId, warehouseId, qtyReceived: '4', unitCost: '5' },
        // Full fill of PO2 line.
        { purchaseOrderLineId: lineB.id, variantId: variantBId, warehouseId, qtyReceived: '6', unitCost: '8' },
      ],
    });
    const posted = await postReceipt(db, draft.id);
    expect(posted.affectedPurchaseOrderIds.sort()).toEqual([po1.id, po2.id].sort());

    const po1After = await db.purchaseOrder.findUnique({ where: { id: po1.id } });
    const po2After = await db.purchaseOrder.findUnique({ where: { id: po2.id } });
    expect(po1After!.status).toBe(PurchaseOrderStatus.PARTIALLY_RECEIVED);
    expect(po2After!.status).toBe(PurchaseOrderStatus.CLOSED);

    const lineAAfter = await db.purchaseOrderLine.findUnique({ where: { id: lineA.id } });
    const lineBAfter = await db.purchaseOrderLine.findUnique({ where: { id: lineB.id } });
    expect(lineAAfter!.qtyReceived.toString()).toBe(new Prisma.Decimal('4').toString());
    expect(lineBAfter!.qtyReceived.toString()).toBe(new Prisma.Decimal('6').toString());

    // Both ReceiptLine.inventoryMovementId values set.
    const rlines = await db.receiptLine.findMany({ where: { receiptId: posted.id } });
    expect(rlines).toHaveLength(2);
    for (const rl of rlines) {
      expect(rl.inventoryMovementId).not.toBeNull();
    }
  });

  it('over-receive flag flips wasOverReceived true but does not block', async () => {
    const po = await createPurchaseOrder(db, {
      vendorId,
      lines: [{ variantId: variantAId, warehouseId, qtyOrdered: '10', unitCost: '5' }],
    });
    await confirmPurchaseOrder(db, po.id);
    const poLine = (await db.purchaseOrderLine.findFirst({ where: { purchaseOrderId: po.id } }))!;

    const draft = await createDraftReceipt(db, {
      vendorId,
      warehouseId,
      lines: [{ purchaseOrderLineId: poLine.id, variantId: variantAId, warehouseId, qtyReceived: '12', unitCost: '5' }],
    });
    const posted = await postReceipt(db, draft.id);
    expect(posted.wasOverReceived).toBe(true);

    const poAfter = await db.purchaseOrder.findUnique({ where: { id: po.id } });
    expect(poAfter!.status).toBe(PurchaseOrderStatus.CLOSED);
  });

  it('createDraftReceipt rejects line warehouse mismatch', async () => {
    const otherWh = await db.warehouse.upsert({
      where: { code: 'TEST-WH-RCPT-2' },
      create: { code: 'TEST-WH-RCPT-2', name: 'Other Warehouse' },
      update: { active: true, deletedAt: null },
    });
    try {
      await expect(
        createDraftReceipt(db, {
          vendorId,
          warehouseId,
          lines: [{ variantId: variantAId, warehouseId: otherWh.id, qtyReceived: '1', unitCost: '1' }],
        }),
      ).rejects.toThrow(/warehouseId must match/);
    } finally {
      await db.warehouse.deleteMany({ where: { id: otherWh.id } });
    }
  });

  it('createDraftReceipt rejects PO line from a different vendor', async () => {
    const otherVendor = await db.vendor.upsert({
      where: { code: 'TEST-VEND-RCPT-OTHER' },
      create: { code: 'TEST-VEND-RCPT-OTHER', name: 'Other Vendor' },
      update: { active: true, deletedAt: null },
    });
    try {
      const otherPo = await createPurchaseOrder(db, {
        vendorId: otherVendor.id,
        lines: [{ variantId: variantAId, warehouseId, qtyOrdered: '5', unitCost: '5' }],
      });
      await confirmPurchaseOrder(db, otherPo.id);
      const otherLine = (await db.purchaseOrderLine.findFirst({ where: { purchaseOrderId: otherPo.id } }))!;

      await expect(
        createDraftReceipt(db, {
          vendorId,
          warehouseId,
          lines: [
            { purchaseOrderLineId: otherLine.id, variantId: variantAId, warehouseId, qtyReceived: '1', unitCost: '5' },
          ],
        }),
      ).rejects.toThrow(/vendor mismatch/);
    } finally {
      await db.purchaseOrderLine.deleteMany({ where: { purchaseOrder: { vendorId: otherVendor.id } } });
      await db.purchaseOrder.deleteMany({ where: { vendorId: otherVendor.id } });
      await db.vendor.deleteMany({ where: { id: otherVendor.id } });
    }
  });

  it('cancelReceipt reverses inventory via RECEIVE_REVERSE and rolls PO back', async () => {
    const po = await createPurchaseOrder(db, {
      vendorId,
      lines: [{ variantId: variantAId, warehouseId, qtyOrdered: '10', unitCost: '5' }],
    });
    await confirmPurchaseOrder(db, po.id);
    const poLine = (await db.purchaseOrderLine.findFirst({ where: { purchaseOrderId: po.id } }))!;

    const draft = await createDraftReceipt(db, {
      vendorId,
      warehouseId,
      lines: [{ purchaseOrderLineId: poLine.id, variantId: variantAId, warehouseId, qtyReceived: '4', unitCost: '5' }],
    });
    const posted = await postReceipt(db, draft.id);

    // Pre-cancel state.
    const invBefore = await db.inventoryItem.findUnique({
      where: { variantId_warehouseId: { variantId: variantAId, warehouseId } },
    });
    expect(invBefore!.onHand.toString()).toBe(new Prisma.Decimal('4').toString());

    await cancelReceipt(db, posted.id, { reason: 'wrong items shipped' });

    // Inventory restored.
    const invAfter = await db.inventoryItem.findUnique({
      where: { variantId_warehouseId: { variantId: variantAId, warehouseId } },
    });
    expect(invAfter!.onHand.toString()).toBe(new Prisma.Decimal('0').toString());

    // A RECEIVE_REVERSE movement was created.
    const reverses = await db.inventoryMovement.findMany({
      where: { variantId: variantAId, type: InventoryMovementType.RECEIVE_REVERSE },
    });
    expect(reverses).toHaveLength(1);
    expect(reverses[0].qty.toString()).toBe(new Prisma.Decimal('-4').toString());
    expect(reverses[0].reference).toMatch(/^RECEIPT_CANCEL:/);

    // PO line qtyReceived recomputed to 0.
    const lineAfter = await db.purchaseOrderLine.findUnique({ where: { id: poLine.id } });
    expect(lineAfter!.qtyReceived.toString()).toBe(new Prisma.Decimal('0').toString());
  });

  it('cancel-last-receipt: PO returns to CONFIRMED, not PARTIALLY_RECEIVED', async () => {
    const po = await createPurchaseOrder(db, {
      vendorId,
      lines: [{ variantId: variantAId, warehouseId, qtyOrdered: '10', unitCost: '5' }],
    });
    await confirmPurchaseOrder(db, po.id);
    const poLine = (await db.purchaseOrderLine.findFirst({ where: { purchaseOrderId: po.id } }))!;

    const draft = await createDraftReceipt(db, {
      vendorId,
      warehouseId,
      lines: [{ purchaseOrderLineId: poLine.id, variantId: variantAId, warehouseId, qtyReceived: '10', unitCost: '5' }],
    });
    const posted = await postReceipt(db, draft.id);

    // PO went to CLOSED.
    const poAtClose = await db.purchaseOrder.findUnique({ where: { id: po.id } });
    expect(poAtClose!.status).toBe(PurchaseOrderStatus.CLOSED);
    expect(poAtClose!.closedAt).not.toBeNull();

    // Cancel the only receipt.
    await cancelReceipt(db, posted.id, {});

    const poAfter = await db.purchaseOrder.findUnique({ where: { id: po.id } });
    expect(poAfter!.status).toBe(PurchaseOrderStatus.CONFIRMED);
    expect(poAfter!.closedAt).toBeNull();
  });

  it('cancel rejected on a draft (DRAFT) or already-cancelled receipt', async () => {
    const po = await createPurchaseOrder(db, {
      vendorId,
      lines: [{ variantId: variantAId, warehouseId, qtyOrdered: '5', unitCost: '5' }],
    });
    await confirmPurchaseOrder(db, po.id);
    const poLine = (await db.purchaseOrderLine.findFirst({ where: { purchaseOrderId: po.id } }))!;
    const draft = await createDraftReceipt(db, {
      vendorId,
      warehouseId,
      lines: [{ purchaseOrderLineId: poLine.id, variantId: variantAId, warehouseId, qtyReceived: '3', unitCost: '5' }],
    });

    await expect(cancelReceipt(db, draft.id, {})).rejects.toThrow(/Cannot cancel Receipt/);

    const posted = await postReceipt(db, draft.id);
    await cancelReceipt(db, posted.id, {});
    await expect(cancelReceipt(db, posted.id, {})).rejects.toThrow(/Cannot cancel Receipt/);
  });

  // ==========================================================================
  // Phase 1B — FifoLayer integration with postReceipt + cancelReceipt
  // ==========================================================================

  it('postReceipt single-line creates one FifoLayer with correct values + source FK links', async () => {
    const draft = await createDraftReceipt(db, {
      vendorId,
      warehouseId,
      lines: [
        { variantId: variantAId, warehouseId, qtyReceived: '10', unitCost: '5' },
      ],
    });
    const posted = await postReceipt(db, draft.id);
    const line = posted.lines.find((l) => l.variantId === variantAId)!;

    const layers = await db.fifoLayer.findMany({
      where: { variantId: variantAId, warehouseId },
    });
    expect(layers).toHaveLength(1);
    const layer = layers[0];
    expect(layer.qtyReceived.toString()).toBe(new Prisma.Decimal('10').toString());
    expect(layer.qtyConsumed.toString()).toBe(new Prisma.Decimal('0').toString());
    expect(layer.qtyRemaining.toString()).toBe(new Prisma.Decimal('10').toString());
    expect(layer.unitCost.toString()).toBe(new Prisma.Decimal('5').toString());
    expect(layer.sourceReceiptLineId).toBe(line.id);
    expect(layer.sourceMovementId).toBe(line.inventoryMovementId);
    expect(layer.deletedAt).toBeNull();
  });

  it('postReceipt multi-line creates one layer per line (3 lines → 3 layers)', async () => {
    // Three lines on two variants — A, B, A again. Each line is its own
    // layer because FifoLayer.sourceReceiptLineId is per-line, not
    // per-variant.
    const draft = await createDraftReceipt(db, {
      vendorId,
      warehouseId,
      lines: [
        { variantId: variantAId, warehouseId, qtyReceived: '4', unitCost: '1' },
        { variantId: variantBId, warehouseId, qtyReceived: '6', unitCost: '2' },
        { variantId: variantAId, warehouseId, qtyReceived: '3', unitCost: '7' },
      ],
    });
    const posted = await postReceipt(db, draft.id);
    expect(posted.lines).toHaveLength(3);

    const layers = await db.fifoLayer.findMany({
      where: { variantId: { in: [variantAId, variantBId] }, warehouseId },
      orderBy: { createdAt: 'asc' },
    });
    expect(layers).toHaveLength(3);

    const lineIds = posted.lines.map((l) => l.id).sort();
    const layerSourceIds = layers
      .map((l) => l.sourceReceiptLineId!)
      .sort();
    expect(layerSourceIds).toEqual(lineIds);
  });

  it('postReceipt sets RECEIVE movement.unitCost to match the line unitCost', async () => {
    const draft = await createDraftReceipt(db, {
      vendorId,
      warehouseId,
      lines: [
        { variantId: variantAId, warehouseId, qtyReceived: '8', unitCost: '5.5' },
      ],
    });
    const posted = await postReceipt(db, draft.id);
    const line = posted.lines.find((l) => l.variantId === variantAId)!;
    const movement = await db.inventoryMovement.findUniqueOrThrow({
      where: { id: line.inventoryMovementId! },
    });
    expect(movement.type).toBe(InventoryMovementType.RECEIVE);
    expect(movement.unitCost?.toString()).toBe(new Prisma.Decimal('5.5').toString());
  });

  it('postReceipt sets layer.receivedDate to match Receipt.receivedAt as read from DB', async () => {
    const draft = await createDraftReceipt(db, {
      vendorId,
      warehouseId,
      lines: [
        { variantId: variantAId, warehouseId, qtyReceived: '4', unitCost: '3' },
      ],
    });
    await postReceipt(db, draft.id);

    const receipt = await db.receipt.findUniqueOrThrow({ where: { id: draft.id } });
    const layer = await db.fifoLayer.findFirstOrThrow({
      where: { variantId: variantAId, warehouseId },
    });
    expect(receipt.receivedAt).not.toBeNull();
    expect(layer.receivedDate.toISOString()).toBe(receipt.receivedAt!.toISOString());
  });

  it('cancelReceipt with all-clean layers soft-deletes them (deletedAt populated)', async () => {
    const draft = await createDraftReceipt(db, {
      vendorId,
      warehouseId,
      lines: [
        { variantId: variantAId, warehouseId, qtyReceived: '5', unitCost: '2' },
        { variantId: variantBId, warehouseId, qtyReceived: '7', unitCost: '4' },
      ],
    });
    const posted = await postReceipt(db, draft.id);
    const layersBefore = await db.fifoLayer.findMany({
      where: { variantId: { in: [variantAId, variantBId] }, warehouseId },
    });
    expect(layersBefore).toHaveLength(2);
    expect(layersBefore.every((l) => l.deletedAt === null)).toBe(true);

    await cancelReceipt(db, posted.id, {});

    const layersAfter = await db.fifoLayer.findMany({
      where: { id: { in: layersBefore.map((l) => l.id) } },
    });
    expect(layersAfter).toHaveLength(2);
    expect(layersAfter.every((l) => l.deletedAt !== null)).toBe(true);
  });

  it('cancelReceipt with consumed layers throws the terse error', async () => {
    const draft = await createDraftReceipt(db, {
      vendorId,
      warehouseId,
      lines: [
        { variantId: variantAId, warehouseId, qtyReceived: '10', unitCost: '5' },
      ],
    });
    const posted = await postReceipt(db, draft.id);
    const layer = await db.fifoLayer.findFirstOrThrow({
      where: { variantId: variantAId, warehouseId },
    });
    // Phase 1C wires consumeFromLayersTx into consumeInventoryTx; here we
    // simulate "some inventory has been consumed from this layer" with a
    // direct write that respects the CHECK constraints
    // (qtyConsumed <= qtyReceived AND qtyRemaining = qtyReceived - qtyConsumed).
    await db.fifoLayer.update({
      where: { id: layer.id },
      data: {
        qtyConsumed: new Prisma.Decimal('1'),
        qtyRemaining: new Prisma.Decimal('9'),
      },
    });

    await expect(cancelReceipt(db, posted.id, {})).rejects.toThrow(
      /Cannot cancel receipt: receipt has consumed inventory layers\. Use inventory adjustment instead\./,
    );

    // Receipt status should NOT have flipped to CANCELLED.
    const receipt = await db.receipt.findUniqueOrThrow({ where: { id: posted.id } });
    expect(receipt.status).toBe(ReceiptStatus.POSTED);
    // Layer should still be live (not soft-deleted).
    const layerAfter = await db.fifoLayer.findUniqueOrThrow({ where: { id: layer.id } });
    expect(layerAfter.deletedAt).toBeNull();
  });

  it('cancelReceipt does NOT touch layers from OTHER receipts (scope isolation)', async () => {
    // Receipt R1 (will be cancelled)
    const r1Draft = await createDraftReceipt(db, {
      vendorId,
      warehouseId,
      lines: [
        { variantId: variantAId, warehouseId, qtyReceived: '5', unitCost: '1' },
      ],
    });
    await postReceipt(db, r1Draft.id);
    const r1Layer = await db.fifoLayer.findFirstOrThrow({
      where: { variantId: variantAId, warehouseId },
    });

    // Receipt R2 (will NOT be cancelled). Same variant, different receipt.
    const r2Draft = await createDraftReceipt(db, {
      vendorId,
      warehouseId,
      lines: [
        { variantId: variantAId, warehouseId, qtyReceived: '7', unitCost: '2' },
      ],
    });
    await postReceipt(db, r2Draft.id);
    const r2Layer = await db.fifoLayer.findFirstOrThrow({
      where: {
        variantId: variantAId,
        warehouseId,
        id: { not: r1Layer.id },
      },
    });

    await cancelReceipt(db, r1Draft.id, {});

    const r1After = await db.fifoLayer.findUniqueOrThrow({ where: { id: r1Layer.id } });
    const r2After = await db.fifoLayer.findUniqueOrThrow({ where: { id: r2Layer.id } });
    expect(r1After.deletedAt).not.toBeNull();
    expect(r2After.deletedAt).toBeNull();
  });
});
