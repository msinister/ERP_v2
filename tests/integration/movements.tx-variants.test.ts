import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Prisma } from '@/generated/tenant';
import type { PrismaClient } from '@/generated/tenant';
import {
  createAdjustment,
  createAdjustmentTx,
  consumeInventory,
  consumeInventoryTx,
  receiveInventory,
  receiveInventoryTx,
  transferInventory,
  transferInventoryTx,
} from '@/server/services/movements';
import { hasTenantDb, makeClient } from '../helpers/db';
import { upsertTestWarehouse } from '../helpers/warehouseStub';

const suite = hasTenantDb ? describe : describe.skip;

suite('movements *Tx variants', () => {
  let db: PrismaClient;
  let warehouseAId: string;
  let warehouseBId: string;
  let productId: string;
  let variantId: string;

  beforeAll(async () => {
    db = makeClient();
    // Use upsertTestWarehouse so both warehouses get the 1310 inventory
    // account link. createAdjustmentTx now requires the warehouse-link
    // for its GL leg (Module 08 GL counterpart-leg slice).
    const wa = await upsertTestWarehouse(db, {
      code: 'TEST-WH-TX-A',
      name: 'Tx Test Warehouse A',
    });
    const wb = await upsertTestWarehouse(db, {
      code: 'TEST-WH-TX-B',
      name: 'Tx Test Warehouse B',
    });
    warehouseAId = wa.id;
    warehouseBId = wb.id;

    const product = await db.product.upsert({
      where: { sku: 'TEST-PROD-TX' },
      create: { sku: 'TEST-PROD-TX', name: 'Tx Test Product' },
      update: { active: true, deletedAt: null },
    });
    productId = product.id;

    const variant = await db.productVariant.upsert({
      where: { sku: 'TEST-PROD-TX-V1' },
      create: {
        productId: product.id,
        sku: 'TEST-PROD-TX-V1',
        name: 'Tx Test Variant',
      },
      update: { productId: product.id, active: true, deletedAt: null },
    });
    variantId = variant.id;
  });

  beforeEach(async () => {
    // Delete this test's audit rows by joining via the movements we own.
    const ownedMovementIds = (
      await db.inventoryMovement.findMany({ where: { variantId }, select: { id: true } })
    ).map((m) => m.id);
    if (ownedMovementIds.length > 0) {
      await db.auditLog.deleteMany({
        where: { entityType: 'InventoryMovement', entityId: { in: ownedMovementIds } },
      });
      // Wipe JEs that createAdjustmentTx now produces (Module 08 GL
      // counterpart-leg slice). JEs reference movements via entityId
      // (no FK), so they don't cascade — explicit cleanup required.
      const jes = await db.journalEntry.findMany({
        where: { entityType: 'InventoryMovement', entityId: { in: ownedMovementIds } },
        select: { id: true },
      });
      const jeIds = jes.map((j) => j.id);
      if (jeIds.length > 0) {
        await db.journalEntryLine.deleteMany({ where: { journalEntryId: { in: jeIds } } });
        await db.journalEntry.deleteMany({ where: { id: { in: jeIds } } });
      }
    }
    await db.inventoryMovement.deleteMany({ where: { variantId } });
    await db.inventoryItem.deleteMany({ where: { variantId } });
  });

  afterAll(async () => {
    // Delete this test's audit rows by joining via the movements we own.
    const ownedMovementIds = (
      await db.inventoryMovement.findMany({ where: { variantId }, select: { id: true } })
    ).map((m) => m.id);
    if (ownedMovementIds.length > 0) {
      await db.auditLog.deleteMany({
        where: { entityType: 'InventoryMovement', entityId: { in: ownedMovementIds } },
      });
      // Wipe JEs that createAdjustmentTx now produces (Module 08 GL
      // counterpart-leg slice). JEs reference movements via entityId
      // (no FK), so they don't cascade — explicit cleanup required.
      const jes = await db.journalEntry.findMany({
        where: { entityType: 'InventoryMovement', entityId: { in: ownedMovementIds } },
        select: { id: true },
      });
      const jeIds = jes.map((j) => j.id);
      if (jeIds.length > 0) {
        await db.journalEntryLine.deleteMany({ where: { journalEntryId: { in: jeIds } } });
        await db.journalEntry.deleteMany({ where: { id: { in: jeIds } } });
      }
    }
    await db.inventoryMovement.deleteMany({ where: { variantId } });
    await db.inventoryItem.deleteMany({ where: { variantId } });
    await db.productVariant.deleteMany({ where: { id: variantId } });
    await db.product.deleteMany({ where: { id: productId } });
    await db.warehouse.deleteMany({ where: { id: { in: [warehouseAId, warehouseBId] } } });
    await db.$disconnect();
  });

  it('Tx variants run inside a caller-owned transaction without nesting', async () => {
    const result = await db.$transaction(async (tx) => {
      const recv = await receiveInventoryTx(tx, {
        variantId,
        warehouseId: warehouseAId,
        qty: '20',
        reference: 'TX-RECV',
      });
      const adj = await createAdjustmentTx(tx, {
        variantId,
        warehouseId: warehouseAId,
        qty: '5',
        unitCost: '10',          // NEW — required by adjustmentInputSchema (slice: GL counterpart leg)
        reason: 'found stock',   // NEW — required (was redundantly carried in `notes`)
        reference: 'TX-ADJ',
        notes: 'found stock',
      });
      const cons = await consumeInventoryTx(tx, {
        variantId,
        warehouseId: warehouseAId,
        qty: '7',
        reference: 'TX-CONS',
      });
      const xfer = await transferInventoryTx(tx, {
        variantId,
        fromWarehouseId: warehouseAId,
        toWarehouseId: warehouseBId,
        qty: '3',
        reference: 'TX-XFER',
      });
      return { recv, adj, cons, xfer };
    });

    // 20 + 5 - 7 - 3 = 15 in A; 3 in B
    const a = await db.inventoryItem.findUnique({
      where: { variantId_warehouseId: { variantId, warehouseId: warehouseAId } },
    });
    const b = await db.inventoryItem.findUnique({
      where: { variantId_warehouseId: { variantId, warehouseId: warehouseBId } },
    });
    expect(a!.onHand.toString()).toBe(new Prisma.Decimal(15).toString());
    expect(b!.onHand.toString()).toBe(new Prisma.Decimal(3).toString());

    // Audit rows — one per movement (transfer is two legs = two rows).
    // Scope to movements created in THIS test (by id) so other parallel test
    // files don't pollute the count.
    const movementIds = [
      result.recv.id,
      result.adj.id,
      result.cons.id,
      result.xfer.out.id,
      result.xfer.in.id,
    ];
    const auditCount = await db.auditLog.count({
      where: { entityType: 'InventoryMovement', entityId: { in: movementIds } },
    });
    expect(auditCount).toBe(5);

    expect(result.xfer.out.transferGroupId).toBe(result.xfer.in.transferGroupId);
  });

  it('caller-side rollback rolls back movement + audit row atomically', async () => {
    await receiveInventory(db, {
      variantId,
      warehouseId: warehouseAId,
      qty: '10',
      reference: 'BASE',
    });

    await expect(
      db.$transaction(async (tx) => {
        await receiveInventoryTx(tx, {
          variantId,
          warehouseId: warehouseAId,
          qty: '5',
          reference: 'WILL-ROLLBACK',
        });
        throw new Error('caller bails out');
      }),
    ).rejects.toThrow('caller bails out');

    const item = await db.inventoryItem.findUnique({
      where: { variantId_warehouseId: { variantId, warehouseId: warehouseAId } },
    });
    expect(item!.onHand.toString()).toBe(new Prisma.Decimal(10).toString());

    const movements = await db.inventoryMovement.count({
      where: { variantId, warehouseId: warehouseAId, reference: 'WILL-ROLLBACK' },
    });
    expect(movements).toBe(0);

    // Scope to movements for THIS test's variant — audit rows for the BASE
    // receive should be the only ones tied to its movement.
    const movementIdsForVariant = await db.inventoryMovement.findMany({
      where: { variantId },
      select: { id: true },
    });
    const audits = await db.auditLog.count({
      where: {
        entityType: 'InventoryMovement',
        entityId: { in: movementIdsForVariant.map((m) => m.id) },
      },
    });
    expect(audits).toBe(1);
  });

  it('public wrappers and Tx variants produce equivalent end state', async () => {
    // Path 1: wrappers (each opens its own tx).
    await receiveInventory(db, { variantId, warehouseId: warehouseAId, qty: '10', reference: 'W' });
    await consumeInventory(db, { variantId, warehouseId: warehouseAId, qty: '4', reference: 'W' });

    const viaWrappers = await db.inventoryItem.findUnique({
      where: { variantId_warehouseId: { variantId, warehouseId: warehouseAId } },
    });
    expect(viaWrappers!.onHand.toString()).toBe(new Prisma.Decimal(6).toString());

    // Reset.
    // Delete this test's audit rows by joining via the movements we own.
    const ownedMovementIds = (
      await db.inventoryMovement.findMany({ where: { variantId }, select: { id: true } })
    ).map((m) => m.id);
    if (ownedMovementIds.length > 0) {
      await db.auditLog.deleteMany({
        where: { entityType: 'InventoryMovement', entityId: { in: ownedMovementIds } },
      });
    }
    await db.inventoryMovement.deleteMany({ where: { variantId } });
    await db.inventoryItem.deleteMany({ where: { variantId } });

    // Path 2: Tx variants under a single caller transaction.
    await db.$transaction(async (tx) => {
      await receiveInventoryTx(tx, { variantId, warehouseId: warehouseAId, qty: '10', reference: 'T' });
      await consumeInventoryTx(tx, { variantId, warehouseId: warehouseAId, qty: '4', reference: 'T' });
    });

    const viaTx = await db.inventoryItem.findUnique({
      where: { variantId_warehouseId: { variantId, warehouseId: warehouseAId } },
    });
    expect(viaTx!.onHand.toString()).toBe(new Prisma.Decimal(6).toString());
  });
});
