import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Prisma, SalesOrderStatus } from '@/generated/tenant';
import type { PrismaClient } from '@/generated/tenant';
import {
  cancelSalesOrder,
  closeSalesOrder,
  confirmSalesOrder,
  createSalesOrder,
  dispatchSalesOrder,
  softDeleteSalesOrder,
  updateSalesOrder,
} from '@/server/services/salesOrders';
import { receiveInventory } from '@/server/services/movements';
import { hasTenantDb, makeClient } from '../helpers/db';
import { wipeInvoiceArtifactsForSOs } from '../helpers/wipeInvoiceArtifacts';
import { upsertTestCustomer } from '../helpers/customerStub';

const suite = hasTenantDb ? describe : describe.skip;

suite('SalesOrder edit + soft-delete guards', () => {
  let db: PrismaClient;
  let customerId: string;
  let warehouseId: string;
  let productId: string;
  let variantId: string;

  beforeAll(async () => {
    db = makeClient();
    const c = await upsertTestCustomer(db, {
      code: 'TEST-CUST-SO-EG',
      name: 'Edit Guard Cust',
    });
    customerId = c.id;
    const wh = await db.warehouse.upsert({
      where: { code: 'TEST-WH-SO-EG' },
      create: { code: 'TEST-WH-SO-EG', name: 'Edit Guard WH' },
      update: { active: true, deletedAt: null },
    });
    warehouseId = wh.id;
    const product = await db.product.upsert({
      where: { sku: 'TEST-PROD-SO-EG' },
      create: {
        sku: 'TEST-PROD-SO-EG',
        name: 'Edit Guard Product',
        basePrice: new Prisma.Decimal('1.00'),
      },
      update: { active: true, deletedAt: null, basePrice: new Prisma.Decimal('1.00') },
    });
    productId = product.id;
    const variant = await db.productVariant.upsert({
      where: { sku: 'TEST-PROD-SO-EG-V1' },
      create: { productId: product.id, sku: 'TEST-PROD-SO-EG-V1', name: 'V1' },
      update: { productId: product.id, active: true, deletedAt: null },
    });
    variantId = variant.id;
  });

  beforeEach(async () => {
    await wipe(db, { customerId, variantId });
  });

  afterAll(async () => {
    await wipe(db, { customerId, variantId });
    await db.productVariant.deleteMany({ where: { id: variantId } });
    await db.product.deleteMany({ where: { id: productId } });
    await db.warehouse.deleteMany({ where: { id: warehouseId } });
    await db.customer.deleteMany({ where: { id: customerId } });
    await db.$disconnect();
  });

  function input(qty = '1') {
    return {
      customerId,
      warehouseId,
      lines: [{ variantId, warehouseId, qtyOrdered: qty }],
    };
  }

  it('updateSalesOrder succeeds in DRAFT', async () => {
    const so = await createSalesOrder(db, input('1'));
    const updated = await updateSalesOrder(db, so.id, { customerNotes: 'hello' });
    expect(updated.customerNotes).toBe('hello');
  });

  it('updateSalesOrder rejected in CONFIRMED with the cancel-and-recreate message', async () => {
    await receiveInventory(db, { variantId, warehouseId, qty: '5' });
    const so = await createSalesOrder(db, input('1'));
    await confirmSalesOrder(db, so.id);
    await expect(
      updateSalesOrder(db, so.id, { customerNotes: 'too late' }),
    ).rejects.toThrow(/Cancel the order and create a new one/);
  });

  it('updateSalesOrder rejected in DISPATCHED, CLOSED, CANCELLED', async () => {
    await receiveInventory(db, { variantId, warehouseId, qty: '5' });
    const so1 = await createSalesOrder(db, input('1'));
    await confirmSalesOrder(db, so1.id);
    await dispatchSalesOrder(db, so1.id);
    await expect(updateSalesOrder(db, so1.id, { customerNotes: 'no' })).rejects.toThrow(/Cannot edit/);

    const so2 = await createSalesOrder(db, input('1'));
    await confirmSalesOrder(db, so2.id);
    await closeSalesOrder(db, so2.id, undefined);
    await expect(updateSalesOrder(db, so2.id, { customerNotes: 'no' })).rejects.toThrow(/Cannot edit/);

    const so3 = await createSalesOrder(db, input('1'));
    await cancelSalesOrder(db, so3.id, { reason: 'no' });
    await expect(updateSalesOrder(db, so3.id, { customerNotes: 'no' })).rejects.toThrow(/Cannot edit/);
  });

  it('softDeleteSalesOrder allowed in DRAFT and CANCELLED, rejected in CONFIRMED+', async () => {
    const draft = await createSalesOrder(db, input('1'));
    const deleted = await softDeleteSalesOrder(db, draft.id);
    expect(deleted.deletedAt).not.toBeNull();

    const cancelled = await createSalesOrder(db, input('1'));
    await cancelSalesOrder(db, cancelled.id, { reason: 'gone' });
    const cd = await softDeleteSalesOrder(db, cancelled.id);
    expect(cd.deletedAt).not.toBeNull();

    await receiveInventory(db, { variantId, warehouseId, qty: '5' });
    const confirmed = await createSalesOrder(db, input('1'));
    await confirmSalesOrder(db, confirmed.id);
    await expect(softDeleteSalesOrder(db, confirmed.id)).rejects.toThrow(
      /Soft-delete only allowed/,
    );
  });
});

async function wipe(
  db: PrismaClient,
  ids: { customerId: string; variantId: string },
): Promise<void> {
  const ourMovements = await db.inventoryMovement.findMany({
    where: { variantId: ids.variantId },
    select: { id: true },
  });
  if (ourMovements.length > 0) {
    await db.auditLog.deleteMany({
      where: { entityType: 'InventoryMovement', entityId: { in: ourMovements.map((m) => m.id) } },
    });
  }
  const ourSos = await db.salesOrder.findMany({
    where: { customerId: ids.customerId },
    select: { id: true },
  });
  if (ourSos.length > 0) {
    await db.auditLog.deleteMany({
      where: { entityType: 'SalesOrder', entityId: { in: ourSos.map((s) => s.id) } },
    });
  }
  await wipeInvoiceArtifactsForSOs(db, ourSos.map((s) => s.id));
  await db.salesOrderLine.deleteMany({ where: { salesOrder: { customerId: ids.customerId } } });
  await db.salesOrder.deleteMany({ where: { customerId: ids.customerId } });
  await db.inventoryMovement.deleteMany({ where: { variantId: ids.variantId } });
  await db.inventoryItem.deleteMany({ where: { variantId: ids.variantId } });
}
