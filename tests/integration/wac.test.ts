import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Prisma, ReceiptStatus } from '@/generated/tenant';
import type { PrismaClient } from '@/generated/tenant';
import { createFifoLayerOnReceiveTx } from '@/server/services/fifoLayers';
import { receiveInventoryTx, consumeInventory } from '@/server/services/movements';
import { computeWac, getLastPurchaseCost } from '@/server/services/wac';
import { setSetting } from '@/server/services/settings';
import {
  SETTING_KEYS,
  negativeInventoryAllowedValueSchema,
} from '@/lib/validation/settings';
import { hasTenantDb, makeClient } from '../helpers/db';

const suite = hasTenantDb ? describe : describe.skip;

suite('wac service (Part 2)', () => {
  let db: PrismaClient;
  let vendorId: string;
  let warehouseAId: string;
  let warehouseBId: string;
  let productId: string;
  let variantId: string;
  let settingId: string;

  beforeAll(async () => {
    db = makeClient();
    const v = await db.vendor.upsert({
      where: { code: 'TEST-VEND-WAC' },
      create: { code: 'TEST-VEND-WAC', name: 'Test WAC Vendor' },
      update: { active: true, deletedAt: null },
    });
    vendorId = v.id;
    const wa = await db.warehouse.upsert({
      where: { code: 'TEST-WH-WAC-A' },
      create: { code: 'TEST-WH-WAC-A', name: 'Test WAC Warehouse A' },
      update: { active: true, deletedAt: null },
    });
    const wb = await db.warehouse.upsert({
      where: { code: 'TEST-WH-WAC-B' },
      create: { code: 'TEST-WH-WAC-B', name: 'Test WAC Warehouse B' },
      update: { active: true, deletedAt: null },
    });
    warehouseAId = wa.id;
    warehouseBId = wb.id;
    const product = await db.product.upsert({
      where: { sku: 'TEST-PROD-WAC' },
      create: { sku: 'TEST-PROD-WAC', name: 'Test WAC Product' },
      update: { active: true, deletedAt: null },
    });
    productId = product.id;
    const variant = await db.productVariant.upsert({
      where: { sku: 'TEST-PROD-WAC-V1' },
      create: {
        productId: product.id,
        sku: 'TEST-PROD-WAC-V1',
        name: 'Test WAC Variant',
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
    // Reset neg-inv flag in case a test flipped it.
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
    await db.warehouse.deleteMany({
      where: { id: { in: [warehouseAId, warehouseBId] } },
    });
    await db.vendor.deleteMany({ where: { id: vendorId } });
    await db.$disconnect();
  });

  // --------------------------------------------------------------------------
  // Scoped cleanup — Phase-1B-style; mirror fifoLayers.test.ts wipe() shape.
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
      await db.receiptLine.updateMany({
        where: { inventoryMovementId: { in: movementIds } },
        data: { inventoryMovementId: null },
      });
    }
    await db.receiptLine.deleteMany({ where: { variantId } });
    await db.receipt.deleteMany({ where: { vendorId } });
    if (movementIds.length > 0) {
      await db.inventoryMovement.deleteMany({
        where: { id: { in: movementIds } },
      });
    }
    await db.inventoryItem.deleteMany({ where: { variantId } });
  }

  // --------------------------------------------------------------------------
  // Helpers — manufacture a layer + matching RECEIVE movement + onHand,
  // tied to a real Receipt. The Receipt is parameterized so we can test
  // last-purchase-cost ordering and cancellation paths.
  // --------------------------------------------------------------------------
  async function seedReceiptWithLayer(opts: {
    qty: string;
    unitCost: string;
    receivedAt: Date;
    warehouseId?: string;
    status?: ReceiptStatus;
  }): Promise<{ receiptId: string; layerId: string | null }> {
    const wh = opts.warehouseId ?? warehouseAId;
    return db.$transaction(async (tx) => {
      const number = `TEST-RCPT-WAC-${Math.random().toString(36).slice(2, 10)}`;
      const r = await tx.receipt.create({
        data: {
          number,
          vendorId,
          warehouseId: wh,
          status: opts.status ?? ReceiptStatus.POSTED,
          receivedAt: opts.receivedAt,
        },
      });
      const line = await tx.receiptLine.create({
        data: {
          receiptId: r.id,
          variantId,
          warehouseId: wh,
          qtyReceived: new Prisma.Decimal(opts.qty),
          unitCost: new Prisma.Decimal(opts.unitCost),
        },
      });
      // Only create the layer + movement when the receipt is POSTED. A
      // CANCELLED test receipt simulates a receipt that was posted then
      // cancelled (post-1B cancel soft-deletes the layer); for our
      // last-purchase-cost cancellation test, we just need the receipt
      // row in CANCELLED state with its line — no layer required.
      if ((opts.status ?? ReceiptStatus.POSTED) !== ReceiptStatus.POSTED) {
        return { receiptId: r.id, layerId: null };
      }
      const movement = await receiveInventoryTx(tx, {
        variantId,
        warehouseId: wh,
        qty: opts.qty,
        reference: number,
      });
      await tx.inventoryMovement.update({
        where: { id: movement.id },
        data: { unitCost: new Prisma.Decimal(opts.unitCost) },
      });
      await tx.receiptLine.update({
        where: { id: line.id },
        data: { inventoryMovementId: movement.id },
      });
      const layer = await createFifoLayerOnReceiveTx(tx, {
        variantId,
        warehouseId: wh,
        qtyReceived: opts.qty,
        unitCost: opts.unitCost,
        receivedDate: opts.receivedAt,
        sourceReceiptLineId: line.id,
        sourceMovementId: movement.id,
      });
      return { receiptId: r.id, layerId: layer.id };
    });
  }

  // ==========================================================================
  // computeWac
  // ==========================================================================

  it('(a) computeWac returns single-layer cost when only one layer exists', async () => {
    await seedReceiptWithLayer({ qty: '10', unitCost: '4', receivedAt: new Date('2026-04-01') });
    const wac = await computeWac(db, variantId, warehouseAId);
    expect(wac).not.toBeNull();
    expect(wac!.toString()).toBe(new Prisma.Decimal('4').toString());
  });

  it('(b) computeWac returns weighted average across two layers (5@$1 + 5@$2 = $1.50)', async () => {
    await seedReceiptWithLayer({ qty: '5', unitCost: '1', receivedAt: new Date('2026-03-01') });
    await seedReceiptWithLayer({ qty: '5', unitCost: '2', receivedAt: new Date('2026-03-15') });
    const wac = await computeWac(db, variantId, warehouseAId);
    // (5*1 + 5*2)/10 = 1.5 — exact at full precision.
    expect(wac).not.toBeNull();
    expect(wac!.toString()).toBe(new Prisma.Decimal('1.5').toString());
  });

  it('(c) computeWac after partial consume tracks remaining qty: layers 5@$1 + 5@$2, consume 3 → (2*1 + 5*2)/7', async () => {
    await seedReceiptWithLayer({ qty: '5', unitCost: '1', receivedAt: new Date('2026-03-01') });
    await seedReceiptWithLayer({ qty: '5', unitCost: '2', receivedAt: new Date('2026-03-15') });
    await consumeInventory(db, {
      variantId,
      warehouseId: warehouseAId,
      qty: '3',
      reference: 'WAC-PARTIAL',
    });

    const wac = await computeWac(db, variantId, warehouseAId);
    // After consume: layer1 has qtyRemaining=2 @ $1, layer2 has 5 @ $2.
    // WAC = (2*1 + 5*2) / 7 = 12/7. Full Decimal.js precision (no DB round-trip).
    const expected = new Prisma.Decimal('12').dividedBy(new Prisma.Decimal('7'));
    expect(wac).not.toBeNull();
    expect(wac!.toString()).toBe(expected.toString());
  });

  it('(d) computeWac = null when bin has zero layers', async () => {
    const wac = await computeWac(db, variantId, warehouseAId);
    expect(wac).toBeNull();
  });

  it('(e) computeWac = null when all layers fully consumed (qtyRemaining=0 on all)', async () => {
    await seedReceiptWithLayer({ qty: '5', unitCost: '3', receivedAt: new Date('2026-04-01') });
    await consumeInventory(db, {
      variantId,
      warehouseId: warehouseAId,
      qty: '5',
      reference: 'WAC-DRAIN',
    });
    const wac = await computeWac(db, variantId, warehouseAId);
    expect(wac).toBeNull();
  });

  it('(f) computeWac ignores soft-deleted layers', async () => {
    const { layerId: live } = await seedReceiptWithLayer({
      qty: '4', unitCost: '2', receivedAt: new Date('2026-04-01'),
    });
    const { layerId: doomed } = await seedReceiptWithLayer({
      qty: '6', unitCost: '5', receivedAt: new Date('2026-04-02'),
    });
    expect(live).not.toBeNull();
    expect(doomed).not.toBeNull();
    await db.fifoLayer.update({
      where: { id: doomed! },
      data: { deletedAt: new Date() },
    });

    const wac = await computeWac(db, variantId, warehouseAId);
    // Only the live layer counts: 4 @ $2 → WAC = 2.
    expect(wac).not.toBeNull();
    expect(wac!.toString()).toBe(new Prisma.Decimal('2').toString());
  });

  it('(g) computeWac returns null when a layer drains via negative_allocation consume (flag ON, over-consume)', async () => {
    await setSetting(
      db,
      SETTING_KEYS.NEGATIVE_INVENTORY_ALLOWED,
      { allowed: true },
      negativeInventoryAllowedValueSchema,
    );
    await seedReceiptWithLayer({ qty: '3', unitCost: '7', receivedAt: new Date('2026-04-01') });

    // Consume 10 from a 3-unit layer with neg-inv ON: layer drains to
    // qtyRemaining=0 (FIFO partial draw), movement.negativeAllocation=true.
    await consumeInventory(db, {
      variantId,
      warehouseId: warehouseAId,
      qty: '10',
      reference: 'WAC-NEGALLOC',
    });

    const wac = await computeWac(db, variantId, warehouseAId);
    // Layer is now qtyRemaining=0, so the filter excludes it → null.
    // The negative-allocation movement is irrelevant to this result; what
    // we're asserting is that WAC reflects ACTUAL layer state.
    expect(wac).toBeNull();
  });

  // ==========================================================================
  // getLastPurchaseCost
  // ==========================================================================

  it('(h) getLastPurchaseCost returns most recent receipt unit cost', async () => {
    await seedReceiptWithLayer({ qty: '5', unitCost: '3.25', receivedAt: new Date('2026-03-01') });
    await seedReceiptWithLayer({ qty: '5', unitCost: '4.75', receivedAt: new Date('2026-03-15') });
    await seedReceiptWithLayer({ qty: '5', unitCost: '6.10', receivedAt: new Date('2026-03-30') });

    const cost = await getLastPurchaseCost(db, variantId, warehouseAId);
    expect(cost).not.toBeNull();
    // Column precision (Decimal(18, 5)) — 5dp comparison is correct.
    expect(cost!.toFixed(5)).toBe(new Prisma.Decimal('6.10').toFixed(5));
  });

  it('(i) getLastPurchaseCost returns null when no receipts exist for the bin', async () => {
    const cost = await getLastPurchaseCost(db, variantId, warehouseAId);
    expect(cost).toBeNull();
  });

  it('(j) getLastPurchaseCost ignores cancelled receipts', async () => {
    // Older POSTED receipt at $2.
    await seedReceiptWithLayer({ qty: '5', unitCost: '2', receivedAt: new Date('2026-03-01') });
    // Newer CANCELLED receipt at $9 — must NOT be returned.
    await seedReceiptWithLayer({
      qty: '5', unitCost: '9', receivedAt: new Date('2026-03-30'),
      status: ReceiptStatus.CANCELLED,
    });

    const cost = await getLastPurchaseCost(db, variantId, warehouseAId);
    expect(cost).not.toBeNull();
    expect(cost!.toFixed(5)).toBe(new Prisma.Decimal('2').toFixed(5));
  });

  it('(k) getLastPurchaseCost respects warehouse scoping (WH-A receipt does not affect WH-B)', async () => {
    await seedReceiptWithLayer({
      qty: '5', unitCost: '4', receivedAt: new Date('2026-03-01'),
      warehouseId: warehouseAId,
    });

    const costA = await getLastPurchaseCost(db, variantId, warehouseAId);
    expect(costA).not.toBeNull();
    expect(costA!.toFixed(5)).toBe(new Prisma.Decimal('4').toFixed(5));

    // No receipt seeded for warehouse B — must be null.
    const costB = await getLastPurchaseCost(db, variantId, warehouseBId);
    expect(costB).toBeNull();
  });
});
