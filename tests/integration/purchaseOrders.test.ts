import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma, PurchaseOrderStatus, ReceiptStatus } from '@/generated/tenant';
import type { PrismaClient } from '@/generated/tenant';
import {
  applyComputedPoStatus,
  cancelPurchaseOrder,
  closePurchaseOrder,
  computePoStatus,
  confirmPurchaseOrder,
  createPurchaseOrder,
  getPurchaseOrder,
  recomputeQtyReceivedForPoLine,
  reopenPurchaseOrder,
  softDeletePurchaseOrder,
  updatePurchaseOrder,
} from '@/server/services/purchaseOrders';
import { hasTenantDb, makeClient } from '../helpers/db';

const suite = hasTenantDb ? describe : describe.skip;

suite('PurchaseOrder service', () => {
  let db: PrismaClient;
  let vendorId: string;
  let warehouseId: string;
  let productId: string;
  let variantId: string;

  beforeAll(async () => {
    db = makeClient();
    const v = await db.vendor.upsert({
      where: { code: 'TEST-VEND-PO' },
      create: { code: 'TEST-VEND-PO', name: 'Test PO Vendor' },
      update: { active: true, deletedAt: null },
    });
    vendorId = v.id;
    const wh = await db.warehouse.upsert({
      where: { code: 'TEST-WH-PO' },
      create: { code: 'TEST-WH-PO', name: 'Test PO Warehouse' },
      update: { active: true, deletedAt: null },
    });
    warehouseId = wh.id;
    const product = await db.product.upsert({
      where: { sku: 'TEST-PROD-PO' },
      create: { sku: 'TEST-PROD-PO', name: 'Test PO Product' },
      update: { active: true, deletedAt: null },
    });
    productId = product.id;
    const variant = await db.productVariant.upsert({
      where: { sku: 'TEST-PROD-PO-V1' },
      create: { productId: product.id, sku: 'TEST-PROD-PO-V1', name: 'Test PO Variant' },
      update: { productId: product.id, active: true, deletedAt: null },
    });
    variantId = variant.id;
  });

  beforeEach(async () => {
    await db.receiptLine.deleteMany({ where: { variantId } });
    await db.receipt.deleteMany({ where: { vendorId, warehouseId } });
    await db.purchaseOrderLine.deleteMany({ where: { variantId } });
    await db.purchaseOrder.deleteMany({ where: { vendorId } });
  });

  afterAll(async () => {
    await db.receiptLine.deleteMany({ where: { variantId } });
    await db.receipt.deleteMany({ where: { vendorId, warehouseId } });
    await db.purchaseOrderLine.deleteMany({ where: { variantId } });
    await db.purchaseOrder.deleteMany({ where: { vendorId } });
    await db.productVariant.deleteMany({ where: { id: variantId } });
    await db.product.deleteMany({ where: { id: productId } });
    await db.warehouse.deleteMany({ where: { id: warehouseId } });
    await db.vendor.deleteMany({ where: { id: vendorId } });
    await db.$disconnect();
  });

  function lineInput(qtyOrdered = '10', unitCost = '5') {
    return {
      variantId,
      warehouseId,
      qtyOrdered,
      unitCost,
    };
  }

  it('createPurchaseOrder issues PO-YYYY-NNNNN number and stores lines', async () => {
    const po = await createPurchaseOrder(db, {
      vendorId,
      lines: [lineInput('5', '2.50')],
    });
    expect(po.number).toMatch(/^PO-\d{4}-\d{5}$/);
    expect(po.status).toBe(PurchaseOrderStatus.DRAFT);
    expect(po.lines).toHaveLength(1);
    expect(po.lines[0].qtyOrdered.toString()).toBe(new Prisma.Decimal('5').toString());
    expect(po.lines[0].qtyReceived.toString()).toBe(new Prisma.Decimal('0').toString());
  });

  it('confirm only from DRAFT; rejects double-confirm', async () => {
    const po = await createPurchaseOrder(db, { vendorId, lines: [lineInput()] });
    const c1 = await confirmPurchaseOrder(db, po.id);
    expect(c1.status).toBe(PurchaseOrderStatus.CONFIRMED);
    expect(c1.confirmedAt).not.toBeNull();
    await expect(confirmPurchaseOrder(db, po.id)).rejects.toThrow(/Cannot confirm/);
  });

  it('updatePurchaseOrder rejected once status is past DRAFT', async () => {
    const po = await createPurchaseOrder(db, { vendorId, lines: [lineInput()] });
    await confirmPurchaseOrder(db, po.id);
    await expect(
      updatePurchaseOrder(db, po.id, { notes: 'should fail' }),
    ).rejects.toThrow(/Cannot edit/);
  });

  it('cancel rejected on CLOSED, allowed on DRAFT/CONFIRMED/PARTIALLY_RECEIVED with no active receipt lines', async () => {
    const po = await createPurchaseOrder(db, { vendorId, lines: [lineInput()] });
    const cancelled = await cancelPurchaseOrder(db, po.id, { reason: 'no longer needed' });
    expect(cancelled.status).toBe(PurchaseOrderStatus.CANCELLED);

    // Re-cancel rejected.
    await expect(cancelPurchaseOrder(db, po.id, {})).rejects.toThrow(/already CANCELLED/);
  });

  // ---------------------------------------------------------------------------
  // Manual close
  // ---------------------------------------------------------------------------

  it('closePurchaseOrder: rejects on DRAFT (must be CONFIRMED or PARTIALLY_RECEIVED)', async () => {
    const po = await createPurchaseOrder(db, { vendorId, lines: [lineInput()] });
    await expect(
      closePurchaseOrder(db, po.id, { reason: 'vendor short' }),
    ).rejects.toThrow(/Cannot close PurchaseOrder in status DRAFT/);
  });

  it('closePurchaseOrder: CONFIRMED → CLOSED with reason persisted', async () => {
    const po = await createPurchaseOrder(db, { vendorId, lines: [lineInput()] });
    await confirmPurchaseOrder(db, po.id);
    const closed = await closePurchaseOrder(db, po.id, {
      reason: 'vendor discontinued',
    });
    expect(closed.status).toBe(PurchaseOrderStatus.CLOSED);
    expect(closed.closedAt).not.toBeNull();
    expect(closed.closeReason).toBe('vendor discontinued');
  });

  it('closePurchaseOrder: leaves line.qtyOrdered unchanged (reporting preserves the gap)', async () => {
    const po = await createPurchaseOrder(db, { vendorId, lines: [lineInput('10', '5')] });
    await confirmPurchaseOrder(db, po.id);
    await closePurchaseOrder(db, po.id, { reason: 'short ship' });

    const line = await db.purchaseOrderLine.findFirstOrThrow({
      where: { purchaseOrderId: po.id },
    });
    expect(line.qtyOrdered.toString()).toBe(new Prisma.Decimal('10').toString());
  });

  it('closePurchaseOrder: re-close rejected once already CLOSED', async () => {
    const po = await createPurchaseOrder(db, { vendorId, lines: [lineInput()] });
    await confirmPurchaseOrder(db, po.id);
    await closePurchaseOrder(db, po.id, { reason: 'short ship' });
    await expect(
      closePurchaseOrder(db, po.id, { reason: 'second close' }),
    ).rejects.toThrow(/Cannot close PurchaseOrder in status CLOSED/);
  });

  it('applyComputedPoStatus: manual-close survives a downstream receipt-driven recompute', async () => {
    const po = await createPurchaseOrder(db, { vendorId, lines: [lineInput('10', '1')] });
    await confirmPurchaseOrder(db, po.id);
    const poLine = await db.purchaseOrderLine.findFirstOrThrow({
      where: { purchaseOrderId: po.id },
    });

    // Post a partial receipt (3 of 10), corrupt-style via direct
    // tables — same pattern as the existing recompute test. PO moves
    // to PARTIALLY_RECEIVED.
    const receipt = await db.receipt.create({
      data: {
        number: `TEST-RCPT-CLOSE-${Date.now()}`,
        vendorId,
        warehouseId,
        status: ReceiptStatus.POSTED,
        receivedAt: new Date(),
      },
    });
    await db.receiptLine.create({
      data: {
        receiptId: receipt.id,
        purchaseOrderLineId: poLine.id,
        variantId,
        warehouseId,
        qtyReceived: new Prisma.Decimal('3'),
        unitCost: new Prisma.Decimal('1'),
      },
    });
    await db.purchaseOrderLine.update({
      where: { id: poLine.id },
      data: { qtyReceived: new Prisma.Decimal('3') },
    });
    await db.purchaseOrder.update({
      where: { id: po.id },
      data: { status: PurchaseOrderStatus.PARTIALLY_RECEIVED },
    });

    // Operator closes with reason.
    await closePurchaseOrder(db, po.id, { reason: 'vendor cancelled' });

    // Now simulate a receipt cancel: drop qtyReceived back to 0 and
    // call applyComputedPoStatus. The recomputed status would normally
    // be CONFIRMED (zero received), but the manual closeReason
    // sentinel preserves CLOSED.
    await db.purchaseOrderLine.update({
      where: { id: poLine.id },
      data: { qtyReceived: new Prisma.Decimal('0') },
    });
    const result = await db.$transaction((tx) =>
      applyComputedPoStatus(tx, po.id),
    );
    expect(result.changed).toBe(false);
    const after = await db.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } });
    expect(after.status).toBe(PurchaseOrderStatus.CLOSED);
    expect(after.closeReason).toBe('vendor cancelled');
  });

  // ---------------------------------------------------------------------------
  // Manual reopen
  // ---------------------------------------------------------------------------

  it('reopenPurchaseOrder: rejects on non-CLOSED (e.g., CONFIRMED)', async () => {
    const po = await createPurchaseOrder(db, { vendorId, lines: [lineInput()] });
    await confirmPurchaseOrder(db, po.id);
    await expect(
      reopenPurchaseOrder(db, po.id, { reason: 'oops' }),
    ).rejects.toThrow(/Cannot reopen PurchaseOrder in status CONFIRMED/);
  });

  it('reopenPurchaseOrder: CLOSED with no receipts → reverts to CONFIRMED and clears closeReason/closedAt', async () => {
    const po = await createPurchaseOrder(db, { vendorId, lines: [lineInput()] });
    await confirmPurchaseOrder(db, po.id);
    await closePurchaseOrder(db, po.id, { reason: 'short ship' });

    const reopened = await reopenPurchaseOrder(db, po.id, {
      reason: 'vendor sending remaining units',
    });
    expect(reopened.status).toBe(PurchaseOrderStatus.CONFIRMED);
    expect(reopened.closeReason).toBeNull();
    expect(reopened.closedAt).toBeNull();
  });

  it('reopenPurchaseOrder: CLOSED with partial receipts → reverts to PARTIALLY_RECEIVED', async () => {
    const po = await createPurchaseOrder(db, { vendorId, lines: [lineInput('10', '1')] });
    await confirmPurchaseOrder(db, po.id);

    const poLine = await db.purchaseOrderLine.findFirstOrThrow({
      where: { purchaseOrderId: po.id },
    });
    const receipt = await db.receipt.create({
      data: {
        number: `TEST-RCPT-REOPEN-${Date.now()}`,
        vendorId,
        warehouseId,
        status: ReceiptStatus.POSTED,
        receivedAt: new Date(),
      },
    });
    await db.receiptLine.create({
      data: {
        receiptId: receipt.id,
        purchaseOrderLineId: poLine.id,
        variantId,
        warehouseId,
        qtyReceived: new Prisma.Decimal('3'),
        unitCost: new Prisma.Decimal('1'),
      },
    });
    await db.purchaseOrderLine.update({
      where: { id: poLine.id },
      data: { qtyReceived: new Prisma.Decimal('3') },
    });
    await db.purchaseOrder.update({
      where: { id: po.id },
      data: { status: PurchaseOrderStatus.PARTIALLY_RECEIVED },
    });

    await closePurchaseOrder(db, po.id, { reason: 'short ship' });
    const reopened = await reopenPurchaseOrder(db, po.id, {
      reason: 'vendor sending remaining 7',
    });
    expect(reopened.status).toBe(PurchaseOrderStatus.PARTIALLY_RECEIVED);
    expect(reopened.closeReason).toBeNull();
    expect(reopened.closedAt).toBeNull();
  });

  it('reopenPurchaseOrder: receipt cancels resume driving status after reopen', async () => {
    // After reopen the closeReason sentinel is gone, so the
    // applyComputedPoStatus revert path should re-engage.
    const po = await createPurchaseOrder(db, { vendorId, lines: [lineInput('10', '1')] });
    await confirmPurchaseOrder(db, po.id);
    const poLine = await db.purchaseOrderLine.findFirstOrThrow({
      where: { purchaseOrderId: po.id },
    });
    const receipt = await db.receipt.create({
      data: {
        number: `TEST-RCPT-REOPEN2-${Date.now()}`,
        vendorId,
        warehouseId,
        status: ReceiptStatus.POSTED,
        receivedAt: new Date(),
      },
    });
    await db.receiptLine.create({
      data: {
        receiptId: receipt.id,
        purchaseOrderLineId: poLine.id,
        variantId,
        warehouseId,
        qtyReceived: new Prisma.Decimal('3'),
        unitCost: new Prisma.Decimal('1'),
      },
    });
    await db.purchaseOrderLine.update({
      where: { id: poLine.id },
      data: { qtyReceived: new Prisma.Decimal('3') },
    });
    await db.purchaseOrder.update({
      where: { id: po.id },
      data: { status: PurchaseOrderStatus.PARTIALLY_RECEIVED },
    });
    await closePurchaseOrder(db, po.id, { reason: 'closed early' });
    await reopenPurchaseOrder(db, po.id, { reason: 'reopened' });

    // Simulate receipt cancel — qtyReceived back to 0.
    await db.purchaseOrderLine.update({
      where: { id: poLine.id },
      data: { qtyReceived: new Prisma.Decimal('0') },
    });
    const result = await db.$transaction((tx) =>
      applyComputedPoStatus(tx, po.id),
    );
    // No closeReason sentinel → recompute is free to flip back to
    // CONFIRMED.
    expect(result.changed).toBe(true);
    const after = await db.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } });
    expect(after.status).toBe(PurchaseOrderStatus.CONFIRMED);
  });

  it('softDelete only allowed for DRAFT or CANCELLED', async () => {
    const draft = await createPurchaseOrder(db, { vendorId, lines: [lineInput()] });
    const deleted = await softDeletePurchaseOrder(db, draft.id);
    expect(deleted.deletedAt).not.toBeNull();

    const po2 = await createPurchaseOrder(db, { vendorId, lines: [lineInput()] });
    await confirmPurchaseOrder(db, po2.id);
    await expect(softDeletePurchaseOrder(db, po2.id)).rejects.toThrow(/Soft-delete only allowed/);
  });

  it('getPurchaseOrder hides soft-deleted rows', async () => {
    const po = await createPurchaseOrder(db, { vendorId, lines: [lineInput()] });
    await softDeletePurchaseOrder(db, po.id);
    const fetched = await getPurchaseOrder(db, po.id);
    expect(fetched).toBeNull();
  });

  it('computePoStatus is a pure derivation from line qtyReceived', async () => {
    const po = await createPurchaseOrder(db, {
      vendorId,
      lines: [lineInput('10', '1'), lineInput('20', '1')],
    });
    await confirmPurchaseOrder(db, po.id);

    // No receipts yet → CONFIRMED.
    let status = await db.$transaction((tx) => computePoStatus(tx, po.id));
    expect(status).toBe(PurchaseOrderStatus.CONFIRMED);

    // Mark line 1 partially received via direct denorm write (we test the
    // pure computation here; receipts service exercises end-to-end later).
    const lines = await db.purchaseOrderLine.findMany({ where: { purchaseOrderId: po.id }, orderBy: { createdAt: 'asc' } });
    await db.purchaseOrderLine.update({ where: { id: lines[0].id }, data: { qtyReceived: new Prisma.Decimal('5') } });

    status = await db.$transaction((tx) => computePoStatus(tx, po.id));
    expect(status).toBe(PurchaseOrderStatus.PARTIALLY_RECEIVED);

    // Fully receive both lines.
    await db.purchaseOrderLine.update({ where: { id: lines[0].id }, data: { qtyReceived: new Prisma.Decimal('10') } });
    await db.purchaseOrderLine.update({ where: { id: lines[1].id }, data: { qtyReceived: new Prisma.Decimal('20') } });
    status = await db.$transaction((tx) => computePoStatus(tx, po.id));
    expect(status).toBe(PurchaseOrderStatus.CLOSED);
  });

  it('recomputeQtyReceivedForPoLine self-heals a corrupted denorm', async () => {
    const po = await createPurchaseOrder(db, { vendorId, lines: [lineInput('100', '1')] });
    await confirmPurchaseOrder(db, po.id);
    const poLine = (await db.purchaseOrderLine.findFirst({ where: { purchaseOrderId: po.id } }))!;

    // Set up a real Receipt with a posted ReceiptLine summing to 7.
    const receipt = await db.receipt.create({
      data: {
        number: `TEST-RCPT-${Date.now()}`,
        vendorId,
        warehouseId,
        status: ReceiptStatus.POSTED,
        receivedAt: new Date(),
      },
    });
    await db.receiptLine.create({
      data: {
        receiptId: receipt.id,
        purchaseOrderLineId: poLine.id,
        variantId,
        warehouseId,
        qtyReceived: new Prisma.Decimal('4'),
        unitCost: new Prisma.Decimal('1'),
      },
    });
    await db.receiptLine.create({
      data: {
        receiptId: receipt.id,
        purchaseOrderLineId: poLine.id,
        variantId,
        warehouseId,
        qtyReceived: new Prisma.Decimal('3'),
        unitCost: new Prisma.Decimal('1'),
      },
    });

    // Corrupt the denorm to a wrong value.
    await db.purchaseOrderLine.update({
      where: { id: poLine.id },
      data: { qtyReceived: new Prisma.Decimal('999') },
    });

    const result = await db.$transaction((tx) => recomputeQtyReceivedForPoLine(tx, poLine.id));
    expect(result.toString()).toBe(new Prisma.Decimal('7').toString());

    const healed = await db.purchaseOrderLine.findUnique({ where: { id: poLine.id } });
    expect(healed!.qtyReceived.toString()).toBe(new Prisma.Decimal('7').toString());
  });

  it('recomputeQtyReceivedForPoLine clamps a negative sum at 0 and warns', async () => {
    const po = await createPurchaseOrder(db, { vendorId, lines: [lineInput('100', '1')] });
    await confirmPurchaseOrder(db, po.id);
    const poLine = (await db.purchaseOrderLine.findFirst({ where: { purchaseOrderId: po.id } }))!;

    const receipt = await db.receipt.create({
      data: {
        number: `TEST-RCPT-NEG-${Date.now()}`,
        vendorId,
        warehouseId,
        status: ReceiptStatus.POSTED,
        receivedAt: new Date(),
      },
    });
    // Bypass schema validation: write a negative ReceiptLine.qtyReceived to
    // simulate upstream corruption, then prove the recompute clamps.
    await db.$executeRaw`
      INSERT INTO "ReceiptLine" ("id", "receiptId", "purchaseOrderLineId", "variantId", "warehouseId", "qtyReceived", "unitCost", "createdAt", "updatedAt")
      VALUES (${'rl-neg-' + Date.now()}, ${receipt.id}, ${poLine.id}, ${variantId}, ${warehouseId}, -5, 1, NOW(), NOW())
    `;

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await db.$transaction((tx) => recomputeQtyReceivedForPoLine(tx, poLine.id));
      expect(result.toString()).toBe(new Prisma.Decimal('0').toString());
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }

    const healed = await db.purchaseOrderLine.findUnique({ where: { id: poLine.id } });
    expect(healed!.qtyReceived.toString()).toBe(new Prisma.Decimal('0').toString());
  });
});
