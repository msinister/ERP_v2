import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { InventoryMovementType, Prisma, ReceiptStatus } from '@/generated/tenant';
import type { PrismaClient } from '@/generated/tenant';
import { backfillFifoLayers } from '@/server/services/backfillFifoLayers';
import { computeWac } from '@/server/services/wac';
import { getNextSequence } from '@/lib/sequences/sequences';
import { hasTenantDb, makeClient } from '../helpers/db';
import { upsertTestWarehouse } from '../helpers/warehouseStub';

const suite = hasTenantDb ? describe : describe.skip;
const TAG = 'TEST-BACKFILL';

suite('FifoLayer backfill (Part 5)', () => {
  let db: PrismaClient;
  let vendorId: string;
  let warehouseId: string;
  let productId: string;
  let variantAId: string;
  let variantBId: string;

  beforeAll(async () => {
    db = makeClient();
    const v = await db.vendor.upsert({
      where: { code: `${TAG}-VEND` },
      create: { code: `${TAG}-VEND`, name: 'Backfill Test Vendor' },
      update: { active: true, deletedAt: null },
    });
    vendorId = v.id;
    const wh = await upsertTestWarehouse(db, {
      code: `${TAG}-WH`,
      name: 'Backfill Test Warehouse',
    });
    warehouseId = wh.id;

    const product = await db.product.upsert({
      where: { sku: `${TAG}-PROD` },
      create: {
        sku: `${TAG}-PROD`,
        name: 'Backfill Test Product',
        basePrice: new Prisma.Decimal('10'),
      },
      update: { active: true, deletedAt: null, basePrice: new Prisma.Decimal('10') },
    });
    productId = product.id;
    const va = await db.productVariant.upsert({
      where: { sku: `${TAG}-PROD-V1` },
      create: { productId: product.id, sku: `${TAG}-PROD-V1`, name: 'V1' },
      update: { productId: product.id, active: true, deletedAt: null },
    });
    variantAId = va.id;
    const vb = await db.productVariant.upsert({
      where: { sku: `${TAG}-PROD-V2` },
      create: { productId: product.id, sku: `${TAG}-PROD-V2`, name: 'V2' },
      update: { productId: product.id, active: true, deletedAt: null },
    });
    variantBId = vb.id;
  });

  beforeEach(async () => {
    await wipe();
  });

  afterAll(async () => {
    await wipe();
    await db.productVariant.deleteMany({
      where: { id: { in: [variantAId, variantBId] } },
    });
    await db.product.deleteMany({ where: { id: productId } });
    await db.warehouse.deleteMany({ where: { id: warehouseId } });
    await db.vendor.deleteMany({ where: { id: vendorId } });
    await db.$disconnect();
  });

  // ==========================================================================
  // Cleanup — Phase-1B-style scoped walk:
  //   FifoConsumption (movement-keyed and layer-keyed) → FifoLayer →
  //   ReceiptLine → Receipt → InventoryMovement → InventoryItem
  //   + AuditLog rows for FifoLayer entityType (the backfill audit signal)
  //   + AuditLog rows for InventoryMovement / Receipt entityType
  // Scoped to TEST-BACKFILL variants + warehouse only — does NOT touch the
  // dev DB's pre-existing SEED orphan or any other test's fixtures.
  // ==========================================================================
  async function wipe(): Promise<void> {
    const variantIds = [variantAId, variantBId];

    const receipts = await db.receipt.findMany({
      where: { vendorId },
      select: { id: true },
    });
    const receiptIds = receipts.map((r) => r.id);

    const movements = await db.inventoryMovement.findMany({
      where: { variantId: { in: variantIds } },
      select: { id: true },
    });
    const movementIds = movements.map((m) => m.id);

    const layers = await db.fifoLayer.findMany({
      where: { variantId: { in: variantIds } },
      select: { id: true },
    });
    const layerIds = layers.map((l) => l.id);

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
      // Null the back-pointer on ReceiptLine so the line can be deleted.
      await db.receiptLine.updateMany({
        where: { inventoryMovementId: { in: movementIds } },
        data: { inventoryMovementId: null },
      });
    }
    await db.receiptLine.deleteMany({ where: { variantId: { in: variantIds } } });
    if (receiptIds.length > 0) {
      await db.auditLog.deleteMany({
        where: { entityType: 'Receipt', entityId: { in: receiptIds } },
      });
      await db.receipt.deleteMany({ where: { id: { in: receiptIds } } });
    }
    if (movementIds.length > 0) {
      await db.inventoryMovement.deleteMany({
        where: { id: { in: movementIds } },
      });
    }
    await db.inventoryItem.deleteMany({
      where: { variantId: { in: variantIds }, warehouseId },
    });
  }

  // ==========================================================================
  // Helpers
  //
  // Each helper builds a specific fixture state directly via tx. We do NOT
  // go through postReceipt for the orphan-creation paths — that would
  // create the FifoLayer automatically and there'd be nothing to backfill.
  // The whole point of these tests is to exercise the backfill on rows
  // that look like they predate the FIFO migration.
  // ==========================================================================

  // Creates an orphan RECEIVE movement (no FifoLayer, no ReceiptLine).
  // Optionally sets unitCost on the movement (case-1 scenario).
  async function makeOrphanMovement(opts: {
    variantId?: string;
    qty: string;
    unitCost?: string | null;
  }): Promise<string> {
    const m = await db.inventoryMovement.create({
      data: {
        variantId: opts.variantId ?? variantAId,
        warehouseId,
        type: InventoryMovementType.RECEIVE,
        qty: new Prisma.Decimal(opts.qty),
        unitCost:
          opts.unitCost === undefined || opts.unitCost === null
            ? null
            : new Prisma.Decimal(opts.unitCost),
        reference: `${TAG}-ORPHAN`,
      },
    });
    return m.id;
  }

  // Creates an orphan RECEIVE movement linked back to a ReceiptLine.
  // Used for case-2 scenarios. Receipt is POSTED. ReceiptLine.unitCost
  // is set so the backfill walk recovers the cost; movement.unitCost is
  // NULL. Returns { movementId, receiptId, receiptLineId }.
  async function makeOrphanWithReceiptLine(opts: {
    variantId?: string;
    qtyOnLine: string;
    unitCostOnLine: string;
    receiptReceivedAt?: Date;
    softDeleteReceipt?: boolean;
    softDeleteReceiptLine?: boolean;
  }): Promise<{ movementId: string; receiptId: string; receiptLineId: string }> {
    const v = opts.variantId ?? variantAId;
    const receivedAt = opts.receiptReceivedAt ?? new Date();
    // Use the same getNextSequence path that production postReceipt uses
    // (name='receipt', prefix='RCPT', useYear=true). Wrap in a tx because
    // getNextSequence requires Prisma.TransactionClient. This eliminates
    // the non-deterministic test-only fallback and gets the same advisory-
    // lock semantics as production for free.
    const receipt = await db.$transaction(async (tx) => {
      const seq = await getNextSequence(tx, {
        name: 'receipt',
        prefix: 'RCPT',
        useYear: true,
      });
      return tx.receipt.create({
        data: {
          number: seq.formatted,
          vendorId,
          warehouseId,
          status: ReceiptStatus.POSTED,
          receivedAt,
        },
      });
    });
    const movement = await db.inventoryMovement.create({
      data: {
        variantId: v,
        warehouseId,
        type: InventoryMovementType.RECEIVE,
        qty: new Prisma.Decimal(opts.qtyOnLine),
        unitCost: null,
        reference: receipt.number,
      },
    });
    const line = await db.receiptLine.create({
      data: {
        receiptId: receipt.id,
        variantId: v,
        warehouseId,
        qtyReceived: new Prisma.Decimal(opts.qtyOnLine),
        unitCost: new Prisma.Decimal(opts.unitCostOnLine),
        inventoryMovementId: movement.id,
      },
    });
    if (opts.softDeleteReceiptLine) {
      await db.receiptLine.update({
        where: { id: line.id },
        data: { deletedAt: new Date() },
      });
    }
    if (opts.softDeleteReceipt) {
      await db.receipt.update({
        where: { id: receipt.id },
        data: { deletedAt: new Date() },
      });
    }
    return { movementId: movement.id, receiptId: receipt.id, receiptLineId: line.id };
  }

  // Returns the FifoLayer that was backfilled for movement m, or null if
  // none exists. Convenience wrapper around findUnique on sourceMovementId.
  async function getLayerForMovement(movementId: string) {
    return db.fifoLayer.findUnique({
      where: { sourceMovementId: movementId },
    });
  }

  // ==========================================================================
  // (1) Idempotency
  // ==========================================================================
  it('(1) idempotency: second call is a no-op (totalBackfilled=0, totalAlreadyHasLayer=1)', async () => {
    const movementId = await makeOrphanMovement({ qty: '10', unitCost: '5' });

    const first = await backfillFifoLayers(db, { movementIds: [movementId] });
    expect(first.totalScanned).toBe(1);
    expect(first.totalBackfilled).toBe(1);
    expect(first.totalSkipped).toBe(0);
    expect(first.totalAlreadyHasLayer).toBe(0);

    const second = await backfillFifoLayers(db, { movementIds: [movementId] });
    expect(second.totalScanned).toBe(0); // scan filter excludes movements with layers
    expect(second.totalBackfilled).toBe(0);
    expect(second.totalSkipped).toBe(0);
    expect(second.totalAlreadyHasLayer).toBe(1);

    // Layer count for this movement remains exactly 1.
    const layerCount = await db.fifoLayer.count({
      where: { sourceMovementId: movementId },
    });
    expect(layerCount).toBe(1);
  });

  // ==========================================================================
  // (2) Correctness — case-2 path: layer fields match ReceiptLine + Receipt
  // ==========================================================================
  it('(2) correctness: layer qty/unitCost/receivedDate/sourceMovementId/sourceReceiptLineId match ReceiptLine source', async () => {
    const explicitReceivedAt = new Date('2026-04-15T10:00:00.000Z');
    const { movementId, receiptLineId } = await makeOrphanWithReceiptLine({
      qtyOnLine: '7',
      unitCostOnLine: '12.50',
      receiptReceivedAt: explicitReceivedAt,
    });

    const result = await backfillFifoLayers(db, { movementIds: [movementId] });
    expect(result.totalBackfilled).toBe(1);
    expect(result.byCase.fromReceiptLine).toBe(1);

    const layer = await getLayerForMovement(movementId);
    expect(layer).not.toBeNull();
    expect(layer!.qtyReceived.toString()).toBe(new Prisma.Decimal('7').toString());
    expect(layer!.qtyConsumed.toString()).toBe(new Prisma.Decimal('0').toString());
    expect(layer!.qtyRemaining.toString()).toBe(new Prisma.Decimal('7').toString());
    expect(layer!.unitCost.toFixed(5)).toBe(new Prisma.Decimal('12.50').toFixed(5));
    expect(layer!.receivedDate.getTime()).toBe(explicitReceivedAt.getTime());
    expect(layer!.sourceMovementId).toBe(movementId);
    expect(layer!.sourceReceiptLineId).toBe(receiptLineId);
  });

  // ==========================================================================
  // (3) WAC sanity — two backfilled layers in the same bin produce correct WAC
  // ==========================================================================
  it('(3) WAC sanity: computeWac after backfill yields correct weighted average across two layers', async () => {
    // Layer 1: 4 units @ $10 = $40 ext
    // Layer 2: 6 units @ $5  = $30 ext
    // WAC     = ($40 + $30) / (4 + 6) = $70 / 10 = $7.00
    const m1 = await makeOrphanMovement({ qty: '4', unitCost: '10' });
    const m2 = await makeOrphanMovement({ qty: '6', unitCost: '5' });

    const result = await backfillFifoLayers(db, { movementIds: [m1, m2] });
    expect(result.totalBackfilled).toBe(2);
    expect(result.byCase.fromMovement).toBe(2);

    const wac = await computeWac(db, variantAId, warehouseId);
    expect(wac).not.toBeNull();
    expect(wac!.toFixed(5)).toBe(new Prisma.Decimal('7').toFixed(5));
  });

  // ==========================================================================
  // (4) Non-disruption — existing layers are untouched by backfill
  // ==========================================================================
  it('(4) non-disruption: pre-existing layers are not touched; only orphan movements get new layers', async () => {
    // Pre-create a movement + its layer manually (simulates a postReceipt
    // result that's already healthy). Then create an orphan and run
    // backfill. Verify the healthy layer's fields are byte-identical
    // before and after, and only the orphan gets a new layer.
    const healthyMovement = await db.inventoryMovement.create({
      data: {
        variantId: variantAId,
        warehouseId,
        type: InventoryMovementType.RECEIVE,
        qty: new Prisma.Decimal('20'),
        unitCost: new Prisma.Decimal('3'),
        reference: `${TAG}-HEALTHY`,
      },
    });
    const healthyLayer = await db.fifoLayer.create({
      data: {
        variantId: variantAId,
        warehouseId,
        qtyReceived: new Prisma.Decimal('20'),
        qtyConsumed: new Prisma.Decimal('0'),
        qtyRemaining: new Prisma.Decimal('20'),
        unitCost: new Prisma.Decimal('3'),
        receivedDate: new Date(),
        sourceMovementId: healthyMovement.id,
      },
    });
    const orphanMovement = await makeOrphanMovement({ qty: '5', unitCost: '8' });

    const result = await backfillFifoLayers(db, {
      movementIds: [healthyMovement.id, orphanMovement],
    });
    // Only the orphan was scanned; healthy was excluded by the scan filter
    // (it has a layer), so it shows up in totalAlreadyHasLayer.
    expect(result.totalScanned).toBe(1);
    expect(result.totalBackfilled).toBe(1);
    expect(result.totalAlreadyHasLayer).toBe(1);
    expect(result.backfilled[0].movementId).toBe(orphanMovement);

    const healthyAfter = await db.fifoLayer.findUniqueOrThrow({
      where: { id: healthyLayer.id },
    });
    expect(healthyAfter.qtyReceived.toString()).toBe(healthyLayer.qtyReceived.toString());
    expect(healthyAfter.unitCost.toString()).toBe(healthyLayer.unitCost.toString());
    expect(healthyAfter.receivedDate.getTime()).toBe(healthyLayer.receivedDate.getTime());
    expect(healthyAfter.updatedAt.getTime()).toBe(healthyLayer.updatedAt.getTime());
  });

  // ==========================================================================
  // (5) Walk case 1 — movement.unitCost not null, no ReceiptLine
  // ==========================================================================
  it('(5) walk case 1: movement.unitCost set, no ReceiptLine link → backfill from movement, sourceReceiptLineId stays null', async () => {
    const movementId = await makeOrphanMovement({ qty: '8', unitCost: '4' });

    const result = await backfillFifoLayers(db, { movementIds: [movementId] });
    expect(result.totalBackfilled).toBe(1);
    expect(result.byCase.fromMovement).toBe(1);
    expect(result.byCase.fromReceiptLine).toBe(0);
    expect(result.byCase.fromOverride).toBe(0);

    const layer = await getLayerForMovement(movementId);
    expect(layer!.sourceMovementId).toBe(movementId);
    expect(layer!.sourceReceiptLineId).toBeNull();
    expect(layer!.unitCost.toString()).toBe(new Prisma.Decimal('4').toString());
    expect(layer!.qtyReceived.toString()).toBe(new Prisma.Decimal('8').toString());

    expect(result.backfilled[0].source).toBe('movement');
  });

  // ==========================================================================
  // (6) Walk case 2 — movement.unitCost null, ReceiptLine link exists
  // ==========================================================================
  it('(6) walk case 2: movement.unitCost NULL, ReceiptLine link exists → backfill from ReceiptLine, BOTH FKs populated', async () => {
    const { movementId, receiptLineId } = await makeOrphanWithReceiptLine({
      qtyOnLine: '15',
      unitCostOnLine: '6',
    });

    const result = await backfillFifoLayers(db, { movementIds: [movementId] });
    expect(result.totalBackfilled).toBe(1);
    expect(result.byCase.fromReceiptLine).toBe(1);
    expect(result.byCase.fromMovement).toBe(0);
    expect(result.byCase.fromOverride).toBe(0);

    const layer = await getLayerForMovement(movementId);
    expect(layer!.sourceMovementId).toBe(movementId);
    expect(layer!.sourceReceiptLineId).toBe(receiptLineId);
    expect(layer!.unitCost.toString()).toBe(new Prisma.Decimal('6').toString());
    expect(layer!.qtyReceived.toString()).toBe(new Prisma.Decimal('15').toString());

    expect(result.backfilled[0].source).toBe('receipt_line');
  });

  // ==========================================================================
  // (7) Walk case 3 — movement.unitCost null, no ReceiptLine, no override
  // ==========================================================================
  it('(7) walk case 3: movement.unitCost NULL, no ReceiptLine, no override → skipped "irrecoverable_no_cost_data"', async () => {
    const movementId = await makeOrphanMovement({ qty: '5', unitCost: null });

    const result = await backfillFifoLayers(db, { movementIds: [movementId] });
    expect(result.totalBackfilled).toBe(0);
    expect(result.totalSkipped).toBe(1);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].movementId).toBe(movementId);
    expect(result.skipped[0].reason).toBe('irrecoverable_no_cost_data');
    expect(result.skipped[0].details).toMatch(/unitCost=NULL.*no ReceiptLine link.*no override supplied/);

    const layer = await getLayerForMovement(movementId);
    expect(layer).toBeNull();
  });

  // ==========================================================================
  // (8) Operator override — case 3 with explicit unitCost
  // ==========================================================================
  it('(8) override: case-3 movement with explicit unitCost → backfilled from override, source="override"', async () => {
    const movementId = await makeOrphanMovement({ qty: '12', unitCost: null });

    const result = await backfillFifoLayers(db, {
      movementIds: [movementId],
      overrides: { [movementId]: '9.75' },
    });
    expect(result.totalBackfilled).toBe(1);
    expect(result.totalSkipped).toBe(0);
    expect(result.byCase.fromOverride).toBe(1);
    expect(result.byCase.fromMovement).toBe(0);
    expect(result.byCase.fromReceiptLine).toBe(0);

    const layer = await getLayerForMovement(movementId);
    expect(layer!.unitCost.toFixed(5)).toBe(new Prisma.Decimal('9.75').toFixed(5));
    expect(layer!.qtyReceived.toString()).toBe(new Prisma.Decimal('12').toString());
    // Override path: movementId set, ReceiptLine FK null (no link existed).
    expect(layer!.sourceMovementId).toBe(movementId);
    expect(layer!.sourceReceiptLineId).toBeNull();

    expect(result.backfilled[0].source).toBe('override');
  });

  // ==========================================================================
  // (9a) Soft-deleted Receipt does NOT cause skip when ReceiptLine is alive
  // ==========================================================================
  it('(9a) soft-deleted parent Receipt does NOT cause skip when ReceiptLine is alive — case-2 path proceeds', async () => {
    const { movementId, receiptLineId } = await makeOrphanWithReceiptLine({
      qtyOnLine: '4',
      unitCostOnLine: '11',
      softDeleteReceipt: true,
    });

    const result = await backfillFifoLayers(db, { movementIds: [movementId] });
    expect(result.totalBackfilled).toBe(1);
    expect(result.totalSkipped).toBe(0);
    expect(result.byCase.fromReceiptLine).toBe(1);

    const layer = await getLayerForMovement(movementId);
    expect(layer!.unitCost.toString()).toBe(new Prisma.Decimal('11').toString());
    expect(layer!.sourceReceiptLineId).toBe(receiptLineId);
  });

  // ==========================================================================
  // (9b) Soft-deleted ReceiptLine: case-2 path NOT taken; without override, falls
  //      to skip with the soft-deleted-ReceiptLine sub-detail
  // ==========================================================================
  it('(9b) soft-deleted ReceiptLine without override → skipped "irrecoverable_no_cost_data" with soft-deleted sub-detail', async () => {
    const { movementId, receiptLineId } = await makeOrphanWithReceiptLine({
      qtyOnLine: '4',
      unitCostOnLine: '11',
      softDeleteReceiptLine: true,
    });

    const result = await backfillFifoLayers(db, { movementIds: [movementId] });
    expect(result.totalBackfilled).toBe(0);
    expect(result.totalSkipped).toBe(1);
    expect(result.skipped[0].reason).toBe('irrecoverable_no_cost_data');
    expect(result.skipped[0].details).toMatch(/soft-deleted/);
    expect(result.skipped[0].details).toContain(receiptLineId);

    const layer = await getLayerForMovement(movementId);
    expect(layer).toBeNull();

    // With an override, the same setup proceeds via the override path.
    const second = await backfillFifoLayers(db, {
      movementIds: [movementId],
      overrides: { [movementId]: '13' },
    });
    expect(second.totalBackfilled).toBe(1);
    expect(second.byCase.fromOverride).toBe(1);
    const layerAfter = await getLayerForMovement(movementId);
    expect(layerAfter!.unitCost.toString()).toBe(new Prisma.Decimal('13').toString());
  });

  // ==========================================================================
  // (10) RMA_RETURN movement skipped (filtered out by scan, never picked up)
  // ==========================================================================
  it('(10) RMA_RETURN movement is filtered out by scan; not picked up as orphan even when explicitly listed', async () => {
    const m = await db.inventoryMovement.create({
      data: {
        variantId: variantAId,
        warehouseId,
        type: InventoryMovementType.RMA_RETURN,
        qty: new Prisma.Decimal('3'),
        unitCost: new Prisma.Decimal('5'),
        reference: `${TAG}-RMA-RETURN`,
      },
    });

    const result = await backfillFifoLayers(db, { movementIds: [m.id] });
    expect(result.totalScanned).toBe(0);
    expect(result.totalBackfilled).toBe(0);
    expect(result.totalSkipped).toBe(0);

    const layer = await getLayerForMovement(m.id);
    expect(layer).toBeNull();
  });

  // ==========================================================================
  // (11) ADJUST movement skipped (filtered out by scan)
  // ==========================================================================
  it('(11) ADJUST movement is filtered out by scan; not picked up as orphan', async () => {
    const m = await db.inventoryMovement.create({
      data: {
        variantId: variantAId,
        warehouseId,
        type: InventoryMovementType.ADJUST,
        qty: new Prisma.Decimal('2'),
        unitCost: null,
        reference: `${TAG}-ADJUST`,
      },
    });

    const result = await backfillFifoLayers(db, { movementIds: [m.id] });
    expect(result.totalScanned).toBe(0);
    expect(result.totalBackfilled).toBe(0);
    expect(result.totalSkipped).toBe(0);

    const layer = await getLayerForMovement(m.id);
    expect(layer).toBeNull();
  });

  // ==========================================================================
  // (12) Negative-qty RECEIVE skipped 'negative_qty'
  // ==========================================================================
  it('(12) negative-qty RECEIVE → skipped "negative_qty"', async () => {
    // Defensive case: should never exist in practice, but if a corrupted
    // row gets in, the backfill must refuse rather than create a bad layer.
    const m = await db.inventoryMovement.create({
      data: {
        variantId: variantAId,
        warehouseId,
        type: InventoryMovementType.RECEIVE,
        qty: new Prisma.Decimal('-5'),
        unitCost: new Prisma.Decimal('3'),
        reference: `${TAG}-NEG`,
      },
    });

    const result = await backfillFifoLayers(db, { movementIds: [m.id] });
    expect(result.totalBackfilled).toBe(0);
    expect(result.totalSkipped).toBe(1);
    expect(result.skipped[0].movementId).toBe(m.id);
    expect(result.skipped[0].reason).toBe('negative_qty');
    expect(result.skipped[0].details).toMatch(/qty=-5/);

    const layer = await getLayerForMovement(m.id);
    expect(layer).toBeNull();
  });

  // ==========================================================================
  // (13) Untracked CONSUME in bin → skipped 'untracked_consume_in_bin'
  // ==========================================================================
  it('(13) bin has CONSUME with no FifoConsumption rows (not negativeAllocation) → skipped "untracked_consume_in_bin"', async () => {
    // Set up the unsafe-bin scenario: one orphan RECEIVE + one CONSUME in
    // the same bin. The CONSUME has zero FifoConsumption rows AND
    // negativeAllocation=false, so it represents a "legacy untracked
    // consume" the operator hasn't reconciled yet. Backfill must refuse.
    const orphanMovementId = await makeOrphanMovement({
      qty: '10',
      unitCost: '5',
    });
    const untrackedConsume = await db.inventoryMovement.create({
      data: {
        variantId: variantAId,
        warehouseId,
        type: InventoryMovementType.CONSUME,
        qty: new Prisma.Decimal('-2'),
        unitCost: null,
        negativeAllocation: false,
        reference: `${TAG}-UNTRACKED-CONSUME`,
      },
    });

    const result = await backfillFifoLayers(db, {
      movementIds: [orphanMovementId],
    });
    expect(result.totalBackfilled).toBe(0);
    expect(result.totalSkipped).toBe(1);
    expect(result.skipped[0].movementId).toBe(orphanMovementId);
    expect(result.skipped[0].reason).toBe('untracked_consume_in_bin');
    expect(result.skipped[0].details).toContain(untrackedConsume.id);

    const layer = await getLayerForMovement(orphanMovementId);
    expect(layer).toBeNull();

    // Sanity: a CONSUME with negativeAllocation=true does NOT trigger this
    // skip — those legitimately have zero FifoConsumption rows by design
    // (per schema.prisma:294-297). Replace the untracked consume with a
    // negative-allocation one and verify backfill proceeds.
    await db.inventoryMovement.update({
      where: { id: untrackedConsume.id },
      data: { negativeAllocation: true },
    });
    const second = await backfillFifoLayers(db, {
      movementIds: [orphanMovementId],
    });
    expect(second.totalBackfilled).toBe(1);
    expect(second.totalSkipped).toBe(0);
  });
});
