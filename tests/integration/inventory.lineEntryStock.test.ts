import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Prisma } from '@/generated/tenant';
import type { PrismaClient } from '@/generated/tenant';
import { getLineEntryStock } from '@/server/services/inventory';
import { receiveInventory } from '@/server/services/movements';
import {
  createSalesOrder,
  confirmSalesOrder,
} from '@/server/services/salesOrders';
import { hasTenantDb, makeClient } from '../helpers/db';
import { upsertTestCustomer } from '../helpers/customerStub';
import { upsertTestWarehouse } from '../helpers/warehouseStub';
import { wipeInvoiceArtifactsForSOs } from '../helpers/wipeInvoiceArtifacts';

const suite = hasTenantDb ? describe : describe.skip;

suite('getLineEntryStock', () => {
  let db: PrismaClient;
  let customerId: string;
  let warehouseId: string;
  let productId: string;
  let variantId: string;

  beforeAll(async () => {
    db = makeClient();
    const c = await upsertTestCustomer(db, {
      code: 'TEST-CUST-LES',
      name: 'LineEntry Cust',
    });
    customerId = c.id;
    const wh = await upsertTestWarehouse(db, {
      code: 'TEST-WH-LES',
      name: 'LineEntry WH',
    });
    warehouseId = wh.id;
    const product = await db.product.upsert({
      where: { sku: 'TEST-PROD-LES' },
      create: {
        sku: 'TEST-PROD-LES',
        name: 'LineEntry Product',
        basePrice: new Prisma.Decimal('1.00'),
      },
      update: { active: true, deletedAt: null, basePrice: new Prisma.Decimal('1.00') },
    });
    productId = product.id;
    const variant = await db.productVariant.upsert({
      where: { sku: 'TEST-PROD-LES-V1' },
      create: { productId: product.id, sku: 'TEST-PROD-LES-V1', name: 'V1' },
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

  it('Returns zeros when no InventoryItem row exists', async () => {
    const r = await getLineEntryStock(db, variantId, warehouseId);
    expect(r.onHand.toString()).toBe('0');
    expect(r.reserved.toString()).toBe('0');
    expect(r.available.toString()).toBe('0');
  });

  it('Returns onHand only after receive (reserved=0, available=onHand)', async () => {
    await receiveInventory(db, { variantId, warehouseId, qty: '12' });
    const r = await getLineEntryStock(db, variantId, warehouseId);
    expect(r.onHand.toString()).toBe(new Prisma.Decimal('12').toString());
    expect(r.reserved.toString()).toBe('0');
    expect(r.available.toString()).toBe(new Prisma.Decimal('12').toString());
  });

  it('Reserved updates after SO confirm; available subtracts', async () => {
    await receiveInventory(db, { variantId, warehouseId, qty: '10' });
    const so = await createSalesOrder(db, {
      customerId,
      warehouseId,
      lines: [{ variantId, warehouseId, qtyOrdered: '4' }],
    });
    await confirmSalesOrder(db, so.id);
    const r = await getLineEntryStock(db, variantId, warehouseId);
    expect(r.onHand.toString()).toBe(new Prisma.Decimal('10').toString());
    expect(r.reserved.toString()).toBe(new Prisma.Decimal('4').toString());
    expect(r.available.toString()).toBe(new Prisma.Decimal('6').toString());
  });

  it('available clamps to 0 when reserved > onHand', async () => {
    // Manufactured drift — write reserved directly to simulate the
    // negative-available edge case (legacy data, mid-recompute).
    await db.inventoryItem.create({
      data: {
        variantId,
        warehouseId,
        onHand: new Prisma.Decimal('2'),
        reserved: new Prisma.Decimal('5'),
      },
    });
    const r = await getLineEntryStock(db, variantId, warehouseId);
    expect(r.onHand.toString()).toBe(new Prisma.Decimal('2').toString());
    expect(r.reserved.toString()).toBe(new Prisma.Decimal('5').toString());
    expect(r.available.toString()).toBe('0');
  });

  it('Decimal precision preserved (no Number coercion)', async () => {
    await receiveInventory(db, { variantId, warehouseId, qty: '12.34567' });
    const r = await getLineEntryStock(db, variantId, warehouseId);
    expect(r.onHand.toString()).toBe(new Prisma.Decimal('12.34567').toString());
    expect(r.available.toString()).toBe(new Prisma.Decimal('12.34567').toString());
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
