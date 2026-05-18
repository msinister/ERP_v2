import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  Prisma,
  ReceiptStatus,
  InventoryMovementType,
} from '@/generated/tenant';
import type { PrismaClient } from '@/generated/tenant';
import {
  cancelReceipt,
  createDraftReceipt,
  postReceipt,
} from '@/server/services/receipts';
import { cancelBill } from '@/server/services/bills';
import { hasTenantDb, makeClient } from '../helpers/db';

// postReceipt auto-confirms the draft bill (auto-confirm feature,
// 2026-05-17). cancelReceipt refuses while any CONFIRMED bill is
// linked — tests that exercise cancel must clear the bill first.
async function cancelLinkedBills(
  db: PrismaClient,
  receiptId: string,
): Promise<void> {
  const links = await db.billReceipt.findMany({
    where: { receiptId, bill: { status: { not: 'CANCELLED' }, deletedAt: null } },
    select: { billId: true },
  });
  for (const { billId } of links) {
    await cancelBill(db, billId, 'test setup: clear bill so cancelReceipt can run');
  }
}
import { upsertTestWarehouse } from '../helpers/warehouseStub';
import { wipeBillArtifactsForVendors } from '../helpers/wipeBillArtifacts';

const suite = hasTenantDb ? describe : describe.skip;

const TAG = 'TEST-RECEIPT-GL';

suite('postReceipt + cancelReceipt GL counterpart leg (Modules 07 + 08)', () => {
  let db: PrismaClient;
  let vendorId: string;
  let warehouseLinkedId: string;
  let warehouseUnlinkedId: string;
  let productId: string;
  let variantId: string;

  beforeAll(async () => {
    db = makeClient();

    const v = await db.vendor.upsert({
      where: { code: `${TAG}-VEND` },
      create: { code: `${TAG}-VEND`, name: 'Receipt GL Test Vendor' },
      update: { active: true, deletedAt: null },
    });
    vendorId = v.id;

    // Linked warehouse: 1310 Inventory account connected via the shared
    // upsertTestWarehouse helper (mirrors cogsPosting.test.ts).
    const linked = await upsertTestWarehouse(db, {
      code: `${TAG}-WH-LINKED`,
      name: 'Receipt GL WH Linked',
    });
    warehouseLinkedId = linked.id;

    // Unlinked warehouse: inventoryAccountId explicitly null. Used only
    // by test #5 (warehouse-link fail-fast). Inline upsert because the
    // shared helper hardcodes the 1310 connect.
    const unlinked = await db.warehouse.upsert({
      where: { code: `${TAG}-WH-UNLINKED` },
      create: {
        code: `${TAG}-WH-UNLINKED`,
        name: 'Receipt GL WH Unlinked',
      },
      update: {
        active: true,
        deletedAt: null,
        inventoryAccountId: null,
      },
    });
    warehouseUnlinkedId = unlinked.id;

    const product = await db.product.upsert({
      where: { sku: `${TAG}-PROD` },
      create: { sku: `${TAG}-PROD`, name: 'Receipt GL Test Product' },
      update: { active: true, deletedAt: null },
    });
    productId = product.id;

    const variant = await db.productVariant.upsert({
      where: { sku: `${TAG}-PROD-V1` },
      create: {
        productId: product.id,
        sku: `${TAG}-PROD-V1`,
        name: 'Receipt GL V1',
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
    await db.warehouse.deleteMany({
      where: { id: { in: [warehouseLinkedId, warehouseUnlinkedId] } },
    });
    await db.vendor.deleteMany({ where: { id: vendorId } });
    await db.$disconnect();
  });

  // --------------------------------------------------------------------------
  // Scoped cleanup — walks JournalEntry/Line/AuditLog/Receipt/ReceiptLine/
  // FifoLayer/FifoConsumption/InventoryMovement/InventoryItem in FK-safe
  // order, all scoped to TAG-owned receipts + variants + warehouses.
  // --------------------------------------------------------------------------
  async function wipe(): Promise<void> {
    const variantIds = [variantId];
    const warehouseIds = [warehouseLinkedId, warehouseUnlinkedId];

    // Phase 8: clear bills auto-drafted by postReceipt before any
    // variant/vendor cleanup hits BillLine RESTRICT FKs.
    await wipeBillArtifactsForVendors(db, [vendorId]);

    // Receipts owned by this suite's vendor — collect ids so we can
    // delete JEs referencing them by entityId.
    const receipts = await db.receipt.findMany({
      where: { vendorId },
      select: { id: true },
    });
    const receiptIds = receipts.map((r) => r.id);

    // Delete JournalEntryLines + JournalEntry rows whose entityType=Receipt
    // points at one of these receipt ids. No FK cascade exists, so we
    // delete manually before the receipts. Both post-time and cancel-time
    // JEs share entityType+entityId — this query catches both.
    if (receiptIds.length > 0) {
      const jes = await db.journalEntry.findMany({
        where: { entityType: 'Receipt', entityId: { in: receiptIds } },
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

    // FifoLayer + FifoConsumption + InventoryMovement for our variants.
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

  type Line = { qtyReceived: string; unitCost: string };

  async function createAndPostReceipt(lines: Line[]) {
    const draft = await createDraftReceipt(db, {
      vendorId,
      warehouseId: warehouseLinkedId,
      lines: lines.map((l) => ({
        variantId,
        warehouseId: warehouseLinkedId,
        qtyReceived: l.qtyReceived,
        unitCost: l.unitCost,
      })),
    });
    return postReceipt(db, draft.id);
  }

  async function getJEsForReceipt(receiptId: string) {
    return db.journalEntry.findMany({
      where: { entityType: 'Receipt', entityId: receiptId },
      include: { lines: { include: { account: true } } },
      orderBy: { createdAt: 'asc' },
    });
  }

  // ==========================================================================
  // Tests
  // ==========================================================================

  it('1. happy path single line — JE balanced 1310/2020, postedAt matches receivedAt', async () => {
    const posted = await createAndPostReceipt([
      { qtyReceived: '10', unitCost: '5' },
    ]);

    const jes = await getJEsForReceipt(posted.id);
    expect(jes).toHaveLength(1);

    const je = jes[0];
    expect(je.description).toBe(`Goods received for receipt ${posted.number}`);
    expect(je.entityType).toBe('Receipt');
    expect(je.entityId).toBe(posted.id);
    expect(je.lines).toHaveLength(2);

    const dr = je.lines.find((l) => l.account.code === '1310')!;
    const cr = je.lines.find((l) => l.account.code === '2020')!;
    // 10 units × $5 = $50.
    expect(dr.debit.toString()).toBe(new Prisma.Decimal('50').toString());
    expect(dr.credit.toString()).toBe(new Prisma.Decimal('0').toString());
    expect(cr.credit.toString()).toBe(new Prisma.Decimal('50').toString());
    expect(cr.debit.toString()).toBe(new Prisma.Decimal('0').toString());

    // postedAt sourced from after.receivedAt inside postReceipt's tx —
    // exact ms match.
    expect(je.postedAt.getTime()).toBe(posted.receivedAt!.getTime());

    // Receipt + inventory state are intact after the GL leg.
    expect(posted.status).toBe(ReceiptStatus.POSTED);
    const item = await db.inventoryItem.findUnique({
      where: {
        variantId_warehouseId: { variantId, warehouseId: warehouseLinkedId },
      },
    });
    expect(item!.onHand.toString()).toBe(new Prisma.Decimal('10').toString());
    const layers = await db.fifoLayer.findMany({
      where: { variantId, warehouseId: warehouseLinkedId, deletedAt: null },
    });
    expect(layers).toHaveLength(1);
    expect(layers[0].unitCost.toString()).toBe(
      new Prisma.Decimal('5').toString(),
    );
  });

  it('2. happy path multi-line same warehouse — single JE rolls up subtotal across 3 lines', async () => {
    const posted = await createAndPostReceipt([
      { qtyReceived: '5', unitCost: '10' }, // 50
      { qtyReceived: '2', unitCost: '20' }, // 40
      { qtyReceived: '1', unitCost: '15' }, // 15
    ]);
    // Subtotal = 50 + 40 + 15 = 105.

    const jes = await getJEsForReceipt(posted.id);
    expect(jes).toHaveLength(1);

    const je = jes[0];
    expect(je.lines).toHaveLength(2);
    const dr = je.lines.find((l) => l.account.code === '1310')!;
    const cr = je.lines.find((l) => l.account.code === '2020')!;
    expect(dr.debit.toString()).toBe(new Prisma.Decimal('105').toString());
    expect(cr.credit.toString()).toBe(new Prisma.Decimal('105').toString());

    // 3 FifoLayers, one per receipt line, with their individual costs.
    const layers = await db.fifoLayer.findMany({
      where: { variantId, warehouseId: warehouseLinkedId, deletedAt: null },
    });
    expect(layers).toHaveLength(3);
    const costs = layers.map((l) => l.unitCost.toString()).sort();
    expect(costs).toEqual(
      ['10', '15', '20']
        .map((c) => new Prisma.Decimal(c).toString())
        .sort(),
    );
  });

  it('3. cancel posts mirror JE — both balanced, cent-perfect offset, post JE not reversed', async () => {
    const posted = await createAndPostReceipt([
      { qtyReceived: '4', unitCost: '7' },
    ]);
    // Subtotal = 28.

    const beforeCancelMs = Date.now();
    await cancelLinkedBills(db, posted.id);
    await cancelReceipt(db, posted.id, { reason: 'Wrong shipment' });
    const afterCancelMs = Date.now();

    const jes = await getJEsForReceipt(posted.id);
    expect(jes).toHaveLength(2);

    const postJe = jes.find((j) => j.description.startsWith('Goods received'))!;
    const cancelJe = jes.find((j) => j.description.startsWith('Cancellation'))!;

    expect(postJe.description).toBe(
      `Goods received for receipt ${posted.number}`,
    );
    expect(cancelJe.description).toBe(
      `Cancellation of receipt ${posted.number}`,
    );

    // Post JE: DR 1310 28 / CR 2020 28.
    const postDr = postJe.lines.find((l) => l.account.code === '1310')!;
    const postCr = postJe.lines.find((l) => l.account.code === '2020')!;
    expect(postDr.debit.toString()).toBe(new Prisma.Decimal('28').toString());
    expect(postCr.credit.toString()).toBe(new Prisma.Decimal('28').toString());

    // Cancel JE: DR 2020 28 / CR 1310 28 — sign-mirror of post.
    const cancelDr = cancelJe.lines.find((l) => l.account.code === '2020')!;
    const cancelCr = cancelJe.lines.find((l) => l.account.code === '1310')!;
    expect(cancelDr.debit.toString()).toBe(new Prisma.Decimal('28').toString());
    expect(cancelCr.credit.toString()).toBe(new Prisma.Decimal('28').toString());

    // Cent-perfect offset: post DR 1310 + cancel CR 1310 are equal in
    // magnitude, opposite in direction → net effect on 1310 is 0. Same
    // for 2020. This is the trial-balance-ties property the slice exists
    // to enforce.
    expect(postDr.debit.minus(cancelCr.credit).toString()).toBe(
      new Prisma.Decimal('0').toString(),
    );
    expect(postCr.credit.minus(cancelDr.debit).toString()).toBe(
      new Prisma.Decimal('0').toString(),
    );

    // Both JEs are independent — cancel is a fresh JE on the same
    // entity, not a post() reversal (which would set reversedAt).
    expect(postJe.reversedAt).toBeNull();
    expect(cancelJe.reversedAt).toBeNull();

    // Cancel JE postedAt is "now-ish" — within the test's cancel window.
    const cancelMs = cancelJe.postedAt.getTime();
    expect(cancelMs).toBeGreaterThanOrEqual(beforeCancelMs);
    expect(cancelMs).toBeLessThanOrEqual(afterCancelMs);
  });

  it('4. idempotency throw on double-post — second postReceipt rejected, exactly one JE remains', async () => {
    const draft = await createDraftReceipt(db, {
      vendorId,
      warehouseId: warehouseLinkedId,
      lines: [
        {
          variantId,
          warehouseId: warehouseLinkedId,
          qtyReceived: '3',
          unitCost: '10',
        },
      ],
    });
    const posted = await postReceipt(db, draft.id);

    // Second postReceipt call — upstream status check throws first
    // (status is now POSTED, not DRAFT). The post() guard on
    // (entityType, entityId, description) is the implicit backstop;
    // verified here by the JE count.
    await expect(postReceipt(db, draft.id)).rejects.toThrow(
      /Cannot post Receipt in status POSTED/,
    );

    const jes = await getJEsForReceipt(posted.id);
    expect(jes).toHaveLength(1);
  });

  it('5. throw when warehouse has no inventoryAccountId — fail-fast, no side effects', async () => {
    const draft = await createDraftReceipt(db, {
      vendorId,
      warehouseId: warehouseUnlinkedId,
      lines: [
        {
          variantId,
          warehouseId: warehouseUnlinkedId,
          qtyReceived: '5',
          unitCost: '8',
        },
      ],
    });

    await expect(postReceipt(db, draft.id)).rejects.toThrow(
      /has no inventoryAccountId/,
    );

    // Receipt still DRAFT — fail-fast happened before the status flip.
    const after = await db.receipt.findUnique({ where: { id: draft.id } });
    expect(after!.status).toBe(ReceiptStatus.DRAFT);

    // No FifoLayer, no JE, no InventoryMovement created against this
    // variant in the unlinked warehouse.
    const layers = await db.fifoLayer.count({
      where: { variantId, warehouseId: warehouseUnlinkedId },
    });
    expect(layers).toBe(0);

    const movements = await db.inventoryMovement.count({
      where: { variantId, warehouseId: warehouseUnlinkedId },
    });
    expect(movements).toBe(0);

    const jes = await getJEsForReceipt(draft.id);
    expect(jes).toHaveLength(0);
  });

  it('6. JE.postedAt equals receipt.receivedAt to-the-millisecond', async () => {
    const posted = await createAndPostReceipt([
      { qtyReceived: '2', unitCost: '11' },
    ]);

    const jes = await getJEsForReceipt(posted.id);
    expect(jes).toHaveLength(1);
    const je = jes[0];

    // Both timestamps trace to the same `new Date()` call inside
    // postReceipt's tx — receivedAt set on the Receipt row, then
    // re-used as postedAt on the post() call. Equality at ms precision
    // is the contract; non-equality would mean they drifted apart and
    // a JE could end up in the wrong period.
    expect(je.postedAt.getTime()).toBe(posted.receivedAt!.getTime());
  });

  it('7. zero-amount skip — receipt with unitCost=0 produces no JE but inventory is still tracked', async () => {
    const posted = await createAndPostReceipt([
      { qtyReceived: '5', unitCost: '0' },
    ]);

    // Receipt is POSTED — status flip happened despite the GL skip.
    expect(posted.status).toBe(ReceiptStatus.POSTED);

    // FifoLayer was still created — inventory accuracy preserved.
    const layers = await db.fifoLayer.findMany({
      where: { variantId, warehouseId: warehouseLinkedId, deletedAt: null },
    });
    expect(layers).toHaveLength(1);
    expect(layers[0].qtyReceived.toString()).toBe(
      new Prisma.Decimal('5').toString(),
    );
    expect(layers[0].unitCost.toString()).toBe(
      new Prisma.Decimal('0').toString(),
    );

    // InventoryMovement created with unitCost = 0 (matches the receipt
    // line value).
    const movement = await db.inventoryMovement.findFirst({
      where: {
        variantId,
        warehouseId: warehouseLinkedId,
        type: InventoryMovementType.RECEIVE,
      },
    });
    expect(movement!.unitCost!.toString()).toBe(
      new Prisma.Decimal('0').toString(),
    );

    // No JE row created — post() was skipped because subtotal = 0.
    const jes = await getJEsForReceipt(posted.id);
    expect(jes).toHaveLength(0);
  });
});
