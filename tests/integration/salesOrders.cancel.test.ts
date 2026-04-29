import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Prisma, SalesOrderStatus } from '@/generated/tenant';
import type { PrismaClient } from '@/generated/tenant';
import {
  cancelSalesOrder,
  closeSalesOrder,
  confirmSalesOrder,
  createSalesOrder,
  dispatchSalesOrder,
} from '@/server/services/salesOrders';
import { receiveInventory } from '@/server/services/movements';
import { hasTenantDb, makeClient } from '../helpers/db';

const suite = hasTenantDb ? describe : describe.skip;

suite('SalesOrder cancel', () => {
  let db: PrismaClient;
  let customerId: string;
  let warehouseId: string;
  let productId: string;
  let variantId: string;

  beforeAll(async () => {
    db = makeClient();
    const c = await db.customer.upsert({
      where: { code: 'TEST-CUST-SO-CN' },
      create: { code: 'TEST-CUST-SO-CN', name: 'Cancel Cust' },
      update: { active: true, deletedAt: null },
    });
    customerId = c.id;
    const wh = await db.warehouse.upsert({
      where: { code: 'TEST-WH-SO-CN' },
      create: { code: 'TEST-WH-SO-CN', name: 'Cancel WH' },
      update: { active: true, deletedAt: null },
    });
    warehouseId = wh.id;
    const product = await db.product.upsert({
      where: { sku: 'TEST-PROD-SO-CN' },
      create: {
        sku: 'TEST-PROD-SO-CN',
        name: 'Cancel Product',
        basePrice: new Prisma.Decimal('1.00'),
      },
      update: { active: true, deletedAt: null, basePrice: new Prisma.Decimal('1.00') },
    });
    productId = product.id;
    const variant = await db.productVariant.upsert({
      where: { sku: 'TEST-PROD-SO-CN-V1' },
      create: { productId: product.id, sku: 'TEST-PROD-SO-CN-V1', name: 'V1' },
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

  function input(qty = '5') {
    return {
      customerId,
      warehouseId,
      lines: [{ variantId, warehouseId, qtyOrdered: qty }],
    };
  }

  it('Cancel from DRAFT — no inventory effect', async () => {
    const so = await createSalesOrder(db, input('5'));
    const cancelled = await cancelSalesOrder(db, so.id, { reason: 'changed mind' });
    expect(cancelled.status).toBe(SalesOrderStatus.CANCELLED);
    expect(cancelled.cancelReason).toBe('changed mind');
    const inv = await db.inventoryItem.findUnique({
      where: { variantId_warehouseId: { variantId, warehouseId } },
    });
    // No InventoryItem row was ever created — that's fine.
    expect(inv?.reserved.toString() ?? '0').toBe('0');
  });

  it('Cancel from CONFIRMED — Reserved goes back to 0', async () => {
    await receiveInventory(db, { variantId, warehouseId, qty: '10' });
    const so = await createSalesOrder(db, input('4'));
    await confirmSalesOrder(db, so.id);
    let inv = await db.inventoryItem.findUnique({
      where: { variantId_warehouseId: { variantId, warehouseId } },
    });
    expect(inv!.reserved.toString()).toBe(new Prisma.Decimal('4').toString());

    await cancelSalesOrder(db, so.id, { reason: 'cust cancel' });
    inv = await db.inventoryItem.findUnique({
      where: { variantId_warehouseId: { variantId, warehouseId } },
    });
    expect(inv!.reserved.toString()).toBe(new Prisma.Decimal('0').toString());
    expect(inv!.onHand.toString()).toBe(new Prisma.Decimal('10').toString());

    const line = (await db.salesOrderLine.findFirst({ where: { salesOrderId: so.id } }))!;
    expect(line.qtyReserved.toString()).toBe(new Prisma.Decimal('0').toString());
  });

  it('Cancel from DISPATCHED — Reserved goes back to 0', async () => {
    await receiveInventory(db, { variantId, warehouseId, qty: '10' });
    const so = await createSalesOrder(db, input('4'));
    await confirmSalesOrder(db, so.id);
    await dispatchSalesOrder(db, so.id);
    await cancelSalesOrder(db, so.id, { reason: 'pulled before ship' });
    const inv = await db.inventoryItem.findUnique({
      where: { variantId_warehouseId: { variantId, warehouseId } },
    });
    expect(inv!.reserved.toString()).toBe(new Prisma.Decimal('0').toString());
  });

  it('Cancel from CLOSED is rejected — must use RMA', async () => {
    await receiveInventory(db, { variantId, warehouseId, qty: '10' });
    const so = await createSalesOrder(db, input('4'));
    await confirmSalesOrder(db, so.id);
    await dispatchSalesOrder(db, so.id);
    await closeSalesOrder(db, so.id, undefined);
    await expect(
      cancelSalesOrder(db, so.id, { reason: 'too late' }),
    ).rejects.toThrow(/RMA/);
  });

  it('Cancel requires a reason', async () => {
    const so = await createSalesOrder(db, input('1'));
    // Zod requires non-empty reason.
    await expect(
      // @ts-expect-error - intentionally missing required field
      cancelSalesOrder(db, so.id, {}),
    ).rejects.toThrow();
  });

  it('Re-cancel rejected', async () => {
    const so = await createSalesOrder(db, input('1'));
    await cancelSalesOrder(db, so.id, { reason: 'first' });
    await expect(
      cancelSalesOrder(db, so.id, { reason: 'second' }),
    ).rejects.toThrow(/already CANCELLED/);
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
  await db.salesOrderLine.deleteMany({ where: { salesOrder: { customerId: ids.customerId } } });
  await db.salesOrder.deleteMany({ where: { customerId: ids.customerId } });
  await db.inventoryMovement.deleteMany({ where: { variantId: ids.variantId } });
  await db.inventoryItem.deleteMany({ where: { variantId: ids.variantId } });
}
