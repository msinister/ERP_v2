import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AllocationMethod,
  InventoryMovementType,
  Prisma,
} from '@/generated/tenant';
import type { PrismaClient } from '@/generated/tenant';
import {
  closeSalesOrder,
  confirmSalesOrder,
  createSalesOrder,
} from '@/server/services/salesOrders';
import {
  createDraftReceipt,
  postReceipt,
} from '@/server/services/receipts';
import { postCogsForInvoiceTx } from '@/server/services/cogsPosting';
import {
  applyLandedCostToReceipts,
  reverseLandedCostAllocation,
} from '@/server/services/landedCost';
import { hasTenantDb, makeClient } from '../helpers/db';
import { upsertTestCustomer } from '../helpers/customerStub';
import { upsertTestWarehouse } from '../helpers/warehouseStub';

const suite = hasTenantDb ? describe : describe.skip;
const TAG = 'TEST-LANDEDCOST';

suite('Late landed cost retroactive adjustment (Part 4)', () => {
  let db: PrismaClient;
  let customerId: string;
  let vendorId: string;
  let warehouseId: string;
  let productId: string;
  let variantAId: string;
  let variantBId: string;

  beforeAll(async () => {
    db = makeClient();
    const c = await upsertTestCustomer(db, {
      code: `${TAG}-CUST`,
      name: 'Landed Cost Test Customer',
    });
    customerId = c.id;
    const v = await db.vendor.upsert({
      where: { code: `${TAG}-VEND` },
      create: { code: `${TAG}-VEND`, name: 'Landed Cost Test Vendor' },
      update: { active: true, deletedAt: null },
    });
    vendorId = v.id;
    const wh = await upsertTestWarehouse(db, {
      code: `${TAG}-WH`,
      name: 'Landed Cost Test Warehouse',
    });
    warehouseId = wh.id;

    const product = await db.product.upsert({
      where: { sku: `${TAG}-PROD` },
      create: {
        sku: `${TAG}-PROD`,
        name: 'Landed Cost Test Product',
        basePrice: new Prisma.Decimal('20'),
      },
      update: { active: true, deletedAt: null, basePrice: new Prisma.Decimal('20') },
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
    await db.customer.deleteMany({ where: { id: customerId } });
    await db.$disconnect();
  });

  // ==========================================================================
  // Cleanup — Phase-1B-style scoped walk through the FK graph children-first.
  // Adds Part 4 entities:
  //   - LandedCostAllocationLine (FK → LandedCostAllocation, FifoLayer,
  //     JournalEntry)
  //   - LandedCostAllocationReceipt (FK → LandedCostAllocation, Receipt)
  //   - LandedCostAllocation (parent)
  //   - JournalEntries with description starting with 'Late landed cost
  //     adjustment' or 'Reverse late landed cost adjustment' (the Part 4
  //     forward + reverse JEs land on entityType='Invoice' with that
  //     description prefix)
  // ==========================================================================
  async function wipe(): Promise<void> {
    const variantIds = [variantAId, variantBId];

    const sos = await db.salesOrder.findMany({
      where: { customerId },
      select: { id: true },
    });
    const soIds = sos.map((s) => s.id);

    const invoices = await db.invoice.findMany({
      where: { OR: [{ salesOrderId: { in: soIds } }, { customerId }] },
      select: { id: true },
    });
    const invoiceIds = invoices.map((i) => i.id);

    const receipts = await db.receipt.findMany({
      where: { vendorId },
      select: { id: true },
    });
    const receiptIds = receipts.map((r) => r.id);

    // ------ Part 4 entities first (allocation children → allocation parent → join) ------
    const allocations = await db.landedCostAllocation.findMany({
      where: {
        receipts: { some: { receiptId: { in: receiptIds } } },
      },
      select: { id: true },
    });
    const allocationIds = allocations.map((a) => a.id);
    if (allocationIds.length > 0) {
      await db.landedCostAllocationLine.deleteMany({
        where: { allocationId: { in: allocationIds } },
      });
      await db.landedCostAllocationReceipt.deleteMany({
        where: { allocationId: { in: allocationIds } },
      });
      await db.auditLog.deleteMany({
        where: { entityType: 'LandedCostAllocation', entityId: { in: allocationIds } },
      });
      await db.landedCostAllocation.deleteMany({
        where: { id: { in: allocationIds } },
      });
    }

    // ------ JEs from Part 4 (forward + reverse) on entityType='Invoice' ------
    if (invoiceIds.length > 0) {
      const part4Jes = await db.journalEntry.findMany({
        where: {
          entityType: 'Invoice',
          entityId: { in: invoiceIds },
          OR: [
            { description: { startsWith: 'Late landed cost adjustment' } },
            { description: { startsWith: 'Reverse late landed cost adjustment' } },
          ],
        },
        select: { id: true },
      });
      const part4JeIds = part4Jes.map((j) => j.id);
      if (part4JeIds.length > 0) {
        await db.journalEntryLine.deleteMany({
          where: { journalEntryId: { in: part4JeIds } },
        });
        await db.journalEntry.deleteMany({ where: { id: { in: part4JeIds } } });
      }
    }

    // ------ Standard wipe path (mirror cogsReversal.test.ts) ------
    if (invoiceIds.length > 0) {
      const invJes = await db.journalEntry.findMany({
        where: { entityType: 'Invoice', entityId: { in: invoiceIds } },
        select: { id: true },
      });
      const invJeIds = invJes.map((j) => j.id);
      if (invJeIds.length > 0) {
        await db.journalEntryLine.deleteMany({
          where: { journalEntryId: { in: invJeIds } },
        });
        await db.journalEntry.deleteMany({ where: { id: { in: invJeIds } } });
      }
      await db.auditLog.deleteMany({
        where: { entityType: 'Invoice', entityId: { in: invoiceIds } },
      });
      await db.creditApplication.deleteMany({
        where: { invoiceId: { in: invoiceIds } },
      });
      await db.invoiceLine.deleteMany({
        where: { invoiceId: { in: invoiceIds } },
      });
      await db.invoice.deleteMany({ where: { id: { in: invoiceIds } } });
    }
    await db.customerActivity.deleteMany({ where: { customerId } });
    if (soIds.length > 0) {
      await db.salesOrderLine.updateMany({
        where: { salesOrderId: { in: soIds } },
        data: { inventoryMovementId: null },
      });
      await db.salesOrderLine.deleteMany({
        where: { salesOrderId: { in: soIds } },
      });
      await db.auditLog.deleteMany({
        where: { entityType: 'SalesOrder', entityId: { in: soIds } },
      });
      await db.salesOrder.deleteMany({ where: { id: { in: soIds } } });
    }

    const layers = await db.fifoLayer.findMany({
      where: { variantId: { in: variantIds } },
      select: { id: true },
    });
    const layerIds = layers.map((l) => l.id);
    const movements = await db.inventoryMovement.findMany({
      where: { variantId: { in: variantIds } },
      select: { id: true },
    });
    const movementIds = movements.map((m) => m.id);

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
  // ==========================================================================
  async function seedReceipt(
    lines: Array<{ variant?: string; qty: string; unitCost: string }>,
  ): Promise<string> {
    const draft = await createDraftReceipt(db, {
      vendorId,
      warehouseId,
      lines: lines.map((l) => ({
        variantId: l.variant ?? variantAId,
        warehouseId,
        qtyReceived: l.qty,
        unitCost: l.unitCost,
      })),
    });
    await postReceipt(db, draft.id);
    return draft.id;
  }

  async function getLayersForReceipt(receiptId: string) {
    const rls = await db.receiptLine.findMany({
      where: { receiptId },
      include: { fifoLayer: true },
      orderBy: { createdAt: 'asc' },
    });
    return rls
      .map((rl) => rl.fifoLayer)
      .filter((l): l is NonNullable<typeof l> => l !== null);
  }

  async function closeSOSingleLine(
    qty: string,
    opts?: { variant?: string },
  ): Promise<{ soId: string; invoiceId: string }> {
    const v = opts?.variant ?? variantAId;
    const so = await createSalesOrder(db, {
      customerId,
      warehouseId,
      lines: [{ variantId: v, warehouseId, qtyOrdered: qty }],
    });
    await confirmSalesOrder(db, so.id);
    await closeSalesOrder(db, so.id, undefined);
    const invoice = await db.invoice.findUniqueOrThrow({
      where: { salesOrderId: so.id },
    });
    return { soId: so.id, invoiceId: invoice.id };
  }

  async function getPart4JEsForInvoice(invoiceId: string, kind: 'forward' | 'reverse') {
    const prefix =
      kind === 'forward'
        ? 'Late landed cost adjustment'
        : 'Reverse late landed cost adjustment';
    return db.journalEntry.findMany({
      where: {
        entityType: 'Invoice',
        entityId: invoiceId,
        description: { startsWith: prefix },
      },
      include: { lines: { include: { account: true } } },
      orderBy: { createdAt: 'asc' },
    });
  }

  // ==========================================================================
  // UNIT_COUNT path (1-5)
  // ==========================================================================

  it('(1) UNIT_COUNT: single receipt single layer, $100 freight → 100% delta to layer', async () => {
    const receiptId = await seedReceipt([{ qty: '50', unitCost: '4' }]);
    const result = await applyLandedCostToReceipts(db, {
      receiptIds: [receiptId],
      totalLandedCost: '100',
      allocationMethod: AllocationMethod.UNIT_COUNT,
    });

    expect(result.layersUpdated).toHaveLength(1);
    const summary = result.layersUpdated[0];
    expect(summary.deltaUnitCost.toString()).toBe(new Prisma.Decimal('2').toString()); // 100 / 50
    expect(summary.deltaTotal.toString()).toBe(new Prisma.Decimal('100').toString());
    expect(summary.originalUnitCost.toString()).toBe(new Prisma.Decimal('4').toString());
    expect(summary.newUnitCost.toString()).toBe(new Prisma.Decimal('6').toString());
    expect(summary.cogsAdjustmentJeId).toBeNull(); // no consumptions

    const [layer] = await getLayersForReceipt(receiptId);
    expect(layer.unitCost.toString()).toBe(new Prisma.Decimal('6').toString());
  });

  it('(2) UNIT_COUNT: 2 receipts (60+40 units), $100 → proportional $60/$40 → +1/unit each', async () => {
    const r1 = await seedReceipt([{ qty: '60', unitCost: '5' }]);
    const r2 = await seedReceipt([
      { variant: variantBId, qty: '40', unitCost: '7' },
    ]);

    const result = await applyLandedCostToReceipts(db, {
      receiptIds: [r1, r2],
      totalLandedCost: '100',
      allocationMethod: AllocationMethod.UNIT_COUNT,
    });
    expect(result.layersUpdated).toHaveLength(2);

    const [l1] = await getLayersForReceipt(r1);
    const [l2] = await getLayersForReceipt(r2);
    expect(l1.unitCost.toString()).toBe(new Prisma.Decimal('6').toString()); // 5 + 60/100*100/60 = 5+1
    expect(l2.unitCost.toString()).toBe(new Prisma.Decimal('8').toString()); // 7 + 40/100*100/40 = 7+1
  });

  it('(3) UNIT_COUNT: multi-line receipt (50+50 units), $100 → +$1/unit each layer', async () => {
    const receiptId = await seedReceipt([
      { qty: '50', unitCost: '4' },
      { variant: variantBId, qty: '50', unitCost: '6' },
    ]);
    await applyLandedCostToReceipts(db, {
      receiptIds: [receiptId],
      totalLandedCost: '100',
      allocationMethod: AllocationMethod.UNIT_COUNT,
    });

    const layers = await getLayersForReceipt(receiptId);
    const byVariant = new Map(layers.map((l) => [l.variantId, l]));
    expect(byVariant.get(variantAId)!.unitCost.toString()).toBe(
      new Prisma.Decimal('5').toString(),
    );
    expect(byVariant.get(variantBId)!.unitCost.toString()).toBe(
      new Prisma.Decimal('7').toString(),
    );
  });

  it('(4) UNIT_COUNT with cogsPosted=true: COGS adjustment JE posted backdated to consume movement createdAt', async () => {
    const receiptId = await seedReceipt([{ qty: '10', unitCost: '4' }]);
    const { invoiceId } = await closeSOSingleLine('6');

    // Capture the original CONSUME movement's createdAt for the backdate
    // assertion below.
    const sol = await db.salesOrderLine.findFirstOrThrow({
      where: { salesOrder: { customerId } },
    });
    const movement = await db.inventoryMovement.findUniqueOrThrow({
      where: { id: sol.inventoryMovementId! },
    });
    const expectedPostedAt = movement.createdAt;

    const result = await applyLandedCostToReceipts(db, {
      receiptIds: [receiptId],
      totalLandedCost: '100',
      allocationMethod: AllocationMethod.UNIT_COUNT,
    });

    // 100 / 10 units = $10/unit delta. Layer cost 4 → 14.
    const summary = result.layersUpdated[0];
    expect(summary.deltaUnitCost.toString()).toBe(new Prisma.Decimal('10').toString());
    expect(summary.consumptionsAdjustedViaJe).toBe(1);
    expect(summary.consumptionsMutatedInPlace).toBe(0);
    expect(summary.cogsAdjustmentJeId).not.toBeNull();

    const jes = await getPart4JEsForInvoice(invoiceId, 'forward');
    expect(jes).toHaveLength(1);
    const adjJe = jes[0];

    // 6 units consumed × $10 delta = $60 COGS adjustment, DR COGS / CR Inventory.
    const drLines = adjJe.lines.filter((l) => l.debit.greaterThan(0));
    const crLines = adjJe.lines.filter((l) => l.credit.greaterThan(0));
    expect(drLines).toHaveLength(1);
    expect(crLines).toHaveLength(1);
    expect(drLines[0].account.code).toBe('5100');
    expect(drLines[0].debit.toString()).toBe(new Prisma.Decimal('60').toString());
    expect(crLines[0].credit.toString()).toBe(new Prisma.Decimal('60').toString());

    // postedAt is backdated to original CONSUME movement's createdAt.
    expect(adjJe.postedAt.getTime()).toBe(expectedPostedAt.getTime());
    // createdAt is fresh (post-allocation), NOT backdated.
    expect(adjJe.createdAt.getTime()).toBeGreaterThan(expectedPostedAt.getTime());
  });

  it('(5) UNIT_COUNT layer with NO consumptions: cogsAdjustmentJeId stays null, no JE posted', async () => {
    const receiptId = await seedReceipt([{ qty: '20', unitCost: '5' }]);
    // No SO close — layer has no FifoConsumption rows.

    const result = await applyLandedCostToReceipts(db, {
      receiptIds: [receiptId],
      totalLandedCost: '50',
      allocationMethod: AllocationMethod.UNIT_COUNT,
    });

    expect(result.layersUpdated).toHaveLength(1);
    expect(result.layersUpdated[0].cogsAdjustmentJeId).toBeNull();
    expect(result.cogsAdjustmentJeIds).toHaveLength(0);

    const lines = await db.landedCostAllocationLine.findMany({
      where: { allocationId: result.allocationId },
    });
    expect(lines).toHaveLength(1);
    expect(lines[0].cogsAdjustmentJeId).toBeNull();
  });

  // ==========================================================================
  // VALUE path (6-8)
  // ==========================================================================

  it('(6) VALUE: 1 receipt, 2 layers different unitCosts → allocation proportional to extended cost', async () => {
    // Layer A: 10 units × $10 = $100 extended
    // Layer B: 10 units × $30 = $300 extended
    // Total basis = $400; landed cost $40 splits 100/400 + 300/400 = $10 + $30
    // → deltaUnitCost A = 10/10 = $1; B = 30/10 = $3
    const receiptId = await seedReceipt([
      { qty: '10', unitCost: '10' },
      { variant: variantBId, qty: '10', unitCost: '30' },
    ]);
    await applyLandedCostToReceipts(db, {
      receiptIds: [receiptId],
      totalLandedCost: '40',
      allocationMethod: AllocationMethod.VALUE,
    });

    const layers = await getLayersForReceipt(receiptId);
    const byVariant = new Map(layers.map((l) => [l.variantId, l]));
    expect(byVariant.get(variantAId)!.unitCost.toString()).toBe(
      new Prisma.Decimal('11').toString(),
    );
    expect(byVariant.get(variantBId)!.unitCost.toString()).toBe(
      new Prisma.Decimal('33').toString(),
    );
  });

  it('(7) VALUE: multi-receipt mixed qty/cost → per-extended-cost allocation', async () => {
    // R1 layer: 5 × $20 = $100 ext
    // R2 layer: 10 × $10 = $100 ext (same total ext)
    // Total $200 basis; $50 landed splits $25/$25 → +$5/unit on R1 (25/5),
    // +$2.50/unit on R2 (25/10).
    const r1 = await seedReceipt([{ qty: '5', unitCost: '20' }]);
    const r2 = await seedReceipt([
      { variant: variantBId, qty: '10', unitCost: '10' },
    ]);
    await applyLandedCostToReceipts(db, {
      receiptIds: [r1, r2],
      totalLandedCost: '50',
      allocationMethod: AllocationMethod.VALUE,
    });

    const [l1] = await getLayersForReceipt(r1);
    const [l2] = await getLayersForReceipt(r2);
    expect(l1.unitCost.toFixed(5)).toBe(new Prisma.Decimal('25').toFixed(5)); // 20 + 5
    expect(l2.unitCost.toFixed(5)).toBe(new Prisma.Decimal('12.5').toFixed(5)); // 10 + 2.5
  });

  it('(8) VALUE with one zero-cost layer: zero-basis layer gets zero allocation; others split', async () => {
    // Layer A: 10 × $0 = $0 ext (free goods)
    // Layer B: 10 × $5 = $50 ext
    // Total basis = $50; landed cost $50 → 0% to A, 100% to B.
    const receiptId = await seedReceipt([
      { qty: '10', unitCost: '0' },
      { variant: variantBId, qty: '10', unitCost: '5' },
    ]);
    await applyLandedCostToReceipts(db, {
      receiptIds: [receiptId],
      totalLandedCost: '50',
      allocationMethod: AllocationMethod.VALUE,
    });

    const layers = await getLayersForReceipt(receiptId);
    const byVariant = new Map(layers.map((l) => [l.variantId, l]));
    // A unchanged (zero basis → zero share)
    expect(byVariant.get(variantAId)!.unitCost.toString()).toBe(
      new Prisma.Decimal('0').toString(),
    );
    // B took the full $50 / 10 units = +$5
    expect(byVariant.get(variantBId)!.unitCost.toString()).toBe(
      new Prisma.Decimal('10').toString(),
    );
  });

  // ==========================================================================
  // Reversal path (9-11)
  // ==========================================================================

  it('(9) reverse: layer.unitCost restored to originalUnitCost; reversedAt + reason set', async () => {
    const receiptId = await seedReceipt([{ qty: '50', unitCost: '4' }]);
    const result = await applyLandedCostToReceipts(db, {
      receiptIds: [receiptId],
      totalLandedCost: '100',
      allocationMethod: AllocationMethod.UNIT_COUNT,
    });

    const reverse = await reverseLandedCostAllocation(db, {
      allocationId: result.allocationId,
      reason: 'vendor disputed bill',
    });
    expect(reverse.skipped).toBeNull();
    expect(reverse.layersRestored).toBe(1);

    const [layer] = await getLayersForReceipt(receiptId);
    expect(layer.unitCost.toString()).toBe(new Prisma.Decimal('4').toString());

    const allocation = await db.landedCostAllocation.findUniqueOrThrow({
      where: { id: result.allocationId },
    });
    expect(allocation.reversedAt).not.toBeNull();
    expect(allocation.reversedReason).toBe('vendor disputed bill');
  });

  it('(10) reverse idempotency: re-call returns skipped="already_reversed", no second JE', async () => {
    const receiptId = await seedReceipt([{ qty: '50', unitCost: '4' }]);
    const result = await applyLandedCostToReceipts(db, {
      receiptIds: [receiptId],
      totalLandedCost: '100',
      allocationMethod: AllocationMethod.UNIT_COUNT,
    });
    const first = await reverseLandedCostAllocation(db, {
      allocationId: result.allocationId,
      reason: 'first reverse',
    });
    expect(first.skipped).toBeNull();

    const second = await reverseLandedCostAllocation(db, {
      allocationId: result.allocationId,
      reason: 'should be ignored',
    });
    expect(second.skipped).toBe('already_reversed');
    expect(second.reversalJeIds).toHaveLength(0);
    expect(second.layersRestored).toBe(0);

    // reversedReason is the original, not the second-call's
    const allocation = await db.landedCostAllocation.findUniqueOrThrow({
      where: { id: result.allocationId },
    });
    expect(allocation.reversedReason).toBe('first reverse');
  });

  it('(11) reverse with cogsPosted=true forward JEs: each forward JE has a mirror reversal JE', async () => {
    const receiptId = await seedReceipt([{ qty: '10', unitCost: '4' }]);
    const { invoiceId } = await closeSOSingleLine('6');
    const apply = await applyLandedCostToReceipts(db, {
      receiptIds: [receiptId],
      totalLandedCost: '100',
      allocationMethod: AllocationMethod.UNIT_COUNT,
    });
    expect(apply.cogsAdjustmentJeIds).toHaveLength(1);

    const reverse = await reverseLandedCostAllocation(db, {
      allocationId: apply.allocationId,
      reason: 'corrected bill',
    });
    expect(reverse.reversalJeIds).toHaveLength(1);

    const fwdJes = await getPart4JEsForInvoice(invoiceId, 'forward');
    const revJes = await getPart4JEsForInvoice(invoiceId, 'reverse');
    expect(fwdJes).toHaveLength(1);
    expect(revJes).toHaveLength(1);

    // Mirror sign: forward DR 5100 / CR Inventory; reverse DR Inventory / CR 5100.
    const fwdDr = fwdJes[0].lines.find((l) => l.debit.greaterThan(0))!;
    const fwdCr = fwdJes[0].lines.find((l) => l.credit.greaterThan(0))!;
    const revDr = revJes[0].lines.find((l) => l.debit.greaterThan(0))!;
    const revCr = revJes[0].lines.find((l) => l.credit.greaterThan(0))!;
    expect(fwdDr.account.code).toBe('5100');
    expect(revCr.account.code).toBe('5100');
    expect(fwdCr.account.code).toBe(revDr.account.code); // same Inventory account
    expect(fwdDr.debit.toString()).toBe(revCr.credit.toString()); // same magnitude
    expect(fwdCr.credit.toString()).toBe(revDr.debit.toString());

    // Reverse JE shares postedAt with forward JE (period-correct).
    expect(revJes[0].postedAt.getTime()).toBe(fwdJes[0].postedAt.getTime());

    // Layer cost back to original.
    const [layer] = await getLayersForReceipt(receiptId);
    expect(layer.unitCost.toString()).toBe(new Prisma.Decimal('4').toString());
  });

  // ==========================================================================
  // Validation / error paths (12-14)
  // ==========================================================================

  it('(12) WEIGHT method throws "deferred to future slice" error', async () => {
    const receiptId = await seedReceipt([{ qty: '10', unitCost: '4' }]);
    await expect(
      applyLandedCostToReceipts(db, {
        receiptIds: [receiptId],
        totalLandedCost: '50',
        allocationMethod: AllocationMethod.WEIGHT,
      }),
    ).rejects.toThrow(/WEIGHT and BOX_COUNT.*deferred to a future slice/);
  });

  it('(13) BOX_COUNT method throws "deferred to future slice" error', async () => {
    const receiptId = await seedReceipt([{ qty: '10', unitCost: '4' }]);
    await expect(
      applyLandedCostToReceipts(db, {
        receiptIds: [receiptId],
        totalLandedCost: '50',
        allocationMethod: AllocationMethod.BOX_COUNT,
      }),
    ).rejects.toThrow(/WEIGHT and BOX_COUNT.*deferred to a future slice/);
  });

  it('(14) soft-deleted receipt id in input throws', async () => {
    const receiptId = await seedReceipt([{ qty: '10', unitCost: '4' }]);
    await db.receipt.update({
      where: { id: receiptId },
      data: { deletedAt: new Date() },
    });
    await expect(
      applyLandedCostToReceipts(db, {
        receiptIds: [receiptId],
        totalLandedCost: '50',
        allocationMethod: AllocationMethod.UNIT_COUNT,
      }),
    ).rejects.toThrow(/soft-deleted/);
  });

  // ==========================================================================
  // Skip-condition tests (15-16)
  // ==========================================================================

  it('(15) cogsPosted=false: FifoConsumption.unitCost mutates in place; no JE; subsequent cogsPosting reads new snapshot', async () => {
    // FIXTURE NOTE: The state "FifoConsumption rows exist AND
    // invoice.cogsPosted=false" is unreachable via the current production
    // flow because closeSalesOrder atomically calls consumeInventoryTx and
    // postCogsForInvoiceTx in a single transaction. We construct the
    // scenario by closing the SO normally (which produces FifoConsumption
    // rows + a cogsPosted=true Invoice), then resetting cogsPosted=false
    // and deleting the COGS JE — simulating the "consumed but GL not yet
    // realized" branch. This branch becomes naturally reachable in a
    // future flow where cogsPosting is decoupled (e.g., batched/deferred
    // posting). Until then, this test is the only coverage of that branch.
    const receiptId = await seedReceipt([{ qty: '10', unitCost: '4' }]);
    const { invoiceId } = await closeSOSingleLine('6');

    // Reset to "consumed but not yet cogs-posted".
    const cogsJe = await db.journalEntry.findFirstOrThrow({
      where: {
        entityType: 'Invoice',
        entityId: invoiceId,
        description: { startsWith: 'Post COGS' },
      },
    });
    await db.journalEntryLine.deleteMany({ where: { journalEntryId: cogsJe.id } });
    await db.journalEntry.delete({ where: { id: cogsJe.id } });
    await db.invoice.update({
      where: { id: invoiceId },
      data: { cogsPosted: false },
    });

    // Apply landed cost. Since cogsPosted=false, snapshot mutates in place;
    // no COGS adjustment JE.
    const result = await applyLandedCostToReceipts(db, {
      receiptIds: [receiptId],
      totalLandedCost: '100',
      allocationMethod: AllocationMethod.UNIT_COUNT,
    });
    expect(result.cogsAdjustmentJeIds).toHaveLength(0);
    expect(result.layersUpdated[0].consumptionsMutatedInPlace).toBe(1);
    expect(result.layersUpdated[0].consumptionsAdjustedViaJe).toBe(0);

    // Verify FifoConsumption.unitCost snapshot is now the post-allocation cost.
    // 100 / 10 units = +$10/unit; original layer 4 → 14. Snapshot = 14.
    const sol = await db.salesOrderLine.findFirstOrThrow({
      where: { salesOrder: { customerId } },
    });
    const fcs = await db.fifoConsumption.findMany({
      where: { movementId: sol.inventoryMovementId! },
    });
    expect(fcs).toHaveLength(1);
    expect(fcs[0].unitCost.toString()).toBe(new Prisma.Decimal('14').toString());

    // No Part 4 forward JEs for this invoice.
    const part4Jes = await getPart4JEsForInvoice(invoiceId, 'forward');
    expect(part4Jes).toHaveLength(0);

    // Now run cogsPosting. It reads the updated snapshot and posts COGS at
    // the new value: 6 units × $14 = $84.
    await db.$transaction(async (tx) => {
      await postCogsForInvoiceTx(tx, invoiceId);
    });
    const cogsJe2 = await db.journalEntry.findFirstOrThrow({
      where: {
        entityType: 'Invoice',
        entityId: invoiceId,
        description: { startsWith: 'Post COGS' },
      },
      include: { lines: true },
    });
    const drCogs = cogsJe2.lines.find((l) => l.debit.greaterThan(0))!;
    expect(drCogs.debit.toString()).toBe(new Prisma.Decimal('84').toString());
  });

  it('(16) orphan CONSUME (no SOLine link): orphanConsumes counted; layer.unitCost mutates; no JE', async () => {
    // Stock the bin via receipt → real FifoLayer exists.
    const receiptId = await seedReceipt([{ qty: '20', unitCost: '5' }]);

    // Manually create an orphan CONSUME directly: tx.inventoryMovement of
    // type=CONSUME with NO SalesOrderLine link, plus a FifoConsumption row
    // pointing it at the layer. Mirrors what receiveInventory + a manual
    // adjustment / transfer-out would produce in a non-SO path.
    const [layer] = await getLayersForReceipt(receiptId);
    await db.$transaction(async (tx) => {
      const movement = await tx.inventoryMovement.create({
        data: {
          variantId: variantAId,
          warehouseId,
          type: InventoryMovementType.CONSUME,
          qty: new Prisma.Decimal('-3'),
          unitCost: layer.unitCost,
          reference: `${TAG}-ORPHAN`,
          notes: 'orphan consume for test 16',
        },
      });
      await tx.fifoConsumption.create({
        data: {
          movementId: movement.id,
          layerId: layer.id,
          qty: new Prisma.Decimal('3'),
          unitCost: layer.unitCost,
        },
      });
      await tx.fifoLayer.update({
        where: { id: layer.id },
        data: {
          qtyConsumed: layer.qtyConsumed.plus(3),
          qtyRemaining: layer.qtyRemaining.minus(3),
        },
      });
    });

    const result = await applyLandedCostToReceipts(db, {
      receiptIds: [receiptId],
      totalLandedCost: '40', // 40/20 units = +$2/unit
      allocationMethod: AllocationMethod.UNIT_COUNT,
    });

    // Layer cost mutated.
    const [layerAfter] = await getLayersForReceipt(receiptId);
    expect(layerAfter.unitCost.toString()).toBe(new Prisma.Decimal('7').toString());

    // Per-layer summary: orphan counted, no JE.
    const summary = result.layersUpdated[0];
    expect(summary.orphanConsumes).toBe(1);
    expect(summary.consumptionsAdjustedViaJe).toBe(0);
    expect(summary.consumptionsMutatedInPlace).toBe(0);
    expect(summary.cogsAdjustmentJeId).toBeNull();
    expect(result.cogsAdjustmentJeIds).toHaveLength(0);
  });

  // ==========================================================================
  // Invariant test (17)
  // ==========================================================================

  it('(17) invariant: cogsPosted=true FifoConsumption.unitCost UNCHANGED; only layer.unitCost mutates + JE captures differential', async () => {
    const receiptId = await seedReceipt([{ qty: '10', unitCost: '4' }]);
    const { invoiceId } = await closeSOSingleLine('6');

    // Snapshot the FifoConsumption.unitCost BEFORE allocation.
    const sol = await db.salesOrderLine.findFirstOrThrow({
      where: { salesOrder: { customerId } },
    });
    const fcsBefore = await db.fifoConsumption.findMany({
      where: { movementId: sol.inventoryMovementId! },
      orderBy: { id: 'asc' },
    });
    const beforeCosts = fcsBefore.map((f) => f.unitCost.toString());

    await applyLandedCostToReceipts(db, {
      receiptIds: [receiptId],
      totalLandedCost: '100',
      allocationMethod: AllocationMethod.UNIT_COUNT,
    });

    // Layer mutated.
    const [layer] = await getLayersForReceipt(receiptId);
    expect(layer.unitCost.toString()).toBe(new Prisma.Decimal('14').toString()); // 4 + 10

    // FifoConsumption.unitCost UNCHANGED (history preserved).
    const fcsAfter = await db.fifoConsumption.findMany({
      where: { movementId: sol.inventoryMovementId! },
      orderBy: { id: 'asc' },
    });
    const afterCosts = fcsAfter.map((f) => f.unitCost.toString());
    expect(afterCosts).toEqual(beforeCosts);
    for (const f of fcsAfter) {
      expect(f.unitCost.toString()).toBe(new Prisma.Decimal('4').toString());
    }

    // Differential captured via JE: 6 × $10 = $60 COGS adjustment.
    const part4Jes = await getPart4JEsForInvoice(invoiceId, 'forward');
    expect(part4Jes).toHaveLength(1);
    const dr = part4Jes[0].lines.find((l) => l.debit.greaterThan(0))!;
    expect(dr.debit.toString()).toBe(new Prisma.Decimal('60').toString());
  });
});
