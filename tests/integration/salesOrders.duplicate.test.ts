import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditAction, Prisma, SalesOrderStatus } from '@/generated/tenant';
import type { PrismaClient } from '@/generated/tenant';
import {
  cancelSalesOrder,
  confirmSalesOrder,
  createSalesOrder,
  duplicateSalesOrder,
  softDeleteSalesOrder,
} from '@/server/services/salesOrders';
import { hasTenantDb, makeClient } from '../helpers/db';
import { upsertTestCustomer } from '../helpers/customerStub';
import { upsertTestWarehouse } from '../helpers/warehouseStub';
import { wipeInvoiceArtifactsForSOs } from '../helpers/wipeInvoiceArtifacts';

const suite = hasTenantDb ? describe : describe.skip;

suite('duplicateSalesOrder', () => {
  let db: PrismaClient;
  let customerId: string;
  let warehouseId: string;
  let productId: string;
  let variantId: string;

  beforeAll(async () => {
    db = makeClient();
    const c = await upsertTestCustomer(db, {
      code: 'TEST-CUST-DUP',
      name: 'Dup Cust',
    });
    customerId = c.id;
    const wh = await upsertTestWarehouse(db, {
      code: 'TEST-WH-DUP',
      name: 'Dup WH',
    });
    warehouseId = wh.id;
    const product = await db.product.upsert({
      where: { sku: 'TEST-PROD-DUP' },
      create: {
        sku: 'TEST-PROD-DUP',
        name: 'Dup Product',
        basePrice: new Prisma.Decimal('1.00'),
      },
      update: { active: true, deletedAt: null, basePrice: new Prisma.Decimal('1.00') },
    });
    productId = product.id;
    const variant = await db.productVariant.upsert({
      where: { sku: 'TEST-PROD-DUP-V1' },
      create: { productId: product.id, sku: 'TEST-PROD-DUP-V1', name: 'V1' },
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

  function input(overrides: Partial<Parameters<typeof createSalesOrder>[1]> = {}) {
    return {
      customerId,
      warehouseId,
      customerPo: 'PO-ORIG-1',
      promisedShipDate: new Date('2026-06-15T00:00:00Z'),
      orderDiscountPercent: '5',
      shippingAmount: '12.50',
      handlingAmount: '2.00',
      shippingAddress: '123 Test St',
      customerNotes: 'cust note',
      internalNotes: 'internal note',
      lines: [
        {
          variantId,
          warehouseId,
          qtyOrdered: '4',
          discountPercent: '10',
          customerNote: 'rush',
        },
      ],
      ...overrides,
    };
  }

  it('Creates new DRAFT with new SO #, copies lines + discounts + prices', async () => {
    const src = await createSalesOrder(db, input());
    const dup = await duplicateSalesOrder(db, src.id);

    expect(dup.id).not.toBe(src.id);
    expect(dup.number).not.toBe(src.number);
    expect(dup.status).toBe(SalesOrderStatus.DRAFT);
    expect(dup.customerId).toBe(src.customerId);
    expect(dup.warehouseId).toBe(src.warehouseId);
    expect(dup.lines).toHaveLength(1);

    const srcLine = src.lines[0]!;
    const dupLine = dup.lines[0]!;
    expect(dupLine.variantId).toBe(srcLine.variantId);
    expect(dupLine.qtyOrdered.toString()).toBe(srcLine.qtyOrdered.toString());
    // Pricing copied verbatim — never re-resolved.
    expect(dupLine.unitPrice.toString()).toBe(srcLine.unitPrice.toString());
    expect(dupLine.priceRule).toBe(srcLine.priceRule);
    expect(dupLine.discountPercent?.toString()).toBe(srcLine.discountPercent?.toString());
    expect(dupLine.customerNote).toBe('rush');

    // Order-level discount + notes copied.
    expect(dup.orderDiscountPercent?.toString()).toBe('5');
    expect(dup.customerNotes).toBe('cust note');
    expect(dup.internalNotes).toBe('internal note');
    expect(dup.customerPo).toBe('PO-ORIG-1');

    // Reset fields: ship date, shipping, handling.
    expect(dup.promisedShipDate).toBeNull();
    expect(dup.shippingAmount).toBeNull();
    expect(dup.handlingAmount).toBeNull();
    // Reset transient line-state.
    expect(dupLine.qtyReserved.toString()).toBe('0');
    expect(dupLine.qtyShipped.toString()).toBe('0');
    expect(dupLine.inventoryMovementId).toBeNull();
  });

  it('Duplicating from CONFIRMED/CANCELLED still produces a clean DRAFT', async () => {
    const src = await createSalesOrder(db, input());
    // Reservation needs stock — receive a tiny qty so confirm passes.
    await db.inventoryItem.upsert({
      where: { variantId_warehouseId: { variantId, warehouseId } },
      create: { variantId, warehouseId, onHand: new Prisma.Decimal('100') },
      update: { onHand: new Prisma.Decimal('100') },
    });
    await confirmSalesOrder(db, src.id);
    await cancelSalesOrder(db, src.id, { reason: 'test' });

    const dup = await duplicateSalesOrder(db, src.id);
    expect(dup.status).toBe(SalesOrderStatus.DRAFT);
    expect(dup.lines[0]!.qtyReserved.toString()).toBe('0');
  });

  it('Soft-deleted source is rejected', async () => {
    const src = await createSalesOrder(db, input());
    await softDeleteSalesOrder(db, src.id);
    await expect(duplicateSalesOrder(db, src.id)).rejects.toThrow(/soft-deleted/);
  });

  it('Unknown source id is rejected', async () => {
    await expect(duplicateSalesOrder(db, 'nonexistent-id')).rejects.toThrow(/not found/);
  });

  it('Writes a CREATE audit row for the new SO', async () => {
    const src = await createSalesOrder(db, input());
    const dup = await duplicateSalesOrder(db, src.id, { userId: 'tester' });
    const rows = await db.auditLog.findMany({
      where: { entityType: 'SalesOrder', entityId: dup.id, action: AuditAction.CREATE },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userId).toBe('tester');
    // Anchor: duplicatedFromId in the after payload so the timeline
    // can render "duplicated from {srcNumber}".
    const after = rows[0]!.afterJson as Record<string, unknown> | null;
    expect(after?.duplicatedFromId).toBe(src.id);
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
