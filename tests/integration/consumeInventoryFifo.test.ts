import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Prisma, InventoryMovementType } from '@/generated/tenant';
import type { PrismaClient } from '@/generated/tenant';
import {
  consumeInventory,
  consumeInventoryTx,
  receiveInventoryTx,
} from '@/server/services/movements';
import { createFifoLayerOnReceiveTx } from '@/server/services/fifoLayers';
import { setSetting } from '@/server/services/settings';
import {
  SETTING_KEYS,
  negativeInventoryAllowedValueSchema,
} from '@/lib/validation/settings';
import { hasTenantDb, makeClient } from '../helpers/db';

const suite = hasTenantDb ? describe : describe.skip;

suite('consumeInventoryTx FIFO outcomes (Phase 1C)', () => {
  let db: PrismaClient;
  let vendorId: string;
  let warehouseId: string;
  let productId: string;
  let variantId: string;
  let settingId: string;

  beforeAll(async () => {
    db = makeClient();
    const v = await db.vendor.upsert({
      where: { code: 'TEST-VEND-FIFO-CONSUME' },
      create: { code: 'TEST-VEND-FIFO-CONSUME', name: 'Test FIFO Consume Vendor' },
      update: { active: true, deletedAt: null },
    });
    vendorId = v.id;
    const wh = await db.warehouse.upsert({
      where: { code: 'TEST-WH-FIFO-CONSUME' },
      create: { code: 'TEST-WH-FIFO-CONSUME', name: 'Test FIFO Consume Warehouse' },
      update: { active: true, deletedAt: null },
    });
    warehouseId = wh.id;
    const product = await db.product.upsert({
      where: { sku: 'TEST-PROD-FIFO-CONSUME' },
      create: { sku: 'TEST-PROD-FIFO-CONSUME', name: 'Test FIFO Consume Product' },
      update: { active: true, deletedAt: null },
    });
    productId = product.id;
    const variant = await db.productVariant.upsert({
      where: { sku: 'TEST-PROD-FIFO-CONSUME-V1' },
      create: {
        productId: product.id,
        sku: 'TEST-PROD-FIFO-CONSUME-V1',
        name: 'Test FIFO Consume Variant',
      },
      update: { productId: product.id, active: true, deletedAt: null },
    });
    variantId = variant.id;
    const settingRow = await db.setting.findUniqueOrThrow({
      where: { key: SETTING_KEYS.NEGATIVE_INVENTORY_ALLOWED },
      select: { id: true },
    });
    settingId = settingRow.id;
  });

  beforeEach(async () => {
    await wipe();
  });

  afterEach(async () => {
    // Reset neg-inv flag back to false so tests can't bleed state.
    await db.setting.update({
      where: { key: SETTING_KEYS.NEGATIVE_INVENTORY_ALLOWED },
      data: { value: { allowed: false } },
    });
    await db.auditLog.deleteMany({
      where: { entityType: 'Setting', entityId: settingId },
    });
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
  // Scoped cleanup — Phase-1B-style. Snapshot owned layer + movement ids
  // BEFORE deleting, then walk the FK graph children-first.
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
        where: { entityType: 'InventoryMovement', entityId: { in: movementIds } },
      });
      // ReceiptLine.inventoryMovementId points to InventoryMovement; null
      // before deleting movements to avoid the FK error path. Same pattern
      // as fifoLayers.test.ts wipe().
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
  // Helpers — manufacture FifoLayers + matching onHand the same way Phase 1A
  // tests do (direct fixture calls; we don't need a real Receipt). The
  // RECEIVE movement is created via receiveInventoryTx so onHand stays
  // consistent with the layer's qtyReceived.
  // --------------------------------------------------------------------------
  async function makeReceiptShell(): Promise<string> {
    const number = `TEST-RCPT-${Math.random().toString(36).slice(2, 10)}`;
    const r = await db.receipt.create({
      data: { number, vendorId, warehouseId },
    });
    return r.id;
  }

  async function seedLayer(
    qty: string,
    unitCost: string,
    receivedDate: Date,
  ): Promise<string> {
    return db.$transaction(async (tx) => {
      const receiptId = await makeReceiptShell();
      const line = await tx.receiptLine.create({
        data: {
          receiptId,
          variantId,
          warehouseId,
          qtyReceived: new Prisma.Decimal(qty),
          unitCost: new Prisma.Decimal(unitCost),
        },
      });
      const movement = await receiveInventoryTx(tx, {
        variantId,
        warehouseId,
        qty,
        reference: 'SEED-FIFO',
      });
      // Stamp unitCost on the RECEIVE movement to match Phase 1B postReceipt.
      await tx.inventoryMovement.update({
        where: { id: movement.id },
        data: { unitCost: new Prisma.Decimal(unitCost) },
      });
      await tx.receiptLine.update({
        where: { id: line.id },
        data: { inventoryMovementId: movement.id },
      });
      const layer = await createFifoLayerOnReceiveTx(tx, {
        variantId,
        warehouseId,
        qtyReceived: qty,
        unitCost,
        receivedDate,
        sourceReceiptLineId: line.id,
        sourceMovementId: movement.id,
      });
      return layer.id;
    });
  }

  // ==========================================================================
  // Outcome: covered_by_layers
  // ==========================================================================

  it('produces outcome covered_by_layers when layers cover the qty (single layer)', async () => {
    await seedLayer('10', '4', new Date('2026-04-01'));

    const movement = await consumeInventory(db, {
      variantId,
      warehouseId,
      qty: '6',
      reference: 'COV-1',
    });

    expect(movement.type).toBe(InventoryMovementType.CONSUME);
    expect(movement.qty.toString()).toBe(new Prisma.Decimal('-6').toString());
    expect(movement.unitCost?.toString()).toBe(new Prisma.Decimal('4').toString());
    expect(movement.negativeAllocation).toBe(false);

    const consumptions = await db.fifoConsumption.findMany({
      where: { movementId: movement.id },
    });
    expect(consumptions).toHaveLength(1);
    expect(consumptions[0].qty.toString()).toBe(new Prisma.Decimal('6').toString());
    expect(consumptions[0].unitCost.toString()).toBe(new Prisma.Decimal('4').toString());
  });

  it('produces outcome covered_by_layers with multi-layer split — WAC = (5*1 + 2*2)/7 = 9/7', async () => {
    // Layer 1 received earlier, layer 2 received later — FIFO walks 1 first.
    await seedLayer('5', '1', new Date('2026-03-01'));
    await seedLayer('5', '2', new Date('2026-03-15'));

    const movement = await consumeInventory(db, {
      variantId,
      warehouseId,
      qty: '7',
      reference: 'COV-2',
    });

    // 5 units @ $1 + 2 units @ $2 = $9 total, 7 units = $9/7 WAC.
    // Persisted column is @db.Decimal(18, 5), so compare at 5dp precision.
    const expectedWac = new Prisma.Decimal('9').dividedBy(new Prisma.Decimal('7'));
    expect(movement.unitCost).not.toBeNull();
    expect(movement.unitCost!.toFixed(5)).toBe(expectedWac.toFixed(5));
    expect(movement.negativeAllocation).toBe(false);

    const consumptions = await db.fifoConsumption.findMany({
      where: { movementId: movement.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(consumptions).toHaveLength(2);
    expect(consumptions[0].qty.toString()).toBe(new Prisma.Decimal('5').toString());
    expect(consumptions[0].unitCost.toString()).toBe(new Prisma.Decimal('1').toString());
    expect(consumptions[1].qty.toString()).toBe(new Prisma.Decimal('2').toString());
    expect(consumptions[1].unitCost.toString()).toBe(new Prisma.Decimal('2').toString());
  });

  // ==========================================================================
  // Outcome: covered_by_onhand_no_layers (option-A backward compat)
  // ==========================================================================

  it('produces outcome covered_by_onhand_no_layers when onHand was seeded via receiveInventoryTx (no layer)', async () => {
    // Seed inventory WITHOUT going through postReceipt — i.e., no FifoLayer.
    // This is the option-A back-compat path used by movements.tx-variants /
    // movements.concurrency tests.
    await db.$transaction(async (tx) => {
      await receiveInventoryTx(tx, {
        variantId,
        warehouseId,
        qty: '8',
        reference: 'NOLAYER-SEED',
      });
    });

    // Sanity: no layers, but onHand=8.
    const layerCount = await db.fifoLayer.count({ where: { variantId } });
    expect(layerCount).toBe(0);

    const movement = await consumeInventory(db, {
      variantId,
      warehouseId,
      qty: '3',
      reference: 'NOLAYER-CONS',
    });

    expect(movement.type).toBe(InventoryMovementType.CONSUME);
    expect(movement.qty.toString()).toBe(new Prisma.Decimal('-3').toString());
    expect(movement.unitCost).toBeNull();

    const consumptions = await db.fifoConsumption.findMany({
      where: { movementId: movement.id },
    });
    expect(consumptions).toHaveLength(0);
  });

  it('outcome covered_by_onhand_no_layers leaves negativeAllocation=false', async () => {
    await db.$transaction(async (tx) => {
      await receiveInventoryTx(tx, {
        variantId,
        warehouseId,
        qty: '5',
        reference: 'NOLAYER-NEGFLAG-SEED',
      });
    });

    const movement = await consumeInventory(db, {
      variantId,
      warehouseId,
      qty: '5',
      reference: 'NOLAYER-NEGFLAG-CONS',
    });

    expect(movement.negativeAllocation).toBe(false);
    expect(movement.unitCost).toBeNull();
  });

  // ==========================================================================
  // Outcome: throw (flag OFF)
  // ==========================================================================

  it('produces outcome throw when no layers, no onHand, neg-inv flag OFF', async () => {
    await expect(
      consumeInventory(db, {
        variantId,
        warehouseId,
        qty: '3',
        reference: 'THROW-EMPTY',
      }),
    ).rejects.toThrow(/^Insufficient stock for /);

    // No movement persisted (tx rolled back).
    const movements = await db.inventoryMovement.count({
      where: { variantId, reference: 'THROW-EMPTY' },
    });
    expect(movements).toBe(0);
  });

  it('produces outcome throw when layers exist but are insufficient AND flag OFF (no partial allocation)', async () => {
    await seedLayer('3', '5', new Date('2026-04-01'));

    await expect(
      consumeInventory(db, {
        variantId,
        warehouseId,
        qty: '10',
        reference: 'THROW-PARTIAL',
      }),
    ).rejects.toThrow(/^Insufficient stock for /);

    // Layer must be untouched — qtyConsumed still 0 because the outer tx
    // rolled back.
    const layers = await db.fifoLayer.findMany({ where: { variantId } });
    expect(layers).toHaveLength(1);
    expect(layers[0].qtyConsumed.toString()).toBe(new Prisma.Decimal('0').toString());
    expect(layers[0].qtyRemaining.toString()).toBe(new Prisma.Decimal('3').toString());

    // No CONSUME movement, no FifoConsumption rows.
    const consumes = await db.inventoryMovement.count({
      where: { variantId, type: InventoryMovementType.CONSUME },
    });
    expect(consumes).toBe(0);
    const consumptions = await db.fifoConsumption.count({
      where: { layerId: layers[0].id },
    });
    expect(consumptions).toBe(0);
  });

  it('throw outcome error message includes variantId, warehouseId, onHand, and requested qty', async () => {
    await db.$transaction(async (tx) => {
      await receiveInventoryTx(tx, {
        variantId,
        warehouseId,
        qty: '2',
        reference: 'THROW-MSG-SEED',
      });
    });

    let caught: Error | null = null;
    try {
      await consumeInventory(db, {
        variantId,
        warehouseId,
        qty: '5',
        reference: 'THROW-MSG',
      });
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toContain(variantId);
    expect(caught!.message).toContain(warehouseId);
    expect(caught!.message).toContain('onHand=2');
    expect(caught!.message).toContain('requested=5');
    expect(caught!.message.startsWith('Insufficient stock')).toBe(true);
  });

  // ==========================================================================
  // Outcome: negative_allocation
  // ==========================================================================

  it('produces outcome negative_allocation sub-case A — no layers, no onHand, flag ON → ZERO FifoConsumption rows', async () => {
    await setSetting(
      db,
      SETTING_KEYS.NEGATIVE_INVENTORY_ALLOWED,
      { allowed: true },
      negativeInventoryAllowedValueSchema,
    );

    const movement = await consumeInventory(db, {
      variantId,
      warehouseId,
      qty: '4',
      reference: 'NEG-A',
    });

    expect(movement.negativeAllocation).toBe(true);
    expect(movement.unitCost).toBeNull();
    expect(movement.qty.toString()).toBe(new Prisma.Decimal('-4').toString());

    const consumptions = await db.fifoConsumption.findMany({
      where: { movementId: movement.id },
    });
    expect(consumptions).toHaveLength(0);

    // onHand goes negative (the whole point of the flag).
    const item = await db.inventoryItem.findUnique({
      where: { variantId_warehouseId: { variantId, warehouseId } },
    });
    expect(item!.onHand.toString()).toBe(new Prisma.Decimal('-4').toString());
  });

  it('produces outcome negative_allocation sub-case B — layers exist but insufficient + flag ON → 1+ FifoConsumption rows for partial draw', async () => {
    await setSetting(
      db,
      SETTING_KEYS.NEGATIVE_INVENTORY_ALLOWED,
      { allowed: true },
      negativeInventoryAllowedValueSchema,
    );
    const layerId = await seedLayer('3', '7', new Date('2026-04-01'));

    const movement = await consumeInventory(db, {
      variantId,
      warehouseId,
      qty: '10',
      reference: 'NEG-B',
    });

    // Movement records "unknown cost" because the bin went negative.
    expect(movement.negativeAllocation).toBe(true);
    expect(movement.unitCost).toBeNull();
    expect(movement.qty.toString()).toBe(new Prisma.Decimal('-10').toString());

    // FifoConsumption rows DO exist for the partial draw — the layer was
    // fully drained even though the bin couldn't cover the request.
    const consumptions = await db.fifoConsumption.findMany({
      where: { movementId: movement.id },
    });
    expect(consumptions.length).toBeGreaterThanOrEqual(1);
    const totalDrawn = consumptions.reduce(
      (acc, c) => acc.plus(c.qty),
      new Prisma.Decimal(0),
    );
    expect(totalDrawn.toString()).toBe(new Prisma.Decimal('3').toString());

    // Layer drained to zero remaining.
    const layerAfter = await db.fifoLayer.findUniqueOrThrow({ where: { id: layerId } });
    expect(layerAfter.qtyConsumed.toString()).toBe(new Prisma.Decimal('3').toString());
    expect(layerAfter.qtyRemaining.toString()).toBe(new Prisma.Decimal('0').toString());

    // onHand goes negative: 3 received - 10 consumed = -7.
    const item = await db.inventoryItem.findUnique({
      where: { variantId_warehouseId: { variantId, warehouseId } },
    });
    expect(item!.onHand.toString()).toBe(new Prisma.Decimal('-7').toString());
  });

  it('throw outcome rolls back layer mutations: defensive caller-rollback test', async () => {
    // Simulate a downstream throw AFTER consumeInventoryTx commits its
    // layer walk inside the same caller tx — Prisma's tx semantics must
    // roll the layer's qtyConsumed back. This protects against future
    // refactors that might split the tx.
    const layerId = await seedLayer('10', '5', new Date('2026-04-01'));

    await expect(
      db.$transaction(async (tx) => {
        await consumeInventoryTx(tx, {
          variantId,
          warehouseId,
          qty: '4',
          reference: 'TX-ROLLBACK',
        });
        throw new Error('caller bails out');
      }),
    ).rejects.toThrow('caller bails out');

    const layerAfter = await db.fifoLayer.findUniqueOrThrow({ where: { id: layerId } });
    expect(layerAfter.qtyConsumed.toString()).toBe(new Prisma.Decimal('0').toString());
    expect(layerAfter.qtyRemaining.toString()).toBe(new Prisma.Decimal('10').toString());

    const consumptions = await db.fifoConsumption.count({
      where: { layerId },
    });
    expect(consumptions).toBe(0);
  });
});
