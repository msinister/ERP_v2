import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AuditAction,
  InventoryMovementType,
  Prisma,
  PriceResolutionRule,
  SalesOrderStatus,
} from '@/generated/tenant';
import type { PrismaClient } from '@/generated/tenant';
import {
  closeSalesOrder,
  confirmSalesOrder,
  createSalesOrder,
  dispatchSalesOrder,
} from '@/server/services/salesOrders';
import { receiveInventory } from '@/server/services/movements';
import { wipeInvoiceArtifactsForSOs } from '../helpers/wipeInvoiceArtifacts';
import { hasTenantDb, makeClient } from '../helpers/db';
import { upsertTestCustomer } from '../helpers/customerStub';
import { upsertTestWarehouse } from '../helpers/warehouseStub';

const suite = hasTenantDb ? describe : describe.skip;

suite('SalesOrder lifecycle', () => {
  let db: PrismaClient;
  let customerId: string;
  let warehouseId: string;
  let productId: string;
  let variantId: string;

  beforeAll(async () => {
    db = makeClient();
    const c = await upsertTestCustomer(db, {
      code: 'TEST-CUST-SO-LC',
      name: 'Test SO Customer',
    });
    customerId = c.id;
    const wh = await upsertTestWarehouse(db, {
      code: 'TEST-WH-SO-LC',
      name: 'Test SO Warehouse',
    });
    warehouseId = wh.id;
    const product = await db.product.upsert({
      where: { sku: 'TEST-PROD-SO-LC' },
      create: {
        sku: 'TEST-PROD-SO-LC',
        name: 'Test SO Product',
        basePrice: new Prisma.Decimal('9.99'),
      },
      update: {
        active: true,
        deletedAt: null,
        basePrice: new Prisma.Decimal('9.99'),
      },
    });
    productId = product.id;
    const variant = await db.productVariant.upsert({
      where: { sku: 'TEST-PROD-SO-LC-V1' },
      create: { productId: product.id, sku: 'TEST-PROD-SO-LC-V1', name: 'V1' },
      update: { productId: product.id, active: true, deletedAt: null },
    });
    variantId = variant.id;
  });

  beforeEach(async () => {
    await wipe(db, { customerId, variantId, warehouseId });
  });

  afterAll(async () => {
    await wipe(db, { customerId, variantId, warehouseId });
    await db.productVariant.deleteMany({ where: { id: variantId } });
    await db.product.deleteMany({ where: { id: productId } });
    await db.warehouse.deleteMany({ where: { id: warehouseId } });
    await db.customer.deleteMany({ where: { id: customerId } });
    await db.$disconnect();
  });

  // Stock the bin so close can consume.
  async function stockBin(qty: string): Promise<void> {
    await receiveInventory(db, {
      variantId,
      warehouseId,
      qty,
      reference: 'TEST_SEED',
    });
  }

  function createInput(qty = '5', manualUnitPrice?: string) {
    return {
      customerId,
      warehouseId,
      lines: [
        {
          variantId,
          warehouseId,
          qtyOrdered: qty,
          ...(manualUnitPrice ? { manualUnitPrice } : {}),
        },
      ],
    };
  }

  it('createSalesOrder issues SO-YYYY-NNNNN, resolves base price, status DRAFT', async () => {
    const so = await createSalesOrder(db, createInput('5'));
    expect(so.number).toMatch(/^SO-\d{4}-\d{5}$/);
    expect(so.status).toBe(SalesOrderStatus.DRAFT);
    expect(so.lines).toHaveLength(1);
    expect(so.lines[0].priceRule).toBe(PriceResolutionRule.BASE_PRICE);
    expect(so.lines[0].unitPrice.toString()).toBe(new Prisma.Decimal('9.99').toString());
    expect(so.lines[0].qtyReserved.toString()).toBe(new Prisma.Decimal('0').toString());
    expect(so.lines[0].qtyShipped.toString()).toBe(new Prisma.Decimal('0').toString());
  });

  it('manualUnitPrice records MANUAL_OVERRIDE rule', async () => {
    const so = await createSalesOrder(db, createInput('3', '7.50'));
    expect(so.lines[0].priceRule).toBe(PriceResolutionRule.MANUAL_OVERRIDE);
    expect(so.lines[0].unitPrice.toString()).toBe(new Prisma.Decimal('7.50').toString());
  });

  it('SO numbering is monotonic across two creates', async () => {
    const a = await createSalesOrder(db, createInput('1'));
    const b = await createSalesOrder(db, createInput('1'));
    const [, yearA, seqA] = a.number.match(/^SO-(\d{4})-(\d{5})$/)!;
    const [, yearB, seqB] = b.number.match(/^SO-(\d{4})-(\d{5})$/)!;
    expect(yearA).toBe(yearB);
    // Other parallel test suites may bump the shared sales_order sequence
    // between A and B — assert strictly-greater rather than exactly +1.
    expect(parseInt(seqB, 10)).toBeGreaterThan(parseInt(seqA, 10));
  });

  it('DRAFT -> CONFIRMED bumps Reserved on the bin; OnHand untouched', async () => {
    await stockBin('20');
    const so = await createSalesOrder(db, createInput('5'));
    const inv0 = await db.inventoryItem.findUnique({
      where: { variantId_warehouseId: { variantId, warehouseId } },
    });
    expect(inv0!.onHand.toString()).toBe(new Prisma.Decimal('20').toString());
    expect(inv0!.reserved.toString()).toBe(new Prisma.Decimal('0').toString());

    const confirmed = await confirmSalesOrder(db, so.id);
    expect(confirmed.status).toBe(SalesOrderStatus.CONFIRMED);
    expect(confirmed.confirmedAt).not.toBeNull();
    expect(confirmed.lines[0].qtyReserved.toString()).toBe(
      new Prisma.Decimal('5').toString(),
    );

    const inv1 = await db.inventoryItem.findUnique({
      where: { variantId_warehouseId: { variantId, warehouseId } },
    });
    expect(inv1!.onHand.toString()).toBe(new Prisma.Decimal('20').toString());
    expect(inv1!.reserved.toString()).toBe(new Prisma.Decimal('5').toString());
  });

  it('CONFIRMED -> DISPATCHED has no inventory effect', async () => {
    await stockBin('20');
    const so = await createSalesOrder(db, createInput('5'));
    await confirmSalesOrder(db, so.id);
    const before = await db.inventoryItem.findUnique({
      where: { variantId_warehouseId: { variantId, warehouseId } },
    });
    const dispatched = await dispatchSalesOrder(db, so.id);
    expect(dispatched.status).toBe(SalesOrderStatus.DISPATCHED);
    const after = await db.inventoryItem.findUnique({
      where: { variantId_warehouseId: { variantId, warehouseId } },
    });
    expect(after!.onHand.toString()).toBe(before!.onHand.toString());
    expect(after!.reserved.toString()).toBe(before!.reserved.toString());
  });

  it('DISPATCHED -> CLOSED creates one CONSUME movement; OnHand drops, Reserved zeros', async () => {
    await stockBin('20');
    const so = await createSalesOrder(db, createInput('5'));
    await confirmSalesOrder(db, so.id);
    await dispatchSalesOrder(db, so.id);
    const closed = await closeSalesOrder(db, so.id, undefined);
    expect(closed.status).toBe(SalesOrderStatus.CLOSED);
    expect(closed.closedAt).not.toBeNull();
    expect(closed.lines[0].qtyShipped.toString()).toBe(new Prisma.Decimal('5').toString());
    expect(closed.lines[0].qtyReserved.toString()).toBe(new Prisma.Decimal('0').toString());

    const inv = await db.inventoryItem.findUnique({
      where: { variantId_warehouseId: { variantId, warehouseId } },
    });
    expect(inv!.onHand.toString()).toBe(new Prisma.Decimal('15').toString());
    expect(inv!.reserved.toString()).toBe(new Prisma.Decimal('0').toString());

    const movements = await db.inventoryMovement.findMany({
      where: { variantId, warehouseId, type: InventoryMovementType.CONSUME, reference: closed.number },
    });
    expect(movements).toHaveLength(1);
    expect(movements[0].qty.toString()).toBe(new Prisma.Decimal('-5').toString());
  });

  it('Pickup path: CONFIRMED -> CLOSED skips DISPATCHED legally', async () => {
    await stockBin('10');
    const so = await createSalesOrder(db, createInput('3'));
    await confirmSalesOrder(db, so.id);
    const closed = await closeSalesOrder(db, so.id, undefined);
    expect(closed.status).toBe(SalesOrderStatus.CLOSED);
    expect(closed.dispatchedAt).toBeNull();
    const inv = await db.inventoryItem.findUnique({
      where: { variantId_warehouseId: { variantId, warehouseId } },
    });
    expect(inv!.onHand.toString()).toBe(new Prisma.Decimal('7').toString());
    expect(inv!.reserved.toString()).toBe(new Prisma.Decimal('0').toString());
  });

  it('Insufficient stock at close throws AND emits an INSUFFICIENT_STOCK_AT_CLOSE audit row', async () => {
    await stockBin('2'); // only 2 in stock
    const so = await createSalesOrder(db, createInput('5'));
    await confirmSalesOrder(db, so.id);
    await dispatchSalesOrder(db, so.id);
    await expect(closeSalesOrder(db, so.id, undefined)).rejects.toThrow(/Insufficient stock/);

    const audits = await db.auditLog.findMany({
      where: { action: AuditAction.INSUFFICIENT_STOCK_AT_CLOSE, entityType: 'SalesOrder', entityId: so.id },
    });
    expect(audits).toHaveLength(1);
    const after = audits[0].afterJson as { qtyRequested?: string };
    expect(after.qtyRequested).toBe('5');

    // Status was rolled back with the failed tx — still DISPATCHED.
    const stillDispatched = await db.salesOrder.findUnique({ where: { id: so.id } });
    expect(stillDispatched!.status).toBe(SalesOrderStatus.DISPATCHED);
  });

  it('Audit rows: CREATE on createSalesOrder, STATUS_CHANGE on each transition', async () => {
    await stockBin('20');
    const so = await createSalesOrder(db, createInput('2'));
    await confirmSalesOrder(db, so.id);
    await dispatchSalesOrder(db, so.id);
    await closeSalesOrder(db, so.id, undefined);

    const auditRows = await db.auditLog.findMany({
      where: { entityType: 'SalesOrder', entityId: so.id },
      orderBy: { createdAt: 'asc' },
    });
    const actions = auditRows.map((r) => r.action);
    // Assert by SET membership rather than order — Postgres
    // CURRENT_TIMESTAMP sub-microsecond collisions can make
    // createdAt-ordering unstable when multiple transactions land
    // within the same instant. The semantic invariant is "exactly
    // one CREATE and exactly three STATUS_CHANGE rows".
    expect(actions.filter((a) => a === AuditAction.CREATE)).toHaveLength(1);
    expect(actions.filter((a) => a === AuditAction.STATUS_CHANGE)).toHaveLength(3);
  });
});

async function wipe(
  db: PrismaClient,
  ids: { customerId: string; variantId: string; warehouseId: string },
): Promise<void> {
  // Audit rows referencing our movements + SOs (other test files can run
  // in parallel against the same DB, so scope by id).
  const ourMovements = await db.inventoryMovement.findMany({
    where: { variantId: ids.variantId },
    select: { id: true },
  });
  if (ourMovements.length > 0) {
    await db.auditLog.deleteMany({
      where: {
        entityType: 'InventoryMovement',
        entityId: { in: ourMovements.map((m) => m.id) },
      },
    });
  }
  const ourSos = await db.salesOrder.findMany({
    where: { customerId: ids.customerId },
    select: { id: true },
  });
  if (ourSos.length > 0) {
    await db.auditLog.deleteMany({
      where: {
        entityType: 'SalesOrder',
        entityId: { in: ourSos.map((s) => s.id) },
      },
    });
  }
  await wipeInvoiceArtifactsForSOs(db, ourSos.map((s) => s.id));
  await db.salesOrderLine.deleteMany({ where: { salesOrder: { customerId: ids.customerId } } });
  await db.salesOrder.deleteMany({ where: { customerId: ids.customerId } });
  await db.inventoryMovement.deleteMany({ where: { variantId: ids.variantId } });
  await db.inventoryItem.deleteMany({ where: { variantId: ids.variantId } });
}
