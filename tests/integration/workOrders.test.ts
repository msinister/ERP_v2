import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  AuditAction,
  InventoryMovementType,
  Prisma,
  ProductType,
  WorkOrderStatus,
} from '@/generated/tenant';
import type { PrismaClient } from '@/generated/tenant';
import {
  cancelWorkOrder,
  completeWorkOrder,
  createWorkOrder,
  getWorkOrder,
  startWorkOrder,
} from '@/server/services/workOrders';
import { setProductBom } from '@/server/services/bom';
import { recomputeOnHand } from '@/server/services/movements';
import { setSetting } from '@/server/services/settings';
import {
  SETTING_KEYS,
  negativeInventoryAllowedValueSchema,
} from '@/lib/validation/settings';
import { hasTenantDb, makeClient } from '../helpers/db';
import { upsertTestWarehouse } from '../helpers/warehouseStub';

const suite = hasTenantDb ? describe : describe.skip;

const TAG = 'TEST-WO';
const USER = `${TAG}-USER`;
const ctx = { userId: USER };

suite('Work Orders service', () => {
  let db: PrismaClient;
  let warehouseId: string;
  let parentProductId: string;
  let parentVariantId: string;
  let componentAVariantId: string;
  let componentBVariantId: string;

  beforeAll(async () => {
    db = makeClient();
    const wh = await upsertTestWarehouse(db, {
      code: `${TAG}-WH`,
      name: 'WO Test Warehouse',
    });
    warehouseId = wh.id;

    const parent = await db.product.upsert({
      where: { sku: `${TAG}-PARENT` },
      create: {
        sku: `${TAG}-PARENT`,
        name: 'Assembled parent',
        type: ProductType.ASSEMBLED,
      },
      update: {
        active: true,
        deletedAt: null,
        type: ProductType.ASSEMBLED,
      },
    });
    parentProductId = parent.id;
    const pv = await db.productVariant.upsert({
      where: { sku: `${TAG}-PARENT-V1` },
      create: {
        productId: parent.id,
        sku: `${TAG}-PARENT-V1`,
        name: 'Default',
      },
      update: { productId: parent.id, active: true, deletedAt: null },
    });
    parentVariantId = pv.id;

    const componentA = await db.product.upsert({
      where: { sku: `${TAG}-COMPA` },
      create: { sku: `${TAG}-COMPA`, name: 'Component A' },
      update: { active: true, deletedAt: null },
    });
    const cav = await db.productVariant.upsert({
      where: { sku: `${TAG}-COMPA-V1` },
      create: { productId: componentA.id, sku: `${TAG}-COMPA-V1` },
      update: { productId: componentA.id, active: true, deletedAt: null },
    });
    componentAVariantId = cav.id;

    const componentB = await db.product.upsert({
      where: { sku: `${TAG}-COMPB` },
      create: { sku: `${TAG}-COMPB`, name: 'Component B' },
      update: { active: true, deletedAt: null },
    });
    const cbv = await db.productVariant.upsert({
      where: { sku: `${TAG}-COMPB-V1` },
      create: { productId: componentB.id, sku: `${TAG}-COMPB-V1` },
      update: { productId: componentB.id, active: true, deletedAt: null },
    });
    componentBVariantId = cbv.id;
  });

  beforeEach(async () => {
    await wipe(db);
    // Reset BOM on parent product to a known shape: 2x Component A
    // + 1x Component B + $1 labor per unit.
    await setProductBom(db, parentProductId, {
      laborCost: '1',
      lines: [
        { componentVariantId: componentAVariantId, qtyRequired: '2' },
        { componentVariantId: componentBVariantId, qtyRequired: '1' },
      ],
    });
  });

  afterEach(async () => {
    // Test 'allows build with warning' below flips the global negative-
    // inventory flag ON. Reset to OFF so subsequent suites (and the
    // strict-rejection test if reordered) see the documented default.
    // ctx (USER tag) so the audit row gets cleaned up by `wipe`.
    await setSetting(
      db,
      SETTING_KEYS.NEGATIVE_INVENTORY_ALLOWED,
      { allowed: false },
      negativeInventoryAllowedValueSchema,
      ctx,
    );
  });

  afterAll(async () => {
    await wipe(db);
    await db.bomLine.deleteMany({
      where: {
        OR: [
          { parentProduct: { sku: { startsWith: `${TAG}-` } } },
          { componentVariant: { product: { sku: { startsWith: `${TAG}-` } } } },
        ],
      },
    });
    await db.productVariant.deleteMany({
      where: { product: { sku: { startsWith: `${TAG}-` } } },
    });
    await db.product.deleteMany({
      where: { sku: { startsWith: `${TAG}-` } },
    });
    await db.warehouse.deleteMany({ where: { id: warehouseId } });
    await db.$disconnect();
  });

  // Helper: seed FIFO inventory for a variant at our test warehouse.
  // Creates a synthetic RECEIVE-style layer with the given unit cost.
  async function seedInventory(
    variantId: string,
    qty: string,
    unitCost: string,
    daysAgo: number = 0,
  ) {
    const receivedDate = new Date(Date.now() - daysAgo * 86400000);
    await db.$transaction(async (tx) => {
      // Create a RECEIVE movement first, then a layer pointing at it.
      const movement = await tx.inventoryMovement.create({
        data: {
          variantId,
          warehouseId,
          type: InventoryMovementType.RECEIVE,
          qty: new Prisma.Decimal(qty),
          unitCost: new Prisma.Decimal(unitCost),
          reference: `${TAG}-SEED`,
        },
      });
      await tx.fifoLayer.create({
        data: {
          variantId,
          warehouseId,
          qtyReceived: new Prisma.Decimal(qty),
          qtyConsumed: new Prisma.Decimal(0),
          qtyRemaining: new Prisma.Decimal(qty),
          unitCost: new Prisma.Decimal(unitCost),
          receivedDate,
          sourceMovementId: movement.id,
        },
      });
      await recomputeOnHand(tx, variantId, warehouseId);
    });
  }

  // -------------------------------------------------------------------------
  // createWorkOrder + lifecycle
  // -------------------------------------------------------------------------

  it('createWorkOrder: snapshots BOM + labor, issues WO-YYYY-NNNNN', async () => {
    const wo = await createWorkOrder(
      db,
      {
        productId: parentProductId,
        variantId: parentVariantId,
        warehouseId,
        qtyToBuild: '5',
      },
      ctx,
    );
    expect(wo.number).toMatch(/^WO-\d{4}-\d{5}$/);
    expect(wo.status).toBe(WorkOrderStatus.DRAFT);
    expect(wo.qtyToBuild.toString()).toBe(new Prisma.Decimal('5').toString());
    expect(wo.qtyCompleted.toString()).toBe(new Prisma.Decimal('0').toString());
    expect(wo.laborCost?.toString()).toBe(new Prisma.Decimal('1').toString());
    expect(wo.components).toHaveLength(2);
    expect(wo.components[0].qtyRequiredPerUnit.toString()).toBe(
      new Prisma.Decimal('2').toString(),
    );
  });

  it('createWorkOrder: labor override (null) clears the snapshot', async () => {
    const wo = await createWorkOrder(
      db,
      {
        productId: parentProductId,
        variantId: parentVariantId,
        warehouseId,
        qtyToBuild: '5',
        laborCost: null,
      },
      ctx,
    );
    expect(wo.laborCost).toBeNull();
  });

  it('createWorkOrder: rejects when product has no BOM', async () => {
    const empty = await db.product.create({
      data: {
        sku: `${TAG}-EMPTY`,
        name: 'No BOM',
        type: ProductType.ASSEMBLED,
      },
    });
    const ev = await db.productVariant.create({
      data: { productId: empty.id, sku: `${TAG}-EMPTY-V1` },
    });
    await expect(
      createWorkOrder(
        db,
        {
          productId: empty.id,
          variantId: ev.id,
          warehouseId,
          qtyToBuild: '1',
        },
        ctx,
      ),
    ).rejects.toThrow(/no BOM lines defined/);
  });

  it('createWorkOrder: rejects DROP_SHIP / SERVICE products', async () => {
    const ds = await db.product.create({
      data: { sku: `${TAG}-DROP`, name: 'Drop', type: ProductType.DROP_SHIP },
    });
    const dv = await db.productVariant.create({
      data: { productId: ds.id, sku: `${TAG}-DROP-V1` },
    });
    await expect(
      createWorkOrder(
        db,
        { productId: ds.id, variantId: dv.id, warehouseId, qtyToBuild: '1' },
        ctx,
      ),
    ).rejects.toThrow(/only SIMPLE and ASSEMBLED are buildable/);
  });

  it('createWorkOrder: rejects variant that does not belong to product', async () => {
    await expect(
      createWorkOrder(
        db,
        {
          productId: parentProductId,
          variantId: componentAVariantId, // wrong product!
          warehouseId,
          qtyToBuild: '1',
        },
        ctx,
      ),
    ).rejects.toThrow(/does not belong to Product/);
  });

  it('startWorkOrder: DRAFT → IN_PROGRESS, sets startedAt', async () => {
    const wo = await createWorkOrder(
      db,
      {
        productId: parentProductId,
        variantId: parentVariantId,
        warehouseId,
        qtyToBuild: '5',
      },
      ctx,
    );
    const started = await startWorkOrder(db, wo.id, ctx);
    expect(started.status).toBe(WorkOrderStatus.IN_PROGRESS);
    expect(started.startedAt).not.toBeNull();
  });

  it('startWorkOrder: rejects non-DRAFT', async () => {
    const wo = await createWorkOrder(
      db,
      {
        productId: parentProductId,
        variantId: parentVariantId,
        warehouseId,
        qtyToBuild: '5',
      },
      ctx,
    );
    await startWorkOrder(db, wo.id, ctx);
    await expect(startWorkOrder(db, wo.id, ctx)).rejects.toThrow(
      /only DRAFT can be started/,
    );
  });

  it('cancelWorkOrder: DRAFT → CANCELLED with reason', async () => {
    const wo = await createWorkOrder(
      db,
      {
        productId: parentProductId,
        variantId: parentVariantId,
        warehouseId,
        qtyToBuild: '5',
      },
      ctx,
    );
    const cancelled = await cancelWorkOrder(
      db,
      wo.id,
      { reason: 'changed plans' },
      ctx,
    );
    expect(cancelled.status).toBe(WorkOrderStatus.CANCELLED);
    expect(cancelled.cancelReason).toBe('changed plans');
  });

  it('cancelWorkOrder: rejects on COMPLETED', async () => {
    // Need to drive a full completion first.
    await seedInventory(componentAVariantId, '20', '5');
    await seedInventory(componentBVariantId, '10', '3');
    const wo = await createWorkOrder(
      db,
      {
        productId: parentProductId,
        variantId: parentVariantId,
        warehouseId,
        qtyToBuild: '2',
      },
      ctx,
    );
    await startWorkOrder(db, wo.id, ctx);
    await completeWorkOrder(db, wo.id, { qtyToComplete: '2' }, ctx);
    await expect(
      cancelWorkOrder(db, wo.id, { reason: 'too late' }, ctx),
    ).rejects.toThrow(/only DRAFT or IN_PROGRESS/);
  });

  // -------------------------------------------------------------------------
  // completeWorkOrder — full build cycle + FIFO + JE
  // -------------------------------------------------------------------------

  it('full build cycle: consume FIFO → produce layer → balanced JE', async () => {
    // 4 units of A needed, 2 of B (for build qty=2 with 2x and 1x BOM).
    await seedInventory(componentAVariantId, '10', '5'); // $5/unit
    await seedInventory(componentBVariantId, '10', '3'); // $3/unit

    const wo = await createWorkOrder(
      db,
      {
        productId: parentProductId,
        variantId: parentVariantId,
        warehouseId,
        qtyToBuild: '2',
        laborCost: '4', // $4/unit labor
      },
      ctx,
    );
    await startWorkOrder(db, wo.id, ctx);
    const { workOrder: completed, warnings } = await completeWorkOrder(
      db,
      wo.id,
      { qtyToComplete: '2' },
      ctx,
    );

    expect(warnings).toHaveLength(0);
    expect(completed.status).toBe(WorkOrderStatus.COMPLETED);
    expect(completed.qtyCompleted.toString()).toBe(
      new Prisma.Decimal('2').toString(),
    );
    expect(completed.completions).toHaveLength(1);

    // Cost rollup:
    //   per-unit component cost = 2 * 5 + 1 * 3 = 13
    //   per-unit labor          = 4
    //   per-unit total          = 17
    expect(completed.completions[0].unitCost.toString()).toBe(
      new Prisma.Decimal('17').toString(),
    );
    expect(completed.completions[0].totalLaborCost.toString()).toBe(
      new Prisma.Decimal('8').toString(), // 4 * 2 units
    );

    // FIFO layer for finished good: 2 units @ $17 = $34 remaining.
    const finishedLayer = await db.fifoLayer.findUniqueOrThrow({
      where: { id: completed.completions[0].producedLayerId! },
    });
    expect(finishedLayer.qtyRemaining.toString()).toBe(
      new Prisma.Decimal('2').toString(),
    );
    expect(finishedLayer.unitCost.toString()).toBe(
      new Prisma.Decimal('17').toString(),
    );

    // JE balance check.
    const je = await db.journalEntry.findUniqueOrThrow({
      where: { id: completed.completions[0].journalEntryId! },
      include: { lines: { include: { account: true } } },
    });
    const debits = je.lines.reduce(
      (acc, l) => acc.plus(l.debit),
      new Prisma.Decimal(0),
    );
    const credits = je.lines.reduce(
      (acc, l) => acc.plus(l.credit),
      new Prisma.Decimal(0),
    );
    expect(debits.toString()).toBe(credits.toString());
    expect(debits.toString()).toBe(new Prisma.Decimal('34').toString());

    // Labor leg present + correct amount.
    const laborLine = je.lines.find((l) => l.account.code === '5300');
    expect(laborLine).toBeDefined();
    expect(laborLine!.credit.toString()).toBe(
      new Prisma.Decimal('8').toString(),
    );

    // BUILD_PRODUCE + BUILD_CONSUME movements emitted.
    const movements = await db.inventoryMovement.findMany({
      where: {
        warehouseId,
        type: { in: [
          InventoryMovementType.BUILD_PRODUCE,
          InventoryMovementType.BUILD_CONSUME,
        ] },
      },
      orderBy: { createdAt: 'asc' },
    });
    const produces = movements.filter(
      (m) => m.type === InventoryMovementType.BUILD_PRODUCE,
    );
    const consumes = movements.filter(
      (m) => m.type === InventoryMovementType.BUILD_CONSUME,
    );
    expect(produces).toHaveLength(1);
    expect(consumes).toHaveLength(2);
  });

  it('partial build: 5 of 10 keeps status IN_PROGRESS; second 5 closes', async () => {
    await seedInventory(componentAVariantId, '50', '5');
    await seedInventory(componentBVariantId, '50', '3');

    const wo = await createWorkOrder(
      db,
      {
        productId: parentProductId,
        variantId: parentVariantId,
        warehouseId,
        qtyToBuild: '10',
        laborCost: null,
      },
      ctx,
    );
    await startWorkOrder(db, wo.id, ctx);
    const { workOrder: partial } = await completeWorkOrder(
      db,
      wo.id,
      { qtyToComplete: '5' },
      ctx,
    );
    expect(partial.status).toBe(WorkOrderStatus.IN_PROGRESS);
    expect(partial.qtyCompleted.toString()).toBe(
      new Prisma.Decimal('5').toString(),
    );
    expect(partial.completions).toHaveLength(1);

    const { workOrder: final } = await completeWorkOrder(
      db,
      wo.id,
      { qtyToComplete: '5' },
      ctx,
    );
    expect(final.status).toBe(WorkOrderStatus.COMPLETED);
    expect(final.qtyCompleted.toString()).toBe(
      new Prisma.Decimal('10').toString(),
    );
    expect(final.completions).toHaveLength(2);

    // Two separate FIFO layers produced — one per completion event.
    const layers = await db.fifoLayer.findMany({
      where: { variantId: parentVariantId, warehouseId },
    });
    expect(layers).toHaveLength(2);
  });

  it('partial build: third complete exceeds remaining → rejected', async () => {
    await seedInventory(componentAVariantId, '50', '5');
    await seedInventory(componentBVariantId, '50', '3');
    const wo = await createWorkOrder(
      db,
      {
        productId: parentProductId,
        variantId: parentVariantId,
        warehouseId,
        qtyToBuild: '5',
      },
      ctx,
    );
    await startWorkOrder(db, wo.id, ctx);
    await completeWorkOrder(db, wo.id, { qtyToComplete: '3' }, ctx);
    await expect(
      completeWorkOrder(db, wo.id, { qtyToComplete: '3' }, ctx),
    ).rejects.toThrow(/exceeds remaining/);
  });

  it('component shortage with negative inventory OFF: complete rejects', async () => {
    // Default setting state — afterEach resets to OFF.
    // Need 4 of A for build qty=2 (2x BOM); seed only 2.
    await seedInventory(componentAVariantId, '2', '5');
    await seedInventory(componentBVariantId, '10', '3');
    const wo = await createWorkOrder(
      db,
      {
        productId: parentProductId,
        variantId: parentVariantId,
        warehouseId,
        qtyToBuild: '2',
      },
      ctx,
    );
    await startWorkOrder(db, wo.id, ctx);
    await expect(
      completeWorkOrder(db, wo.id, { qtyToComplete: '2' }, ctx),
    ).rejects.toThrow(/Insufficient inventory for component/);
    // qtyCompleted should still be 0 (transaction rolled back).
    const after = await getWorkOrder(db, wo.id);
    expect(after!.qtyCompleted.toString()).toBe(
      new Prisma.Decimal('0').toString(),
    );
  });

  it('component shortage with negative inventory ON: build proceeds with warning', async () => {
    // Flip the global flag ON. afterEach resets to OFF.
    await setSetting(
      db,
      SETTING_KEYS.NEGATIVE_INVENTORY_ALLOWED,
      { allowed: true },
      negativeInventoryAllowedValueSchema,
      ctx,
    );

    // Build qty=2 needs 4 of A (2x BOM) + 2 of B. Seed 2 of A
    // (covers 2; 2 of A goes negative) + full 2 of B.
    await seedInventory(componentAVariantId, '2', '5');
    await seedInventory(componentBVariantId, '10', '3');
    const wo = await createWorkOrder(
      db,
      {
        productId: parentProductId,
        variantId: parentVariantId,
        warehouseId,
        qtyToBuild: '2',
        laborCost: null,
      },
      ctx,
    );
    await startWorkOrder(db, wo.id, ctx);
    const result = await completeWorkOrder(
      db,
      wo.id,
      { qtyToComplete: '2' },
      ctx,
    );

    // Build completed, warning surfaced for the short component.
    expect(result.workOrder.status).toBe(WorkOrderStatus.COMPLETED);
    expect(result.workOrder.qtyCompleted.toString()).toBe(
      new Prisma.Decimal('2').toString(),
    );
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].componentVariantId).toBe(componentAVariantId);
    expect(result.warnings[0].needed).toBe(
      new Prisma.Decimal('4').toString(),
    );
    expect(result.warnings[0].allocated).toBe(
      new Prisma.Decimal('2').toString(),
    );
    expect(result.warnings[0].shortage).toBe(
      new Prisma.Decimal('2').toString(),
    );

    // BUILD_CONSUME for A is flagged negativeAllocation=true; B is not.
    const consumes = await db.inventoryMovement.findMany({
      where: {
        warehouseId,
        type: InventoryMovementType.BUILD_CONSUME,
        reference: result.workOrder.number,
      },
    });
    expect(consumes).toHaveLength(2);
    const negA = consumes.find((m) => m.variantId === componentAVariantId);
    const negB = consumes.find((m) => m.variantId === componentBVariantId);
    expect(negA!.negativeAllocation).toBe(true);
    expect(negB!.negativeAllocation).toBe(false);

    // Cost rollup uses ONLY actually-consumed value. Component A
    // contributed $5 * 2 = $10 (not $5 * 4 = $20 — the negative
    // portion has no GL cost basis). Component B contributed
    // $3 * 2 = $6. Total = $16; per-unit = $8.
    expect(result.workOrder.completions[0].unitCost.toString()).toBe(
      new Prisma.Decimal('8').toString(),
    );

    // Finished good FIFO layer reflects the realized cost only.
    const finishedLayer = await db.fifoLayer.findUniqueOrThrow({
      where: { id: result.workOrder.completions[0].producedLayerId! },
    });
    expect(finishedLayer.unitCost.toString()).toBe(
      new Prisma.Decimal('8').toString(),
    );

    // JE balances on realized cost ($16 each side, all on the same
    // warehouse inventory account; no labor leg since laborCost=null).
    const je = await db.journalEntry.findUniqueOrThrow({
      where: { id: result.workOrder.completions[0].journalEntryId! },
      include: { lines: true },
    });
    const debits = je.lines.reduce(
      (acc, l) => acc.plus(l.debit),
      new Prisma.Decimal(0),
    );
    const credits = je.lines.reduce(
      (acc, l) => acc.plus(l.credit),
      new Prisma.Decimal(0),
    );
    expect(debits.toString()).toBe(new Prisma.Decimal('16').toString());
    expect(credits.toString()).toBe(new Prisma.Decimal('16').toString());

    // InventoryItem.onHand for the short component is negative.
    const aOnHand = await db.inventoryItem.findUniqueOrThrow({
      where: {
        variantId_warehouseId: {
          variantId: componentAVariantId,
          warehouseId,
        },
      },
    });
    expect(aOnHand.onHand.toString()).toBe(
      new Prisma.Decimal('-2').toString(),
    );
  });

  it('cancel after partial: completed units remain in inventory', async () => {
    await seedInventory(componentAVariantId, '20', '5');
    await seedInventory(componentBVariantId, '20', '3');
    const wo = await createWorkOrder(
      db,
      {
        productId: parentProductId,
        variantId: parentVariantId,
        warehouseId,
        qtyToBuild: '10',
        laborCost: null,
      },
      ctx,
    );
    await startWorkOrder(db, wo.id, ctx);
    await completeWorkOrder(db, wo.id, { qtyToComplete: '3' }, ctx);
    const cancelled = await cancelWorkOrder(
      db,
      wo.id,
      { reason: 'no more orders' },
      ctx,
    );
    expect(cancelled.status).toBe(WorkOrderStatus.CANCELLED);
    expect(cancelled.qtyCompleted.toString()).toBe(
      new Prisma.Decimal('3').toString(),
    );
    // Finished good FIFO layer for the partial production still exists
    // and is not consumed by the cancel.
    const layers = await db.fifoLayer.findMany({
      where: { variantId: parentVariantId, warehouseId },
    });
    expect(layers).toHaveLength(1);
    expect(layers[0].qtyRemaining.toString()).toBe(
      new Prisma.Decimal('3').toString(),
    );
  });

  it('cost rollup: mixed-cost FIFO layers produce correct weighted average', async () => {
    // Two layers of A at different costs; consumption should pull
    // from oldest first.
    await seedInventory(componentAVariantId, '4', '10', /* daysAgo */ 5); // older, $10
    await seedInventory(componentAVariantId, '4', '20', /* daysAgo */ 0); // newer, $20
    await seedInventory(componentBVariantId, '10', '5');

    const wo = await createWorkOrder(
      db,
      {
        productId: parentProductId,
        variantId: parentVariantId,
        warehouseId,
        qtyToBuild: '3', // needs 6 of A (drains old + 2 from new) + 3 of B
        laborCost: null,
      },
      ctx,
    );
    await startWorkOrder(db, wo.id, ctx);
    const { workOrder: completed } = await completeWorkOrder(
      db,
      wo.id,
      { qtyToComplete: '3' },
      ctx,
    );

    // Component A cost: 4 @ $10 + 2 @ $20 = $80; unit-wac = $80 / 6 = $13.333...
    // Total cost per 3 finished units:
    //   A: 6 * (80/6) = $80
    //   B: 3 * $5 = $15
    //   Total = $95
    //   Per unit = $95 / 3 ≈ $31.66667 (Decimal(18,5) — DB rounds the
    //     full-precision quotient to 5 decimal places on store).
    const expectedTotal = new Prisma.Decimal('95');
    expect(completed.completions[0].unitCost.toString()).toBe(
      new Prisma.Decimal('31.66667').toString(),
    );

    // Verify JE balances at $95 (DR side stores the un-rounded total).
    const je = await db.journalEntry.findUniqueOrThrow({
      where: { id: completed.completions[0].journalEntryId! },
      include: { lines: true },
    });
    const debits = je.lines.reduce(
      (acc, l) => acc.plus(l.debit),
      new Prisma.Decimal(0),
    );
    expect(debits.toString()).toBe(expectedTotal.toString());
  });

  it('no-labor build: JE has no Direct Labor leg', async () => {
    await seedInventory(componentAVariantId, '10', '5');
    await seedInventory(componentBVariantId, '10', '3');
    const wo = await createWorkOrder(
      db,
      {
        productId: parentProductId,
        variantId: parentVariantId,
        warehouseId,
        qtyToBuild: '1',
        laborCost: null,
      },
      ctx,
    );
    await startWorkOrder(db, wo.id, ctx);
    const { workOrder: completed } = await completeWorkOrder(
      db,
      wo.id,
      { qtyToComplete: '1' },
      ctx,
    );
    const je = await db.journalEntry.findUniqueOrThrow({
      where: { id: completed.completions[0].journalEntryId! },
      include: { lines: { include: { account: true } } },
    });
    const labor = je.lines.find((l) => l.account.code === '5300');
    expect(labor).toBeUndefined();
  });

  it('writes a STATUS_CHANGE audit row on completion', async () => {
    await seedInventory(componentAVariantId, '10', '5');
    await seedInventory(componentBVariantId, '10', '3');
    const wo = await createWorkOrder(
      db,
      {
        productId: parentProductId,
        variantId: parentVariantId,
        warehouseId,
        qtyToBuild: '1',
      },
      ctx,
    );
    await startWorkOrder(db, wo.id, ctx);
    await completeWorkOrder(db, wo.id, { qtyToComplete: '1' }, ctx);
    const rows = await db.auditLog.findMany({
      where: {
        entityType: 'WorkOrder',
        entityId: wo.id,
        action: AuditAction.STATUS_CHANGE,
        userId: USER,
      },
    });
    // STATUS_CHANGE: start (DRAFT → IN_PROGRESS) + complete (→ COMPLETED).
    expect(rows.length).toBe(2);
  });
});

async function wipe(db: PrismaClient): Promise<void> {
  await db.auditLog.deleteMany({ where: { userId: USER } });

  const productIds = (
    await db.product.findMany({
      where: { sku: { startsWith: `${TAG}-` } },
      select: { id: true },
    })
  ).map((p) => p.id);
  const variantIds = (
    await db.productVariant.findMany({
      where: { product: { sku: { startsWith: `${TAG}-` } } },
      select: { id: true },
    })
  ).map((v) => v.id);

  if (productIds.length === 0 && variantIds.length === 0) return;

  // Cleanup order respects FK chains:
  //   WorkOrderCompletion → WorkOrder
  //   WorkOrderComponent → WorkOrder + ProductVariant
  //   WorkOrder → Product + ProductVariant
  //   FifoConsumption → FifoLayer + InventoryMovement
  //   FifoLayer → InventoryMovement
  //   InventoryMovement → ProductVariant
  //   JournalEntryLine → JournalEntry
  //   InventoryItem → ProductVariant
  //   BomLine → Product + ProductVariant

  await db.workOrderCompletion.deleteMany({
    where: { workOrder: { productId: { in: productIds } } },
  });
  await db.workOrderComponent.deleteMany({
    where: { workOrder: { productId: { in: productIds } } },
  });
  await db.workOrder.deleteMany({
    where: { productId: { in: productIds } },
  });

  if (variantIds.length > 0) {
    await db.fifoConsumption.deleteMany({
      where: { layer: { variantId: { in: variantIds } } },
    });
    await db.fifoLayer.deleteMany({
      where: { variantId: { in: variantIds } },
    });
  }
  const movementIds = (
    await db.inventoryMovement.findMany({
      where: { variantId: { in: variantIds } },
      select: { id: true },
    })
  ).map((m) => m.id);
  // JEs created by this test fixture point to BUILD_PRODUCE movement
  // ids as entityId — clean those up so the audit log doesn't grow.
  if (movementIds.length > 0) {
    const jes = await db.journalEntry.findMany({
      where: { entityId: { in: movementIds }, entityType: 'WorkOrderCompletion' },
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
  if (variantIds.length > 0) {
    await db.inventoryMovement.deleteMany({
      where: { variantId: { in: variantIds } },
    });
    await db.inventoryItem.deleteMany({
      where: { variantId: { in: variantIds } },
    });
  }
  await db.bomLine.deleteMany({
    where: { parentProductId: { in: productIds } },
  });
}
