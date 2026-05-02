import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Prisma, SalesOrderStatus } from '@/generated/tenant';
import type { PrismaClient } from '@/generated/tenant';
import {
  closeSalesOrder,
  confirmSalesOrder,
  createSalesOrder,
  dispatchSalesOrder,
} from '@/server/services/salesOrders';
import { receiveInventory } from '@/server/services/movements';
import { hasTenantDb, makeClient } from '../helpers/db';
import { wipeInvoiceArtifactsForSOs } from '../helpers/wipeInvoiceArtifacts';
import { upsertTestCustomer } from '../helpers/customerStub';
import { upsertTestWarehouse } from '../helpers/warehouseStub';

const suite = hasTenantDb ? describe : describe.skip;

suite('SalesOrder concurrency (advisory lock)', () => {
  let db: PrismaClient;
  let customerId: string;
  let warehouseId: string;
  let productId: string;
  let variantId: string;

  beforeAll(async () => {
    db = makeClient();
    const c = await upsertTestCustomer(db, {
      code: 'TEST-CUST-SO-CONC',
      name: 'SO Conc Cust',
    });
    customerId = c.id;
    const wh = await upsertTestWarehouse(db, {
      code: 'TEST-WH-SO-CONC',
      name: 'SO Conc WH',
    });
    warehouseId = wh.id;
    const product = await db.product.upsert({
      where: { sku: 'TEST-PROD-SO-CONC' },
      create: {
        sku: 'TEST-PROD-SO-CONC',
        name: 'SO Conc Product',
        basePrice: new Prisma.Decimal('1.00'),
      },
      update: { active: true, deletedAt: null, basePrice: new Prisma.Decimal('1.00') },
    });
    productId = product.id;
    const variant = await db.productVariant.upsert({
      where: { sku: 'TEST-PROD-SO-CONC-V1' },
      create: { productId: product.id, sku: 'TEST-PROD-SO-CONC-V1', name: 'V1' },
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

  function input(qty: string) {
    return {
      customerId,
      warehouseId,
      lines: [{ variantId, warehouseId, qtyOrdered: qty }],
    };
  }

  it('parallel confirms aggregate Reserved correctly', async () => {
    await receiveInventory(db, { variantId, warehouseId, qty: '50' });
    const sos = await Promise.all(
      [3, 4, 5, 6].map((q) => createSalesOrder(db, input(q.toString()))),
    );

    const results = await Promise.allSettled(
      sos.map((so) => confirmSalesOrder(db, so.id)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(4);

    const inv = await db.inventoryItem.findUnique({
      where: { variantId_warehouseId: { variantId, warehouseId } },
    });
    expect(inv!.reserved.toString()).toBe(new Prisma.Decimal('18').toString());
    expect(inv!.onHand.toString()).toBe(new Prisma.Decimal('50').toString());
  });

  it('parallel closes never oversell — at most floor(stock/qty) succeed', async () => {
    await receiveInventory(db, { variantId, warehouseId, qty: '10' });
    // Five SOs of qty 3 each → demand 15 against stock 10 → at most 3 close.
    const sos = await Promise.all(
      Array.from({ length: 5 }, () => createSalesOrder(db, input('3'))),
    );
    for (const so of sos) {
      await confirmSalesOrder(db, so.id);
      await dispatchSalesOrder(db, so.id);
    }

    const results = await Promise.allSettled(
      sos.map((so) => closeSalesOrder(db, so.id, undefined)),
    );
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(3);
    expect(rejected).toHaveLength(2);
    for (const r of rejected) {
      expect((r as PromiseRejectedResult).reason.message).toMatch(/Insufficient stock/);
    }

    const inv = await db.inventoryItem.findUnique({
      where: { variantId_warehouseId: { variantId, warehouseId } },
    });
    expect(inv!.onHand.greaterThanOrEqualTo(0)).toBe(true);
    expect(inv!.onHand.toString()).toBe(new Prisma.Decimal('1').toString());

    // The two rejected SOs are still DISPATCHED (their tx rolled back).
    const closedCount = await db.salesOrder.count({
      where: {
        id: { in: sos.map((s) => s.id) },
        status: SalesOrderStatus.CLOSED,
      },
    });
    expect(closedCount).toBe(3);
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
