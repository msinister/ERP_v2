import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AuditAction,
  Prisma,
  InventoryMovementType,
} from '@/generated/tenant';
import type { PrismaClient } from '@/generated/tenant';
import { createAdjustment } from '@/server/services/movements';
import {
  createDraftReceipt,
  postReceipt,
} from '@/server/services/receipts';
import { hasTenantDb, makeClient } from '../helpers/db';
import { upsertTestWarehouse } from '../helpers/warehouseStub';
import { wipeBillArtifactsForVendors } from '../helpers/wipeBillArtifacts';

const suite = hasTenantDb ? describe : describe.skip;

const TAG = 'TEST-ADJUST-GL';

suite('createAdjustmentTx GL counterpart leg (Module 08)', () => {
  let db: PrismaClient;
  let vendorId: string;
  let warehouseId: string;
  let warehouseCode: string;
  let productId: string;
  let variantId: string;
  let variantSku: string;

  beforeAll(async () => {
    db = makeClient();

    // Vendor exists only so the pre-stock helper can route through a
    // real Receipt → postReceipt path. Tests that don't pre-stock
    // (cold-start cases) ignore it.
    const v = await db.vendor.upsert({
      where: { code: `${TAG}-VEND` },
      create: { code: `${TAG}-VEND`, name: 'Adjust GL Test Vendor' },
      update: { active: true, deletedAt: null },
    });
    vendorId = v.id;

    const wh = await upsertTestWarehouse(db, {
      code: `${TAG}-WH`,
      name: 'Adjust GL Warehouse',
    });
    warehouseId = wh.id;
    warehouseCode = wh.code;

    const product = await db.product.upsert({
      where: { sku: `${TAG}-PROD` },
      create: { sku: `${TAG}-PROD`, name: 'Adjust GL Test Product' },
      update: { active: true, deletedAt: null },
    });
    productId = product.id;

    const variant = await db.productVariant.upsert({
      where: { sku: `${TAG}-PROD-V1` },
      create: {
        productId: product.id,
        sku: `${TAG}-PROD-V1`,
        name: 'Adjust GL V1',
      },
      update: { productId: product.id, active: true, deletedAt: null },
    });
    variantId = variant.id;
    variantSku = variant.sku;
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
  // Scoped cleanup — clears both Receipt-side and InventoryMovement-side
  // JEs (pre-stock helpers create the former; createAdjustmentTx creates
  // the latter), plus all the usual movement/layer/item state.
  // --------------------------------------------------------------------------
  async function wipe(): Promise<void> {
    const variantIds = [variantId];
    const warehouseIds = [warehouseId];

    // Phase 8: clear bills auto-drafted by postReceipt before any
    // variant/vendor cleanup hits BillLine RESTRICT FKs.
    await wipeBillArtifactsForVendors(db, [vendorId]);

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

    // Wipe both Receipt-side and InventoryMovement-side JEs in one query.
    const jeFilter: Prisma.JournalEntryWhereInput[] = [];
    if (receiptIds.length > 0) {
      jeFilter.push({ entityType: 'Receipt', entityId: { in: receiptIds } });
    }
    if (movementIds.length > 0) {
      jeFilter.push({
        entityType: 'InventoryMovement',
        entityId: { in: movementIds },
      });
    }
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
        await db.auditLog.deleteMany({
          where: { entityType: 'JournalEntry', entityId: { in: jeIds } },
        });
        await db.journalEntry.deleteMany({ where: { id: { in: jeIds } } });
      }
    }

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
      await db.receiptLine.updateMany({
        where: { inventoryMovementId: { in: movementIds } },
        data: { inventoryMovementId: null },
      });
    }
    await db.receiptLine.deleteMany({
      where: { variantId: { in: variantIds } },
    });
    if (receiptIds.length > 0) {
      await db.auditLog.deleteMany({
        where: { entityType: 'Receipt', entityId: { in: receiptIds } },
      });
    }
    await db.receipt.deleteMany({ where: { vendorId } });
    if (movementIds.length > 0) {
      await db.inventoryMovement.deleteMany({
        where: { id: { in: movementIds } },
      });
    }
    await db.inventoryItem.deleteMany({
      where: {
        variantId: { in: variantIds },
        warehouseId: { in: warehouseIds },
      },
    });
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  async function preStock(qty: string, unitCost: string): Promise<void> {
    const draft = await createDraftReceipt(db, {
      vendorId,
      warehouseId,
      lines: [
        { variantId, warehouseId, qtyReceived: qty, unitCost },
      ],
    });
    await postReceipt(db, draft.id);
  }

  async function getJEForMovement(movementId: string) {
    return db.journalEntry.findFirst({
      where: { entityType: 'InventoryMovement', entityId: movementId },
      include: { lines: { include: { account: true } } },
    });
  }

  // ==========================================================================
  // Tests
  // ==========================================================================

  it('1. loss direction — qty=-3 unitCost=10 → DR 5200 30 / CR 1310 30; reason flows to audit', async () => {
    await preStock('10', '10'); // onHand starts at 10

    const movement = await createAdjustment(db, {
      variantId,
      warehouseId,
      qty: '-3',
      unitCost: '10',
      reason: 'Breakage during forklift incident',
    });

    expect(movement.type).toBe(InventoryMovementType.ADJUST);
    expect(movement.qty.toString()).toBe(new Prisma.Decimal('-3').toString());
    expect(movement.unitCost!.toString()).toBe(
      new Prisma.Decimal('10').toString(),
    );

    // onHand reflects the loss (10 - 3 = 7).
    const item = await db.inventoryItem.findUnique({
      where: { variantId_warehouseId: { variantId, warehouseId } },
    });
    expect(item!.onHand.toString()).toBe(new Prisma.Decimal('7').toString());

    // GL leg.
    const je = await getJEForMovement(movement.id);
    expect(je).not.toBeNull();
    expect(je!.description).toBe(
      `Inventory adjustment for variant ${variantSku} at ${warehouseCode} qty -3`,
    );
    expect(je!.entityType).toBe('InventoryMovement');
    expect(je!.entityId).toBe(movement.id);
    expect(je!.lines).toHaveLength(2);

    const dr = je!.lines.find((l) => l.account.code === '5200')!;
    const cr = je!.lines.find((l) => l.account.code === '1310')!;
    expect(dr.debit.toString()).toBe(new Prisma.Decimal('30').toString());
    expect(dr.credit.toString()).toBe(new Prisma.Decimal('0').toString());
    expect(cr.credit.toString()).toBe(new Prisma.Decimal('30').toString());
    expect(cr.debit.toString()).toBe(new Prisma.Decimal('0').toString());

    // Audit log captured the reason via the input.reason → ctx.reason
    // routing locked in checkpoint C.
    const audit = await db.auditLog.findFirst({
      where: {
        entityType: 'InventoryMovement',
        entityId: movement.id,
        action: AuditAction.CREATE,
      },
    });
    expect(audit!.reason).toBe('Breakage during forklift incident');
  });

  it('2. found direction — qty=+5 unitCost=8 → DR 1310 40 / CR 5200 40; bare-digit qty in description', async () => {
    const movement = await createAdjustment(db, {
      variantId,
      warehouseId,
      qty: '5',
      unitCost: '8',
      reason: 'Cycle count revealed extra units',
    });

    expect(movement.qty.toString()).toBe(new Prisma.Decimal('5').toString());
    expect(movement.unitCost!.toString()).toBe(
      new Prisma.Decimal('8').toString(),
    );

    const item = await db.inventoryItem.findUnique({
      where: { variantId_warehouseId: { variantId, warehouseId } },
    });
    expect(item!.onHand.toString()).toBe(new Prisma.Decimal('5').toString());

    const je = await getJEForMovement(movement.id);
    expect(je).not.toBeNull();
    // Description format per Q3 lock: bare digits for positive (no `+`).
    expect(je!.description).toBe(
      `Inventory adjustment for variant ${variantSku} at ${warehouseCode} qty 5`,
    );
    expect(je!.lines).toHaveLength(2);

    const dr = je!.lines.find((l) => l.account.code === '1310')!;
    const cr = je!.lines.find((l) => l.account.code === '5200')!;
    expect(dr.debit.toString()).toBe(new Prisma.Decimal('40').toString());
    expect(cr.credit.toString()).toBe(new Prisma.Decimal('40').toString());
  });

  it('3. unitCost required — Zod parse rejects input with no unitCost; no movement created', async () => {
    await expect(
      createAdjustment(db, {
        variantId,
        warehouseId,
        qty: '-1',
        // unitCost omitted
        reason: 'test',
      } as never),
    ).rejects.toThrow();

    const movements = await db.inventoryMovement.count({
      where: { variantId, type: InventoryMovementType.ADJUST },
    });
    expect(movements).toBe(0);
  });

  it('4. reason required — Zod parse rejects input with no reason; no movement created', async () => {
    await expect(
      createAdjustment(db, {
        variantId,
        warehouseId,
        qty: '-1',
        unitCost: '10',
        // reason omitted
      } as never),
    ).rejects.toThrow();

    const movements = await db.inventoryMovement.count({
      where: { variantId, type: InventoryMovementType.ADJUST },
    });
    expect(movements).toBe(0);
  });

  it('5. JE balanced at full Decimal precision — qty=-7 unitCost=11.37 → 79.59', async () => {
    await preStock('10', '11.37');

    const movement = await createAdjustment(db, {
      variantId,
      warehouseId,
      qty: '-7',
      unitCost: '11.37',
      reason: 'precision check',
    });

    const je = await getJEForMovement(movement.id);
    const dr = je!.lines.find((l) => l.account.code === '5200')!;
    const cr = je!.lines.find((l) => l.account.code === '1310')!;
    // 7 × 11.37 = 79.59 exactly at 2-decimal-place precision; would
    // drift in JS number arithmetic (79.58999999999999) but Decimal
    // holds the value cleanly.
    expect(dr.debit.toString()).toBe(new Prisma.Decimal('79.59').toString());
    expect(cr.credit.toString()).toBe(new Prisma.Decimal('79.59').toString());
    // Σdebits = Σcredits across the JE — the post()-level invariant.
    const sumDebits = je!.lines.reduce(
      (s, l) => s.plus(l.debit),
      new Prisma.Decimal(0),
    );
    const sumCredits = je!.lines.reduce(
      (s, l) => s.plus(l.credit),
      new Prisma.Decimal(0),
    );
    expect(sumDebits.toString()).toBe(sumCredits.toString());
  });

  it('6. double-call produces two independent JEs — same input, distinct movement ids, no idempotency collision', async () => {
    // Each call creates a fresh InventoryMovement (new cuid → new
    // entityId), so post()'s (entityType, entityId, description) tuple
    // sees a unique combination on every call. Different from
    // postReceipt's idempotency model (which is upstream-status-checked
    // on the Receipt row). The test verifies that the post() guard does
    // NOT false-positive when two calls share a description but have
    // different entityIds — the entityId disambiguates and both posts
    // succeed.
    const m1 = await createAdjustment(db, {
      variantId,
      warehouseId,
      qty: '-2',
      unitCost: '5',
      reason: 'first call',
    });
    const m2 = await createAdjustment(db, {
      variantId,
      warehouseId,
      qty: '-2',
      unitCost: '5',
      reason: 'second call',
    });

    expect(m1.id).not.toBe(m2.id);

    const je1 = await getJEForMovement(m1.id);
    const je2 = await getJEForMovement(m2.id);
    expect(je1).not.toBeNull();
    expect(je2).not.toBeNull();
    expect(je1!.id).not.toBe(je2!.id);
    // Both descriptions are identical (same SKU, same warehouse, same qty).
    expect(je1!.description).toBe(je2!.description);
  });

  it('7. loss when onHand=0 — service allows; GL leg posts; onHand goes negative', async () => {
    // No pre-stock — InventoryItem row doesn't exist yet.
    const movement = await createAdjustment(db, {
      variantId,
      warehouseId,
      qty: '-3',
      unitCost: '5',
      reason: 'mystery loss against zero stock',
    });

    // onHand goes negative — createAdjustmentTx does not check onHand
    // (the consume path does, the adjust path does not, by current
    // design). This test locks the contract: the GL leg slice does
    // NOT change adjustment semantics. If the FIFO-aware adjustment
    // follow-on slice changes this, it will (correctly) fail this test.
    const item = await db.inventoryItem.findUnique({
      where: { variantId_warehouseId: { variantId, warehouseId } },
    });
    expect(item!.onHand.toString()).toBe(new Prisma.Decimal('-3').toString());

    // GL leg still posts cleanly — DR 5200 15 / CR 1310 15.
    const je = await getJEForMovement(movement.id);
    expect(je).not.toBeNull();
    const dr = je!.lines.find((l) => l.account.code === '5200')!;
    const cr = je!.lines.find((l) => l.account.code === '1310')!;
    expect(dr.debit.toString()).toBe(new Prisma.Decimal('15').toString());
    expect(cr.credit.toString()).toBe(new Prisma.Decimal('15').toString());
  });

  it('8. found when no prior FifoLayer exists — cold-start; GL leg posts; layer count stays zero', async () => {
    const layersBefore = await db.fifoLayer.count({
      where: { variantId, warehouseId },
    });
    expect(layersBefore).toBe(0);

    const movement = await createAdjustment(db, {
      variantId,
      warehouseId,
      qty: '5',
      unitCost: '10',
      reason: 'opening cycle count adjustment',
    });

    // createAdjustmentTx does NOT write FifoLayer rows (per checkpoint
    // C option-(a) decision: GL-leg-only slice; FIFO-aware adjustment
    // is a follow-on slice). Layer count stays at zero.
    const layersAfter = await db.fifoLayer.count({
      where: { variantId, warehouseId },
    });
    expect(layersAfter).toBe(0);

    // GL leg posts cleanly — DR 1310 50 / CR 5200 50.
    const je = await getJEForMovement(movement.id);
    expect(je).not.toBeNull();
    const dr = je!.lines.find((l) => l.account.code === '1310')!;
    const cr = je!.lines.find((l) => l.account.code === '5200')!;
    expect(dr.debit.toString()).toBe(new Prisma.Decimal('50').toString());
    expect(cr.credit.toString()).toBe(new Prisma.Decimal('50').toString());

    // onHand also reflects.
    const item = await db.inventoryItem.findUnique({
      where: { variantId_warehouseId: { variantId, warehouseId } },
    });
    expect(item!.onHand.toString()).toBe(new Prisma.Decimal('5').toString());
  });

  it('9. zero-amount skip — unitCost=0 produces movement + onHand mutation but no JE', async () => {
    const movement = await createAdjustment(db, {
      variantId,
      warehouseId,
      qty: '-3',
      unitCost: '0',
      reason: 'unknown cost basis',
    });

    // Movement created with unitCost=0.
    expect(movement.type).toBe(InventoryMovementType.ADJUST);
    expect(movement.unitCost!.toString()).toBe(
      new Prisma.Decimal('0').toString(),
    );

    // onHand mutates — the slice does NOT change adjustment semantics
    // for inventory state. Loss against zero stock goes negative.
    const item = await db.inventoryItem.findUnique({
      where: { variantId_warehouseId: { variantId, warehouseId } },
    });
    expect(item!.onHand.toString()).toBe(new Prisma.Decimal('-3').toString());

    // No JE — post() was skipped because subtotal = abs(qty) × unitCost = 0.
    // Two-part promise of zero-amount-skip: inventory mutates, GL doesn't.
    const je = await getJEForMovement(movement.id);
    expect(je).toBeNull();
  });
});
