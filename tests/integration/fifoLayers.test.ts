import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { InventoryMovementType, Prisma } from '@/generated/tenant';
import type { PrismaClient } from '@/generated/tenant';
import {
  consumeFromLayersTx,
  createFifoLayerOnReceiveTx,
  getOldestLayer,
} from '@/server/services/fifoLayers';
import { hasTenantDb, makeClient } from '../helpers/db';

const suite = hasTenantDb ? describe : describe.skip;

suite('fifoLayers service', () => {
  let db: PrismaClient;
  let vendorId: string;
  let warehouseId: string;
  let productId: string;
  let variantId: string;

  beforeAll(async () => {
    db = makeClient();
    const v = await db.vendor.upsert({
      where: { code: 'TEST-VEND-FIFO' },
      create: { code: 'TEST-VEND-FIFO', name: 'Test FIFO Vendor' },
      update: { active: true, deletedAt: null },
    });
    vendorId = v.id;
    const wh = await db.warehouse.upsert({
      where: { code: 'TEST-WH-FIFO' },
      create: { code: 'TEST-WH-FIFO', name: 'Test FIFO Warehouse' },
      update: { active: true, deletedAt: null },
    });
    warehouseId = wh.id;
    const product = await db.product.upsert({
      where: { sku: 'TEST-PROD-FIFO' },
      create: { sku: 'TEST-PROD-FIFO', name: 'Test FIFO Product' },
      update: { active: true, deletedAt: null },
    });
    productId = product.id;
    const variant = await db.productVariant.upsert({
      where: { sku: 'TEST-PROD-FIFO-V1' },
      create: {
        productId: product.id,
        sku: 'TEST-PROD-FIFO-V1',
        name: 'Test FIFO Variant',
      },
      update: { productId: product.id, active: true, deletedAt: null },
    });
    variantId = variant.id;
  });

  beforeEach(async () => {
    await wipe();
  });

  afterAll(async () => {
    await wipe();
    await db.productVariant.deleteMany({ where: { id: variantId } });
    await db.product.deleteMany({ where: { id: productId } });
    await db.warehouse.deleteMany({ where: { id: warehouseId } });
    await db.vendor.deleteMany({ where: { id: vendorId } });
    await db.$disconnect();
  });

  // --------------------------------------------------------------------------
  // Scoped cleanup — snapshot test-owned ids first, look up child entity ids
  // BEFORE deleteMany, scope every deleteMany with length guards.
  // --------------------------------------------------------------------------

  async function wipe(): Promise<void> {
    const ourLayers = await db.fifoLayer.findMany({
      where: { variantId },
      select: { id: true },
    });
    const layerIds = ourLayers.map((l) => l.id);

    const ourMovements = await db.inventoryMovement.findMany({
      where: { variantId },
      select: { id: true },
    });
    const movementIds = ourMovements.map((m) => m.id);

    if (layerIds.length > 0) {
      await db.fifoConsumption.deleteMany({
        where: { layerId: { in: layerIds } },
      });
      await db.auditLog.deleteMany({
        where: { entityType: 'FifoLayer', entityId: { in: layerIds } },
      });
      await db.fifoLayer.deleteMany({ where: { id: { in: layerIds } } });
    }

    if (movementIds.length > 0) {
      await db.fifoConsumption.deleteMany({
        where: { movementId: { in: movementIds } },
      });
      await db.auditLog.deleteMany({
        where: {
          entityType: 'InventoryMovement',
          entityId: { in: movementIds },
        },
      });
      // ReceiptLine.inventoryMovementId points to InventoryMovement; null
      // it before deleting movements to avoid the FK error path.
      await db.receiptLine.updateMany({
        where: { inventoryMovementId: { in: movementIds } },
        data: { inventoryMovementId: null },
      });
    }

    await db.receiptLine.deleteMany({ where: { variantId } });
    await db.receipt.deleteMany({ where: { vendorId, warehouseId } });
    if (movementIds.length > 0) {
      await db.inventoryMovement.deleteMany({
        where: { id: { in: movementIds } },
      });
    }
    await db.inventoryItem.deleteMany({ where: { variantId } });
  }

  // --------------------------------------------------------------------------
  // Per-test stub helpers — Phase 1A is foundation-only, so we don't go
  // through postReceipt; instead we manufacture the FK rows directly
  // and call the service under test.
  // --------------------------------------------------------------------------

  async function makeReceipt(): Promise<string> {
    const number = `TEST-RCPT-${Math.random().toString(36).slice(2, 10)}`;
    const r = await db.receipt.create({
      data: { number, vendorId, warehouseId },
    });
    return r.id;
  }

  async function makeReceiveStubs(args: {
    receiptId: string;
    qty: Prisma.Decimal | string | number;
    unitCost: Prisma.Decimal | string | number;
  }): Promise<{ receiptLineId: string; movementId: string }> {
    const movement = await db.inventoryMovement.create({
      data: {
        variantId,
        warehouseId,
        type: InventoryMovementType.RECEIVE,
        qty: new Prisma.Decimal(args.qty),
        unitCost: new Prisma.Decimal(args.unitCost),
        reference: 'TEST-FIFO-STUB',
      },
    });
    const receiptLine = await db.receiptLine.create({
      data: {
        receiptId: args.receiptId,
        variantId,
        warehouseId,
        qtyReceived: new Prisma.Decimal(args.qty),
        unitCost: new Prisma.Decimal(args.unitCost),
        inventoryMovementId: movement.id,
      },
    });
    return { receiptLineId: receiptLine.id, movementId: movement.id };
  }

  async function makeConsumeMovement(qty: Prisma.Decimal | string | number): Promise<string> {
    const m = await db.inventoryMovement.create({
      data: {
        variantId,
        warehouseId,
        type: InventoryMovementType.CONSUME,
        qty: new Prisma.Decimal(qty).negated(),
        reference: 'TEST-FIFO-CONSUME-STUB',
      },
    });
    return m.id;
  }

  async function seedReceive(args: {
    qty: Prisma.Decimal | string | number;
    unitCost: Prisma.Decimal | string | number;
    receivedDate: Date;
  }): Promise<string> {
    const receiptId = await makeReceipt();
    const { receiptLineId, movementId } = await makeReceiveStubs({
      receiptId,
      qty: args.qty,
      unitCost: args.unitCost,
    });
    return db.$transaction(async (tx) => {
      const layer = await createFifoLayerOnReceiveTx(tx, {
        variantId,
        warehouseId,
        qtyReceived: args.qty,
        unitCost: args.unitCost,
        receivedDate: args.receivedDate,
        sourceReceiptLineId: receiptLineId,
        sourceMovementId: movementId,
      });
      return layer.id;
    });
  }

  // --------------------------------------------------------------------------
  // createFifoLayerOnReceiveTx
  // --------------------------------------------------------------------------

  it('createFifoLayerOnReceiveTx happy path: layer created with correct values and source links', async () => {
    const receiptId = await makeReceipt();
    const { receiptLineId, movementId } = await makeReceiveStubs({
      receiptId,
      qty: '10',
      unitCost: '4.5',
    });
    const receivedDate = new Date('2026-04-01T00:00:00Z');

    const layer = await db.$transaction(async (tx) =>
      createFifoLayerOnReceiveTx(tx, {
        variantId,
        warehouseId,
        qtyReceived: '10',
        unitCost: '4.5',
        receivedDate,
        sourceReceiptLineId: receiptLineId,
        sourceMovementId: movementId,
      }),
    );

    expect(layer.variantId).toBe(variantId);
    expect(layer.warehouseId).toBe(warehouseId);
    expect(layer.qtyReceived.toString()).toBe(new Prisma.Decimal('10').toString());
    expect(layer.qtyConsumed.toString()).toBe(new Prisma.Decimal('0').toString());
    expect(layer.qtyRemaining.toString()).toBe(new Prisma.Decimal('10').toString());
    expect(layer.unitCost.toString()).toBe(new Prisma.Decimal('4.5').toString());
    expect(layer.receivedDate.toISOString()).toBe(receivedDate.toISOString());
    expect(layer.sourceReceiptLineId).toBe(receiptLineId);
    expect(layer.sourceMovementId).toBe(movementId);
    expect(layer.deletedAt).toBeNull();

    const auditRows = await db.auditLog.findMany({
      where: { entityType: 'FifoLayer', entityId: layer.id },
    });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].action).toBe('CREATE');
  });

  it('createFifoLayerOnReceiveTx with qtyReceived=0 throws friendly error before hitting CHECK', async () => {
    const receiptId = await makeReceipt();
    const { receiptLineId, movementId } = await makeReceiveStubs({
      receiptId,
      qty: '5',
      unitCost: '1',
    });

    await expect(
      db.$transaction(async (tx) =>
        createFifoLayerOnReceiveTx(tx, {
          variantId,
          warehouseId,
          qtyReceived: '0',
          unitCost: '1',
          receivedDate: new Date(),
          sourceReceiptLineId: receiptLineId,
          sourceMovementId: movementId,
        }),
      ),
    ).rejects.toThrow(/qtyReceived must be > 0/);
  });

  // --------------------------------------------------------------------------
  // consumeFromLayersTx
  // --------------------------------------------------------------------------

  it('consumeFromLayersTx single layer: 5 of 10 → one row, layer 5/5, weighted = layer cost', async () => {
    await seedReceive({
      qty: '10',
      unitCost: '3',
      receivedDate: new Date('2026-04-01T00:00:00Z'),
    });
    const movementId = await makeConsumeMovement('5');

    const result = await db.$transaction(async (tx) =>
      consumeFromLayersTx(tx, {
        variantId,
        warehouseId,
        qty: '5',
        movementId,
      }),
    );

    expect(result.fullyAllocated).toBe(true);
    expect(result.consumptions).toHaveLength(1);
    expect(result.consumptions[0].qty.toString()).toBe(new Prisma.Decimal('5').toString());
    expect(result.consumptions[0].unitCost.toString()).toBe(new Prisma.Decimal('3').toString());
    expect(result.weightedAverageCost?.toString()).toBe(new Prisma.Decimal('3').toString());

    const layers = await db.fifoLayer.findMany({ where: { variantId } });
    expect(layers).toHaveLength(1);
    expect(layers[0].qtyConsumed.toString()).toBe(new Prisma.Decimal('5').toString());
    expect(layers[0].qtyRemaining.toString()).toBe(new Prisma.Decimal('5').toString());
  });

  it('consumeFromLayersTx multi-layer split: receive 5@$1 then 5@$2; consume 7 → 5+2 split, weighted = 9/7', async () => {
    await seedReceive({
      qty: '5',
      unitCost: '1',
      receivedDate: new Date('2026-04-01T00:00:00Z'),
    });
    await seedReceive({
      qty: '5',
      unitCost: '2',
      receivedDate: new Date('2026-04-02T00:00:00Z'),
    });
    const movementId = await makeConsumeMovement('7');

    const result = await db.$transaction(async (tx) =>
      consumeFromLayersTx(tx, {
        variantId,
        warehouseId,
        qty: '7',
        movementId,
      }),
    );

    expect(result.fullyAllocated).toBe(true);
    expect(result.consumptions).toHaveLength(2);

    // Oldest layer (cost $1) consumed first, fully (5 units).
    expect(result.consumptions[0].qty.toString()).toBe(new Prisma.Decimal('5').toString());
    expect(result.consumptions[0].unitCost.toString()).toBe(new Prisma.Decimal('1').toString());
    // Second layer (cost $2) consumed for the remaining 2 units.
    expect(result.consumptions[1].qty.toString()).toBe(new Prisma.Decimal('2').toString());
    expect(result.consumptions[1].unitCost.toString()).toBe(new Prisma.Decimal('2').toString());

    // Weighted = (5*1 + 2*2) / 7 = 9/7
    const expectedWac = new Prisma.Decimal('9').dividedBy(new Prisma.Decimal('7'));
    expect(result.weightedAverageCost?.toString()).toBe(expectedWac.toString());

    const layers = await db.fifoLayer.findMany({
      where: { variantId },
      orderBy: { receivedDate: 'asc' },
    });
    expect(layers[0].qtyRemaining.toString()).toBe(new Prisma.Decimal('0').toString());
    expect(layers[1].qtyRemaining.toString()).toBe(new Prisma.Decimal('3').toString());
  });

  it('consumeFromLayersTx exhausts oldest first across three layers', async () => {
    await seedReceive({
      qty: '4',
      unitCost: '1',
      receivedDate: new Date('2026-04-01T00:00:00Z'),
    });
    await seedReceive({
      qty: '4',
      unitCost: '2',
      receivedDate: new Date('2026-04-02T00:00:00Z'),
    });
    await seedReceive({
      qty: '4',
      unitCost: '3',
      receivedDate: new Date('2026-04-03T00:00:00Z'),
    });
    const movementId = await makeConsumeMovement('10');

    const result = await db.$transaction(async (tx) =>
      consumeFromLayersTx(tx, {
        variantId,
        warehouseId,
        qty: '10',
        movementId,
      }),
    );

    expect(result.fullyAllocated).toBe(true);
    expect(result.consumptions).toHaveLength(3);
    // Layer 1: 4 units fully drained
    expect(result.consumptions[0].qty.toString()).toBe(new Prisma.Decimal('4').toString());
    expect(result.consumptions[0].unitCost.toString()).toBe(new Prisma.Decimal('1').toString());
    // Layer 2: 4 units fully drained
    expect(result.consumptions[1].qty.toString()).toBe(new Prisma.Decimal('4').toString());
    expect(result.consumptions[1].unitCost.toString()).toBe(new Prisma.Decimal('2').toString());
    // Layer 3: 2 units partially drained
    expect(result.consumptions[2].qty.toString()).toBe(new Prisma.Decimal('2').toString());
    expect(result.consumptions[2].unitCost.toString()).toBe(new Prisma.Decimal('3').toString());

    // Weighted = (4*1 + 4*2 + 2*3) / 10 = 18/10 = 1.8
    expect(result.weightedAverageCost?.toString()).toBe(
      new Prisma.Decimal('18').dividedBy(new Prisma.Decimal('10')).toString(),
    );
  });

  it('consumeFromLayersTx insufficient stock: walks all layers, fullyAllocated=false, partial weighted average', async () => {
    await seedReceive({
      qty: '3',
      unitCost: '1',
      receivedDate: new Date('2026-04-01T00:00:00Z'),
    });
    await seedReceive({
      qty: '2',
      unitCost: '4',
      receivedDate: new Date('2026-04-02T00:00:00Z'),
    });
    const movementId = await makeConsumeMovement('100'); // far in excess

    const result = await db.$transaction(async (tx) =>
      consumeFromLayersTx(tx, {
        variantId,
        warehouseId,
        qty: '100',
        movementId,
      }),
    );

    expect(result.fullyAllocated).toBe(false);
    expect(result.consumptions).toHaveLength(2);
    // Each layer fully drained, no over-consumption
    expect(result.consumptions[0].qty.toString()).toBe(new Prisma.Decimal('3').toString());
    expect(result.consumptions[1].qty.toString()).toBe(new Prisma.Decimal('2').toString());

    const layers = await db.fifoLayer.findMany({
      where: { variantId },
      orderBy: { receivedDate: 'asc' },
    });
    expect(layers[0].qtyRemaining.toString()).toBe(new Prisma.Decimal('0').toString());
    expect(layers[1].qtyRemaining.toString()).toBe(new Prisma.Decimal('0').toString());

    // Weighted reflects the actually-allocated 5 units: (3*1 + 2*4) / 5 = 11/5
    const expectedWac = new Prisma.Decimal('11').dividedBy(new Prisma.Decimal('5'));
    expect(result.weightedAverageCost?.toString()).toBe(expectedWac.toString());
  });

  it('consumeFromLayersTx no layers: empty consumptions, null weighted, fullyAllocated=false', async () => {
    const movementId = await makeConsumeMovement('5');

    const result = await db.$transaction(async (tx) =>
      consumeFromLayersTx(tx, {
        variantId,
        warehouseId,
        qty: '5',
        movementId,
      }),
    );

    expect(result.consumptions).toEqual([]);
    expect(result.weightedAverageCost).toBeNull();
    expect(result.fullyAllocated).toBe(false);
  });

  it('consumeFromLayersTx skips soft-deleted layers', async () => {
    const oldLayerId = await seedReceive({
      qty: '10',
      unitCost: '1',
      receivedDate: new Date('2026-04-01T00:00:00Z'),
    });
    await db.fifoLayer.update({
      where: { id: oldLayerId },
      data: { deletedAt: new Date() },
    });
    await seedReceive({
      qty: '10',
      unitCost: '2',
      receivedDate: new Date('2026-04-02T00:00:00Z'),
    });
    const movementId = await makeConsumeMovement('4');

    const result = await db.$transaction(async (tx) =>
      consumeFromLayersTx(tx, {
        variantId,
        warehouseId,
        qty: '4',
        movementId,
      }),
    );

    expect(result.fullyAllocated).toBe(true);
    expect(result.consumptions).toHaveLength(1);
    expect(result.consumptions[0].unitCost.toString()).toBe(new Prisma.Decimal('2').toString());

    // Soft-deleted layer untouched
    const oldLayer = await db.fifoLayer.findUniqueOrThrow({ where: { id: oldLayerId } });
    expect(oldLayer.qtyConsumed.toString()).toBe(new Prisma.Decimal('0').toString());
  });

  // --------------------------------------------------------------------------
  // getOldestLayer
  // --------------------------------------------------------------------------

  it('getOldestLayer returns oldest non-fully-consumed layer', async () => {
    const oldId = await seedReceive({
      qty: '5',
      unitCost: '1',
      receivedDate: new Date('2026-04-01T00:00:00Z'),
    });
    await seedReceive({
      qty: '5',
      unitCost: '2',
      receivedDate: new Date('2026-04-02T00:00:00Z'),
    });

    const result = await db.$transaction(async (tx) =>
      getOldestLayer(tx, variantId, warehouseId),
    );

    expect(result?.id).toBe(oldId);
    expect(result?.unitCost.toString()).toBe(new Prisma.Decimal('1').toString());
  });

  it('getOldestLayer returns null when no layers exist', async () => {
    const result = await db.$transaction(async (tx) =>
      getOldestLayer(tx, variantId, warehouseId),
    );
    expect(result).toBeNull();
  });

  it('getOldestLayer skips fully-consumed layers (qtyRemaining=0)', async () => {
    const drainedId = await seedReceive({
      qty: '5',
      unitCost: '1',
      receivedDate: new Date('2026-04-01T00:00:00Z'),
    });
    const liveId = await seedReceive({
      qty: '5',
      unitCost: '2',
      receivedDate: new Date('2026-04-02T00:00:00Z'),
    });
    await db.fifoLayer.update({
      where: { id: drainedId },
      data: {
        qtyConsumed: new Prisma.Decimal('5'),
        qtyRemaining: new Prisma.Decimal('0'),
      },
    });

    const result = await db.$transaction(async (tx) =>
      getOldestLayer(tx, variantId, warehouseId),
    );

    expect(result?.id).toBe(liveId);
  });

  it('getOldestLayer skips soft-deleted layers', async () => {
    const softDeletedId = await seedReceive({
      qty: '5',
      unitCost: '1',
      receivedDate: new Date('2026-04-01T00:00:00Z'),
    });
    const liveId = await seedReceive({
      qty: '5',
      unitCost: '2',
      receivedDate: new Date('2026-04-02T00:00:00Z'),
    });
    await db.fifoLayer.update({
      where: { id: softDeletedId },
      data: { deletedAt: new Date() },
    });

    const result = await db.$transaction(async (tx) =>
      getOldestLayer(tx, variantId, warehouseId),
    );

    expect(result?.id).toBe(liveId);
  });
});
