import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AuditAction,
  BillSource,
  BillStatus,
  Prisma,
  ReceiptStatus,
} from '@/generated/tenant';
import type {
  PaymentTerm,
  PrismaClient,
  Product,
  ProductVariant,
  Vendor,
} from '@/generated/tenant';
import {
  cancelPurchaseOrder,
  confirmPurchaseOrder,
  createPurchaseOrder,
} from '@/server/services/purchaseOrders';
import {
  cancelReceipt,
  createDraftReceipt,
  postReceipt,
} from '@/server/services/receipts';
import {
  cancelBill,
  confirmBill,
} from '@/server/services/bills';
import { hasTenantDb, makeClient } from '../helpers/db';
import { upsertTestWarehouse } from '../helpers/warehouseStub';
import { upsertTestVendor } from '../helpers/vendorStub';
import { wipeBillArtifactsForVendors } from '../helpers/wipeBillArtifacts';

const suite = hasTenantDb ? describe : describe.skip;
const TAG = 'TEST-BDFR';

suite('Bill auto-draft from receipt (slice C)', () => {
  let db: PrismaClient;
  let term: PaymentTerm;
  let vendor: Vendor;
  let warehouseId: string;
  let product: Product;
  let variantA: ProductVariant;
  let variantB: ProductVariant;

  beforeAll(async () => {
    db = makeClient();
    term = await db.paymentTerm.findFirstOrThrow({ where: { code: 'NET30' } });
    const wh = await upsertTestWarehouse(db, {
      code: `${TAG}-WH`,
      name: 'BDFR WH',
    });
    warehouseId = wh.id;
    product = await db.product.upsert({
      where: { sku: `${TAG}-PROD` },
      create: { sku: `${TAG}-PROD`, name: 'BDFR Product' },
      update: { active: true, deletedAt: null },
    });
    variantA = await db.productVariant.upsert({
      where: { sku: `${TAG}-A` },
      create: { productId: product.id, sku: `${TAG}-A`, name: 'A' },
      update: { productId: product.id, active: true, deletedAt: null },
    });
    variantB = await db.productVariant.upsert({
      where: { sku: `${TAG}-B` },
      create: { productId: product.id, sku: `${TAG}-B`, name: 'B' },
      update: { productId: product.id, active: true, deletedAt: null },
    });
  });

  beforeEach(async () => {
    await wipe();
    vendor = await upsertTestVendor(db, {
      code: `${TAG}-VEN`,
      name: `${TAG} Vendor`,
    });
    await db.vendor.update({
      where: { id: vendor.id },
      data: { paymentTermId: term.id },
    });
  });

  afterAll(async () => {
    await wipe();
    await db.productVariant.deleteMany({
      where: { productId: product.id },
    });
    await db.product.deleteMany({ where: { id: product.id } });
    await db.warehouse.deleteMany({ where: { code: `${TAG}-WH` } });
    await db.vendor.deleteMany({ where: { code: { startsWith: `${TAG}-VEN` } } });
    await db.$disconnect();
  });

  async function makePoAndPostReceipt(args: {
    lines: Array<{ variant: ProductVariant; qty: string; unitCost: string }>;
  }): Promise<{ poId: string; receiptId: string; receiptNumber: string }> {
    const po = await createPurchaseOrder(db, {
      vendorId: vendor.id,
      lines: args.lines.map((l) => ({
        variantId: l.variant.id,
        warehouseId,
        qtyOrdered: l.qty,
        unitCost: l.unitCost,
      })),
    });
    await confirmPurchaseOrder(db, po.id);
    const poFresh = await db.purchaseOrder.findUniqueOrThrow({
      where: { id: po.id },
      include: { lines: true },
    });
    const draft = await createDraftReceipt(db, {
      vendorId: vendor.id,
      warehouseId,
      lines: args.lines.map((l) => {
        const matchingPoLine = poFresh.lines.find((pl) => pl.variantId === l.variant.id)!;
        return {
          purchaseOrderLineId: matchingPoLine.id,
          variantId: l.variant.id,
          warehouseId,
          qtyReceived: l.qty,
          unitCost: l.unitCost,
        };
      }),
    });
    const posted = await postReceipt(db, draft.id);
    return { poId: po.id, receiptId: posted.id, receiptNumber: posted.number };
  }

  // ---------- Auto-create on postReceipt ----------

  it('postReceipt auto-creates a DRAFT bill matching the receipt with PRODUCT source', async () => {
    const { receiptId, receiptNumber } = await makePoAndPostReceipt({
      lines: [
        { variant: variantA, qty: '10', unitCost: '5' },
        { variant: variantB, qty: '4', unitCost: '7' },
      ],
    });

    const link = await db.billReceipt.findFirstOrThrow({ where: { receiptId } });
    const bill = await db.bill.findUniqueOrThrow({
      where: { id: link.billId },
      include: { lines: true, receipts: true, purchaseOrders: true },
    });
    expect(bill.status).toBe(BillStatus.DRAFT);
    expect(bill.source).toBe(BillSource.PRODUCT);
    expect(bill.vendorId).toBe(vendor.id);
    expect(bill.subtotal.toString()).toBe(new Prisma.Decimal('78').toString());
    expect(bill.notes).toMatch(new RegExp(`Auto-drafted from receipt ${receiptNumber}`));
    expect(bill.lines).toHaveLength(2);
    for (const line of bill.lines) {
      expect(line.receiptLineId).not.toBeNull();
    }
  });

  it('auto-create populates BillPurchaseOrder join from the receipt-line PO link', async () => {
    const { poId, receiptId } = await makePoAndPostReceipt({
      lines: [{ variant: variantA, qty: '5', unitCost: '10' }],
    });
    const link = await db.billReceipt.findFirstOrThrow({ where: { receiptId } });
    const poLinks = await db.billPurchaseOrder.findMany({
      where: { billId: link.billId },
    });
    expect(poLinks).toHaveLength(1);
    expect(poLinks[0].purchaseOrderId).toBe(poId);
  });

  it('auto-create writes DRAFT_BILL_GENERATED audit (not CREATE) for system origin', async () => {
    const { receiptId } = await makePoAndPostReceipt({
      lines: [{ variant: variantA, qty: '2', unitCost: '5' }],
    });
    const link = await db.billReceipt.findFirstOrThrow({ where: { receiptId } });
    const audits = await db.auditLog.findMany({
      where: { entityType: 'Bill', entityId: link.billId },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe(AuditAction.DRAFT_BILL_GENERATED);
  });

  it('auto-create posts NO journal entry — DRAFT bills have no GL effect', async () => {
    const { receiptId } = await makePoAndPostReceipt({
      lines: [{ variant: variantA, qty: '3', unitCost: '5' }],
    });
    const link = await db.billReceipt.findFirstOrThrow({ where: { receiptId } });
    const jes = await db.journalEntry.findMany({
      where: { entityType: 'Bill', entityId: link.billId },
    });
    expect(jes).toHaveLength(0);
  });

  it('auto-create is idempotent: re-running postReceipt logic does not duplicate the bill (singleton check via BillReceipt)', async () => {
    // postReceipt itself can't be re-called (status guard), but the
    // helper underneath (createDraftBillFromReceiptTx) is what enforces
    // the no-duplicate property. Simulate by directly invoking the helper
    // a second time within a fresh transaction.
    const { receiptId } = await makePoAndPostReceipt({
      lines: [{ variant: variantA, qty: '2', unitCost: '5' }],
    });
    const before = await db.billReceipt.count({ where: { receiptId } });
    const { createDraftBillFromReceiptTx } = await import('@/server/services/bills');
    const second = await db.$transaction((tx) =>
      createDraftBillFromReceiptTx(tx, receiptId),
    );
    expect(second).toBeNull();
    const after = await db.billReceipt.count({ where: { receiptId } });
    expect(after).toBe(before);
  });

  // ---------- Cancel-receipt cascade ----------

  it('cancelReceipt cascades: linked DRAFT bill flips to CANCELLED with descriptive reason', async () => {
    const { receiptId, receiptNumber } = await makePoAndPostReceipt({
      lines: [{ variant: variantA, qty: '5', unitCost: '10' }],
    });
    const linkBefore = await db.billReceipt.findFirstOrThrow({
      where: { receiptId },
    });

    await cancelReceipt(db, receiptId, { reason: 'wrong vendor' });

    const billAfter = await db.bill.findUniqueOrThrow({
      where: { id: linkBefore.billId },
    });
    expect(billAfter.status).toBe(BillStatus.CANCELLED);
    expect(billAfter.cancelledAt).not.toBeNull();
    expect(billAfter.cancelReason).toMatch(
      new RegExp(`Source receipt ${receiptNumber} cancelled.*wrong vendor`),
    );

    // Receipt itself still cancellable (guard fired only against
    // CONFIRMED bills, and ours was DRAFT).
    const receiptAfter = await db.receipt.findUniqueOrThrow({
      where: { id: receiptId },
    });
    expect(receiptAfter.status).toBe(ReceiptStatus.CANCELLED);
  });

  it('cancelReceipt REFUSES when a CONFIRMED bill links to it; bill must be cancelled first', async () => {
    const { receiptId } = await makePoAndPostReceipt({
      lines: [{ variant: variantA, qty: '5', unitCost: '10' }],
    });
    const link = await db.billReceipt.findFirstOrThrow({ where: { receiptId } });

    // Confirm the auto-drafted bill, then try to cancel the receipt.
    await confirmBill(db, link.billId);

    await expect(
      cancelReceipt(db, receiptId, { reason: 'oops' }),
    ).rejects.toThrow(/confirmed bill .* is linked. Cancel the bill first/);

    // Receipt unchanged.
    const receiptAfter = await db.receipt.findUniqueOrThrow({
      where: { id: receiptId },
    });
    expect(receiptAfter.status).toBe(ReceiptStatus.POSTED);

    // Cancel bill first → then receipt cancellation succeeds.
    await cancelBill(db, link.billId, 'AP error, restart');
    await cancelReceipt(db, receiptId, { reason: 'now safe to reverse' });
    const finalReceipt = await db.receipt.findUniqueOrThrow({
      where: { id: receiptId },
    });
    expect(finalReceipt.status).toBe(ReceiptStatus.CANCELLED);
  });

  it('cancel-cascade does NOT touch a DRAFT bill that was already cancelled (idempotency)', async () => {
    const { receiptId } = await makePoAndPostReceipt({
      lines: [{ variant: variantA, qty: '2', unitCost: '5' }],
    });
    const link = await db.billReceipt.findFirstOrThrow({ where: { receiptId } });
    await cancelBill(db, link.billId, 'manual cancel before receipt cancel');

    // Receipt cancel should still succeed; cascade just finds no DRAFT
    // bills to flip (the only linked bill is already CANCELLED).
    await cancelReceipt(db, receiptId, { reason: 'test cascade safety' });

    const billAfter = await db.bill.findUniqueOrThrow({
      where: { id: link.billId },
    });
    // cancelReason should still match the manual cancel — cascade
    // didn't overwrite a non-DRAFT bill.
    expect(billAfter.cancelReason).toBe('manual cancel before receipt cancel');
  });

  // ---------- Confirm path on auto-drafted bill ----------

  it('auto-drafted bill: confirmBill posts the standard PRODUCT JE (DR 2020 / CR 2010)', async () => {
    const { receiptId } = await makePoAndPostReceipt({
      lines: [{ variant: variantA, qty: '4', unitCost: '25' }],
    });
    const link = await db.billReceipt.findFirstOrThrow({ where: { receiptId } });
    const confirmed = await confirmBill(db, link.billId);
    expect(confirmed.status).toBe(BillStatus.CONFIRMED);
    const je = await db.journalEntry.findFirstOrThrow({
      where: { entityType: 'Bill', entityId: link.billId },
      include: { lines: { include: { account: true } } },
    });
    const dr = je.lines.find((l) => l.account.code === '2020');
    const cr = je.lines.find((l) => l.account.code === '2010');
    expect(dr?.debit.toString()).toBe(new Prisma.Decimal('100').toString());
    expect(cr?.credit.toString()).toBe(new Prisma.Decimal('100').toString());
  });
});

async function wipe(): Promise<void> {
  const db = makeClient();
  try {
    const vendors = await db.vendor.findMany({
      where: { code: { startsWith: `${TAG}-VEN` } },
      select: { id: true },
    });
    const vendorIds = vendors.map((v) => v.id);

    await wipeBillArtifactsForVendors(db, vendorIds);

    if (vendorIds.length > 0) {
      // Receipts → cascades to BillReceipt rows automatically (any
      // bills already cleaned by helper above). Movements + layers
      // need explicit cleanup.
      const receipts = await db.receipt.findMany({
        where: { vendorId: { in: vendorIds } },
        select: { id: true },
      });
      const receiptIds = receipts.map((r) => r.id);

      // JEs on the receipts (post + cancel JEs).
      if (receiptIds.length > 0) {
        const jes = await db.journalEntry.findMany({
          where: { entityType: 'Receipt', entityId: { in: receiptIds } },
          select: { id: true },
        });
        if (jes.length > 0) {
          const jeIds = jes.map((j) => j.id);
          await db.journalEntryLine.deleteMany({
            where: { journalEntryId: { in: jeIds } },
          });
          await db.journalEntry.deleteMany({ where: { id: { in: jeIds } } });
        }
        await db.auditLog.deleteMany({
          where: { entityType: 'Receipt', entityId: { in: receiptIds } },
        });
      }

      // Movements + FIFO layers from variants in this suite.
      const variantIds = (
        await db.productVariant.findMany({
          where: { sku: { startsWith: TAG } },
          select: { id: true },
        })
      ).map((v) => v.id);

      if (variantIds.length > 0) {
        const layers = await db.fifoLayer.findMany({
          where: { variantId: { in: variantIds } },
          select: { id: true },
        });
        if (layers.length > 0) {
          const layerIds = layers.map((l) => l.id);
          await db.fifoConsumption.deleteMany({ where: { layerId: { in: layerIds } } });
          await db.auditLog.deleteMany({
            where: { entityType: 'FifoLayer', entityId: { in: layerIds } },
          });
          await db.fifoLayer.deleteMany({ where: { id: { in: layerIds } } });
        }
        const movements = await db.inventoryMovement.findMany({
          where: { variantId: { in: variantIds } },
          select: { id: true },
        });
        if (movements.length > 0) {
          const mIds = movements.map((m) => m.id);
          await db.fifoConsumption.deleteMany({ where: { movementId: { in: mIds } } });
          await db.auditLog.deleteMany({
            where: { entityType: 'InventoryMovement', entityId: { in: mIds } },
          });
        }
        await db.inventoryMovement.deleteMany({
          where: { variantId: { in: variantIds } },
        });
        await db.inventoryItem.deleteMany({
          where: { variantId: { in: variantIds } },
        });
        await db.receiptLine.deleteMany({
          where: { variantId: { in: variantIds } },
        });
      }
      await db.receipt.deleteMany({ where: { vendorId: { in: vendorIds } } });

      // POs.
      const pos = await db.purchaseOrder.findMany({
        where: { vendorId: { in: vendorIds } },
        select: { id: true },
      });
      const poIds = pos.map((p) => p.id);
      if (poIds.length > 0) {
        await db.auditLog.deleteMany({
          where: { entityType: 'PurchaseOrder', entityId: { in: poIds } },
        });
        await db.purchaseOrderLine.deleteMany({
          where: { purchaseOrderId: { in: poIds } },
        });
        await db.purchaseOrder.deleteMany({ where: { id: { in: poIds } } });
      }
    }
  } finally {
    await db.$disconnect();
  }
}

// Suppress unused-import warning for cancelPurchaseOrder (kept for future
// "auto-cancel-bill on PO cancel" tests).
void cancelPurchaseOrder;
