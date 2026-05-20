import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Prisma, AdjustmentStatus } from '@/generated/tenant';
import type { PrismaClient } from '@/generated/tenant';
import {
  postQuickAdjustment,
  voidAdjustment,
} from '@/server/services/inventoryAdjustments';
import {
  createDraftReceipt,
  postReceipt,
} from '@/server/services/receipts';
import { hasTenantDb, makeClient } from '../helpers/db';
import { upsertTestWarehouse } from '../helpers/warehouseStub';
import { wipeBillArtifactsForVendors } from '../helpers/wipeBillArtifacts';

const suite = hasTenantDb ? describe : describe.skip;
const TAG = 'TEST-INV-ADJ';
const D = (v: string) => new Prisma.Decimal(v).toString();

suite('Inventory adjustments — FIFO-correct costing', () => {
  let db: PrismaClient;
  let vendorId: string;
  let warehouseId: string;
  let variantId: string;

  beforeAll(async () => {
    db = makeClient();
    const v = await db.vendor.upsert({
      where: { code: `${TAG}-VEND` },
      create: { code: `${TAG}-VEND`, name: 'Adj Test Vendor' },
      update: { active: true, deletedAt: null },
    });
    vendorId = v.id;
    const wh = await upsertTestWarehouse(db, {
      code: `${TAG}-WH`,
      name: 'Adj Warehouse',
    });
    warehouseId = wh.id;
    const product = await db.product.upsert({
      where: { sku: `${TAG}-PROD` },
      create: { sku: `${TAG}-PROD`, name: 'Adj Test Product' },
      update: { active: true, deletedAt: null },
    });
    const variant = await db.productVariant.upsert({
      where: { sku: `${TAG}-PROD-V1` },
      create: { productId: product.id, sku: `${TAG}-PROD-V1`, name: 'V1' },
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
    await db.product.deleteMany({ where: { sku: `${TAG}-PROD` } });
    await db.warehouse.deleteMany({ where: { id: warehouseId } });
    await db.vendor.deleteMany({ where: { id: vendorId } });
    await db.$disconnect();
  });

  async function wipe(): Promise<void> {
    await wipeBillArtifactsForVendors(db, [vendorId]);

    const adjustments = await db.inventoryAdjustment.findMany({
      where: { warehouseId },
      select: { id: true },
    });
    const adjIds = adjustments.map((a) => a.id);

    const receipts = await db.receipt.findMany({
      where: { vendorId },
      select: { id: true },
    });
    const receiptIds = receipts.map((r) => r.id);

    const movements = await db.inventoryMovement.findMany({
      where: { variantId },
      select: { id: true },
    });
    const movementIds = movements.map((m) => m.id);

    const jeFilter: Prisma.JournalEntryWhereInput[] = [];
    if (receiptIds.length > 0)
      jeFilter.push({ entityType: 'Receipt', entityId: { in: receiptIds } });
    if (movementIds.length > 0)
      jeFilter.push({
        entityType: 'InventoryMovement',
        entityId: { in: movementIds },
      });
    if (adjIds.length > 0)
      jeFilter.push({
        entityType: 'InventoryAdjustment',
        entityId: { in: adjIds },
      });
    if (jeFilter.length > 0) {
      const jes = await db.journalEntry.findMany({
        where: { OR: jeFilter },
        select: { id: true },
      });
      const jeIds = jes.map((j) => j.id);
      if (jeIds.length > 0) {
        await db.journalEntryLine.deleteMany({
          where: { journalEntryId: { in: jeIds } },
        });
        await db.journalEntry.deleteMany({ where: { id: { in: jeIds } } });
      }
    }

    if (adjIds.length > 0) {
      await db.inventoryAdjustmentLine.deleteMany({
        where: { adjustmentId: { in: adjIds } },
      });
      await db.inventoryAdjustment.deleteMany({ where: { id: { in: adjIds } } });
    }

    const layers = await db.fifoLayer.findMany({
      where: { variantId },
      select: { id: true },
    });
    const layerIds = layers.map((l) => l.id);
    if (layerIds.length > 0) {
      await db.fifoConsumption.deleteMany({
        where: { layerId: { in: layerIds } },
      });
      await db.fifoLayer.deleteMany({ where: { id: { in: layerIds } } });
    }
    if (movementIds.length > 0) {
      await db.fifoConsumption.deleteMany({
        where: { movementId: { in: movementIds } },
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
    await db.inventoryItem.deleteMany({ where: { variantId, warehouseId } });
  }

  async function preStock(qty: string, unitCost: string): Promise<void> {
    const draft = await createDraftReceipt(db, {
      vendorId,
      warehouseId,
      lines: [{ variantId, warehouseId, qtyReceived: qty, unitCost }],
    });
    await postReceipt(db, draft.id);
  }

  async function onHand(): Promise<string> {
    const item = await db.inventoryItem.findUnique({
      where: { variantId_warehouseId: { variantId, warehouseId } },
    });
    return (item?.onHand ?? new Prisma.Decimal(0)).toString();
  }

  function jeFor(adjustmentId: string) {
    return db.journalEntry.findMany({
      where: { entityType: 'InventoryAdjustment', entityId: adjustmentId },
      include: { lines: { include: { account: true } } },
      orderBy: { createdAt: 'asc' },
    });
  }

  // ==========================================================================

  it('loss consumes FIFO oldest-first + posts DR 5200 / CR inventory', async () => {
    await preStock('10', '10'); // layer 10 @ $10

    const adj = await postQuickAdjustment(db, {
      variantId,
      warehouseId,
      qtyChange: '-3',
      category: 'BREAKAGE',
      reason: 'forklift incident',
    });

    expect(adj.status).toBe(AdjustmentStatus.POSTED);
    expect(adj.lines).toHaveLength(1);
    expect(adj.lines[0].qtyChange.toString()).toBe(D('-3'));
    expect(adj.lines[0].unitCost.toString()).toBe(D('10'));
    expect(await onHand()).toBe(D('7'));

    // Layer drawn down 10 → 7 remaining.
    const layer = await db.fifoLayer.findFirst({ where: { variantId } });
    expect(layer!.qtyRemaining.toString()).toBe(D('7'));

    const jes = await jeFor(adj.id);
    expect(jes).toHaveLength(1);
    const dr = jes[0].lines.find((l) => l.account.code === '5200')!;
    const cr = jes[0].lines.find((l) => l.account.code === '1310')!;
    expect(dr.debit.toString()).toBe(D('30'));
    expect(cr.credit.toString()).toBe(D('30'));
  });

  it('gain creates a new FIFO layer at WAC + posts DR inventory / CR 5200', async () => {
    await preStock('10', '10'); // WAC = 10

    const adj = await postQuickAdjustment(db, {
      variantId,
      warehouseId,
      qtyChange: '5',
      category: 'FOUND_STOCK',
      reason: 'cycle count surplus',
    });

    expect(adj.lines[0].unitCost.toString()).toBe(D('10'));
    expect(await onHand()).toBe(D('15'));

    const layers = await db.fifoLayer.findMany({
      where: { variantId },
      orderBy: { receivedDate: 'asc' },
    });
    expect(layers).toHaveLength(2); // original + the gain layer
    const gainLayer = layers[layers.length - 1];
    expect(gainLayer.qtyRemaining.toString()).toBe(D('5'));
    expect(gainLayer.unitCost.toString()).toBe(D('10'));

    const jes = await jeFor(adj.id);
    const dr = jes[0].lines.find((l) => l.account.code === '1310')!;
    const cr = jes[0].lines.find((l) => l.account.code === '5200')!;
    expect(dr.debit.toString()).toBe(D('50'));
    expect(cr.credit.toString()).toBe(D('50'));
  });

  it('void of a loss re-adds stock at the consumed cost + reversing JE', async () => {
    await preStock('10', '10');
    const adj = await postQuickAdjustment(db, {
      variantId,
      warehouseId,
      qtyChange: '-3',
      category: 'MISSING',
      reason: 'miscount',
    });
    expect(await onHand()).toBe(D('7'));

    const voided = await voidAdjustment(db, adj.id, { reason: 'found it' });
    expect(voided.status).toBe(AdjustmentStatus.VOIDED);
    expect(await onHand()).toBe(D('10')); // restored

    // A compensating gain layer of 3 @ $10 now exists.
    const gainLayer = await db.fifoLayer.findFirst({
      where: { variantId, qtyRemaining: { equals: new Prisma.Decimal(3) } },
    });
    expect(gainLayer).not.toBeNull();
    expect(gainLayer!.unitCost.toString()).toBe(D('10'));

    // Two JEs under the adjustment: original loss + reversing gain.
    const jes = await jeFor(adj.id);
    expect(jes).toHaveLength(2);
    const reversal = jes[1];
    const dr = reversal.lines.find((l) => l.account.code === '1310')!;
    const cr = reversal.lines.find((l) => l.account.code === '5200')!;
    expect(dr.debit.toString()).toBe(D('30'));
    expect(cr.credit.toString()).toBe(D('30'));
  });

  it('void of a gain consumes the qty back out (FIFO)', async () => {
    await preStock('10', '10');
    const adj = await postQuickAdjustment(db, {
      variantId,
      warehouseId,
      qtyChange: '5',
      category: 'FOUND_STOCK',
      reason: 'surplus',
    });
    expect(await onHand()).toBe(D('15'));

    const voided = await voidAdjustment(db, adj.id, { reason: 'recount' });
    expect(voided.status).toBe(AdjustmentStatus.VOIDED);
    expect(await onHand()).toBe(D('10'));

    // Reversing JE is a loss leg.
    const jes = await jeFor(adj.id);
    expect(jes).toHaveLength(2);
    const reversal = jes[1];
    const dr = reversal.lines.find((l) => l.account.code === '5200')!;
    const cr = reversal.lines.find((l) => l.account.code === '1310')!;
    expect(dr.debit.toString()).toBe(D('50'));
    expect(cr.credit.toString()).toBe(D('50'));
  });

  it('loss beyond available stock throws (negative inventory off)', async () => {
    // This case asserts the negative-inventory-OFF behavior, so force the
    // tenant setting off for the duration and restore it after (the shared
    // dev DB may have it on from another suite).
    const KEY = 'negative_inventory_allowed';
    const prior = await db.setting.findUnique({ where: { key: KEY } });
    await db.setting.upsert({
      where: { key: KEY },
      create: { key: KEY, value: { allowed: false } },
      update: { value: { allowed: false } },
    });
    try {
      await preStock('2', '10');
      await expect(
        postQuickAdjustment(db, {
          variantId,
          warehouseId,
          qtyChange: '-5',
          category: 'THEFT',
          reason: 'over-shrink',
        }),
      ).rejects.toThrow();
      // Rolled back — onHand unchanged, no adjustment row persisted.
      expect(await onHand()).toBe(D('2'));
      const count = await db.inventoryAdjustment.count({
        where: { warehouseId },
      });
      expect(count).toBe(0);
    } finally {
      if (prior) {
        await db.setting.update({
          where: { key: KEY },
          data: { value: prior.value as Prisma.InputJsonValue },
        });
      } else {
        await db.setting.delete({ where: { key: KEY } }).catch(() => {});
      }
    }
  });

  it('cannot void a non-POSTED adjustment twice', async () => {
    await preStock('10', '10');
    const adj = await postQuickAdjustment(db, {
      variantId,
      warehouseId,
      qtyChange: '-1',
      category: 'OTHER',
      reason: 'x',
    });
    await voidAdjustment(db, adj.id, { reason: 'first' });
    await expect(
      voidAdjustment(db, adj.id, { reason: 'second' }),
    ).rejects.toThrow();
  });
});
