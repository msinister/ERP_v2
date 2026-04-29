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
    const wh = await db.warehouse.upsert({
      where: { code: 'TEST-WH-RCPT' },
      create: { code: 'TEST-WH-RCPT', name: 'Test Receipt Warehouse' },
      update: { active: true, deletedAt: null },
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
    const variantIds = [variantAId, variantBId];
    // Wipe audit rows for our movements only (other test files run in parallel).
    const ourMovements = await db.inventoryMovement.findMany({
      where: { variantId: { in: variantIds } },
      select: { id: true },
    });
    if (ourMovements.length > 0) {
      await db.auditLog.deleteMany({
        where: { entityType: 'InventoryMovement', entityId: { in: ourMovements.map((m) => m.id) } },
      });
    }
    await db.receiptLine.deleteMany({ where: { variantId: { in: variantIds } } });
    await db.receipt.deleteMany({ where: { vendorId, warehouseId } });
    await db.purchaseOrderLine.deleteMany({ where: { variantId: { in: variantIds } } });
    await db.purchaseOrder.deleteMany({ where: { vendorId } });
    await db.inventoryMovement.deleteMany({ where: { variantId: { in: variantIds } } });
    await db.inventoryItem.deleteMany({ where: { variantId: { in: variantIds } } });
  });

  afterAll(async () => {
    const variantIds = [variantAId, variantBId];
    const ourMovements = await db.inventoryMovement.findMany({
      where: { variantId: { in: variantIds } },
      select: { id: true },
    });
    if (ourMovements.length > 0) {
      await db.auditLog.deleteMany({
        where: { entityType: 'InventoryMovement', entityId: { in: ourMovements.map((m) => m.id) } },
      });
    }
    await db.receiptLine.deleteMany({ where: { variantId: { in: variantIds } } });
    await db.receipt.deleteMany({ where: { vendorId, warehouseId } });
    await db.purchaseOrderLine.deleteMany({ where: { variantId: { in: variantIds } } });
    await db.purchaseOrder.deleteMany({ where: { vendorId } });
    await db.inventoryMovement.deleteMany({ where: { variantId: { in: variantIds } } });
    await db.inventoryItem.deleteMany({ where: { variantId: { in: variantIds } } });
    await db.productVariant.deleteMany({ where: { id: { in: variantIds } } });
    await db.product.deleteMany({ where: { id: productId } });
    await db.warehouse.deleteMany({ where: { id: warehouseId } });
    await db.vendor.deleteMany({ where: { id: vendorId } });
    await db.$disconnect();
  });

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
});
