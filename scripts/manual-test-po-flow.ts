import { db } from '../src/lib/db';
import {
  cancelPurchaseOrder,
  confirmPurchaseOrder,
  createPurchaseOrder,
} from '../src/server/services/purchaseOrders';
import {
  cancelReceipt,
  createDraftReceipt,
  postReceipt,
} from '../src/server/services/receipts';

const VENDOR_CODE = 'MANUAL-TEST-VENDOR';

async function ensureVendor() {
  return db.vendor.upsert({
    where: { code: VENDOR_CODE },
    create: { code: VENDOR_CODE, name: 'Manual Test Vendor' },
    update: { active: true, deletedAt: null },
  });
}

function banner(label: string) {
  console.log('\n' + '='.repeat(60));
  console.log(label);
  console.log('='.repeat(60));
}

async function main() {
  banner('1. Ensure vendor exists');
  const vendor = await ensureVendor();
  console.log({ id: vendor.id, code: vendor.code, name: vendor.name });

  banner('2. Read seed variant + warehouse');
  const variant = await db.productVariant.findFirst({
    where: { sku: 'SEED-PROD-1-RED', deletedAt: null },
  });
  const warehouse = await db.warehouse.findFirst({
    where: { code: 'WH-MAIN', deletedAt: null },
  });
  if (!variant) throw new Error('Seed variant SEED-PROD-1-RED not found — run db:seed:tenant first');
  if (!warehouse) throw new Error('Seed warehouse WH-MAIN not found — run db:seed:tenant first');
  console.log({ variantId: variant.id, variantSku: variant.sku, warehouseId: warehouse.id });

  banner('3. Create PO (1 line, 100 units @ $5)');
  const po = await createPurchaseOrder(db, {
    vendorId: vendor.id,
    lines: [
      {
        variantId: variant.id,
        warehouseId: warehouse.id,
        qtyOrdered: '100',
        unitCost: '5',
      },
    ],
  });
  console.log({
    id: po.id,
    number: po.number,
    status: po.status,
    lineCount: po.lines.length,
    line0: {
      qtyOrdered: po.lines[0].qtyOrdered.toString(),
      unitCost: po.lines[0].unitCost.toString(),
    },
  });

  banner('4. Confirm PO');
  const confirmed = await confirmPurchaseOrder(db, po.id);
  console.log({ id: confirmed.id, status: confirmed.status, confirmedAt: confirmed.confirmedAt });

  const poLine = po.lines[0];

  banner('5. Create draft Receipt (100 units against the PO line)');
  const draft = await createDraftReceipt(db, {
    vendorId: vendor.id,
    warehouseId: warehouse.id,
    lines: [
      {
        purchaseOrderLineId: poLine.id,
        variantId: variant.id,
        warehouseId: warehouse.id,
        qtyReceived: '100',
        unitCost: '5',
      },
    ],
  });
  console.log({
    id: draft.id,
    number: draft.number,
    status: draft.status,
    lineCount: draft.lines.length,
  });

  banner('6. Post Receipt');
  const posted = await postReceipt(db, draft.id);
  console.log({
    id: posted.id,
    status: posted.status,
    receivedAt: posted.receivedAt,
    wasOverReceived: posted.wasOverReceived,
    affectedPurchaseOrderIds: posted.affectedPurchaseOrderIds,
  });

  banner('7a. Inventory onHand after post');
  const invAfterPost = await db.inventoryItem.findUnique({
    where: { variantId_warehouseId: { variantId: variant.id, warehouseId: warehouse.id } },
  });
  console.log({
    variantSku: variant.sku,
    warehouseCode: warehouse.code,
    onHand: invAfterPost?.onHand.toString() ?? null,
  });

  banner('7b. PO status after post');
  const poAfterPost = await db.purchaseOrder.findUnique({
    where: { id: po.id },
    include: { lines: true },
  });
  console.log({
    id: poAfterPost!.id,
    number: poAfterPost!.number,
    status: poAfterPost!.status,
    closedAt: poAfterPost!.closedAt,
    line0Received: poAfterPost!.lines[0].qtyReceived.toString(),
  });

  banner('7c. Audit log entries from this run (PO, Receipt, InventoryMovement)');
  const movementIds = (
    await db.inventoryMovement.findMany({
      where: { variantId: variant.id, warehouseId: warehouse.id },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: { id: true },
    })
  ).map((m) => m.id);
  const auditRows = await db.auditLog.findMany({
    where: {
      OR: [
        { entityType: 'PurchaseOrder', entityId: po.id },
        { entityType: 'Receipt', entityId: posted.id },
        { entityType: 'InventoryMovement', entityId: { in: movementIds } },
      ],
    },
    orderBy: { createdAt: 'asc' },
  });
  for (const a of auditRows) {
    console.log({
      action: a.action,
      entityType: a.entityType,
      entityId: a.entityId,
      reason: a.reason,
      createdAt: a.createdAt,
    });
  }

  banner('8. Cancel Receipt');
  const cancelled = await cancelReceipt(db, posted.id, { reason: 'manual flow test cancel' });
  console.log({
    id: cancelled.id,
    status: cancelled.status,
    affectedPurchaseOrderIds: cancelled.affectedPurchaseOrderIds,
  });

  banner('9a. Inventory onHand after cancel');
  const invAfterCancel = await db.inventoryItem.findUnique({
    where: { variantId_warehouseId: { variantId: variant.id, warehouseId: warehouse.id } },
  });
  console.log({
    onHand: invAfterCancel?.onHand.toString() ?? null,
  });

  banner('9b. PO status after cancel');
  const poAfterCancel = await db.purchaseOrder.findUnique({
    where: { id: po.id },
    include: { lines: true },
  });
  console.log({
    id: poAfterCancel!.id,
    number: poAfterCancel!.number,
    status: poAfterCancel!.status,
    closedAt: poAfterCancel!.closedAt,
    line0Received: poAfterCancel!.lines[0].qtyReceived.toString(),
  });

  // Cleanup so the script is re-runnable.
  banner('Cleanup');
  await cancelPurchaseOrder(db, po.id, { reason: 'manual flow test cleanup' });
  await db.purchaseOrderLine.deleteMany({ where: { purchaseOrderId: po.id } });
  await db.purchaseOrder.deleteMany({ where: { id: po.id } });
  await db.receiptLine.deleteMany({ where: { receiptId: posted.id } });
  await db.receipt.deleteMany({ where: { id: posted.id } });
  console.log('done');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
