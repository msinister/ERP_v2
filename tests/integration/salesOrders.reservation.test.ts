import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@/generated/tenant';
import type { PrismaClient } from '@/generated/tenant';
import {
  confirmSalesOrder,
  createSalesOrder,
  recomputeReservedForBin,
} from '@/server/services/salesOrders';
import { receiveInventory } from '@/server/services/movements';
import { hasTenantDb, makeClient } from '../helpers/db';
import { upsertTestCustomer } from '../helpers/customerStub';

const suite = hasTenantDb ? describe : describe.skip;

suite('SalesOrder reservation recompute', () => {
  let db: PrismaClient;
  let customerId: string;
  let warehouseId: string;
  let productId: string;
  let variantId: string;

  beforeAll(async () => {
    db = makeClient();
    const c = await upsertTestCustomer(db, {
      code: 'TEST-CUST-SO-RES',
      name: 'Res Cust',
    });
    customerId = c.id;
    const wh = await db.warehouse.upsert({
      where: { code: 'TEST-WH-SO-RES' },
      create: { code: 'TEST-WH-SO-RES', name: 'Res WH' },
      update: { active: true, deletedAt: null },
    });
    warehouseId = wh.id;
    const product = await db.product.upsert({
      where: { sku: 'TEST-PROD-SO-RES' },
      create: {
        sku: 'TEST-PROD-SO-RES',
        name: 'Res Product',
        basePrice: new Prisma.Decimal('1.00'),
      },
      update: { active: true, deletedAt: null, basePrice: new Prisma.Decimal('1.00') },
    });
    productId = product.id;
    const variant = await db.productVariant.upsert({
      where: { sku: 'TEST-PROD-SO-RES-V1' },
      create: { productId: product.id, sku: 'TEST-PROD-SO-RES-V1', name: 'V1' },
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

  it('Two confirmed SOs against the same bin sum into Reserved correctly', async () => {
    await receiveInventory(db, { variantId, warehouseId, qty: '20' });
    const a = await createSalesOrder(db, input('3'));
    const b = await createSalesOrder(db, input('5'));
    await confirmSalesOrder(db, a.id);
    await confirmSalesOrder(db, b.id);

    const inv = await db.inventoryItem.findUnique({
      where: { variantId_warehouseId: { variantId, warehouseId } },
    });
    expect(inv!.reserved.toString()).toBe(new Prisma.Decimal('8').toString());
  });

  it('recomputeReservedForBin self-heals a corrupted denorm', async () => {
    await receiveInventory(db, { variantId, warehouseId, qty: '20' });
    const so = await createSalesOrder(db, input('7'));
    await confirmSalesOrder(db, so.id);

    // Corrupt the denorm.
    await db.inventoryItem.update({
      where: { variantId_warehouseId: { variantId, warehouseId } },
      data: { reserved: new Prisma.Decimal('999') },
    });

    const result = await db.$transaction((tx) =>
      recomputeReservedForBin(tx, variantId, warehouseId),
    );
    expect(result.toString()).toBe(new Prisma.Decimal('7').toString());

    const healed = await db.inventoryItem.findUnique({
      where: { variantId_warehouseId: { variantId, warehouseId } },
    });
    expect(healed!.reserved.toString()).toBe(new Prisma.Decimal('7').toString());
  });

  it('recomputeReservedForBin clamps a negative sum at 0 and warns', async () => {
    await receiveInventory(db, { variantId, warehouseId, qty: '20' });
    const so = await createSalesOrder(db, input('1'));
    await confirmSalesOrder(db, so.id);

    // Force a negative qtyReserved on the line via raw SQL (bypassing Zod).
    await db.$executeRaw`
      UPDATE "SalesOrderLine"
      SET "qtyReserved" = -10
      WHERE "salesOrderId" = ${so.id}
    `;

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await db.$transaction((tx) =>
        recomputeReservedForBin(tx, variantId, warehouseId),
      );
      expect(result.toString()).toBe(new Prisma.Decimal('0').toString());
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('recomputeReservedForBin ignores DRAFT/CLOSED/CANCELLED SOs', async () => {
    await receiveInventory(db, { variantId, warehouseId, qty: '20' });
    // Draft only — should NOT count.
    await createSalesOrder(db, input('4'));

    const result = await db.$transaction((tx) =>
      recomputeReservedForBin(tx, variantId, warehouseId),
    );
    expect(result.toString()).toBe(new Prisma.Decimal('0').toString());

    const inv = await db.inventoryItem.findUnique({
      where: { variantId_warehouseId: { variantId, warehouseId } },
    });
    expect(inv!.reserved.toString()).toBe(new Prisma.Decimal('0').toString());
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
