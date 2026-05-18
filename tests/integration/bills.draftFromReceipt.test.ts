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
import { cancelBill } from '@/server/services/bills';
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

  it('postReceipt auto-creates AND auto-confirms a bill matching the receipt with PRODUCT source', async () => {
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
    // Auto-confirm: postReceipt composes confirmBillTx in its own tx
    // so the bill skips DRAFT and lands on CONFIRMED, with confirmedAt
    // stamped. The vendor's actual invoice is reconciled later via
    // updateBill rather than the prior draft → confirm dance.
    expect(bill.status).toBe(BillStatus.CONFIRMED);
    expect(bill.confirmedAt).not.toBeNull();
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

  it('auto-create writes DRAFT_BILL_GENERATED audit (not CREATE) and a STATUS_CHANGE from the auto-confirm', async () => {
    const { receiptId } = await makePoAndPostReceipt({
      lines: [{ variant: variantA, qty: '2', unitCost: '5' }],
    });
    const link = await db.billReceipt.findFirstOrThrow({ where: { receiptId } });
    const audits = await db.auditLog.findMany({
      where: { entityType: 'Bill', entityId: link.billId },
    });
    // Two rows now: DRAFT_BILL_GENERATED (system-origin create) +
    // BILL_CONFIRMED (the AP confirm event, distinct from a generic
    // STATUS_CHANGE so AP reporting can filter the GL-posting moment).
    // Assert by membership rather than order — both land in the same
    // tx so createdAt sub-microsecond collisions can flip their order.
    const actions = audits.map((a) => a.action);
    expect(actions).toContain(AuditAction.DRAFT_BILL_GENERATED);
    expect(actions).toContain(AuditAction.BILL_CONFIRMED);
    expect(audits).toHaveLength(2);
  });

  it('auto-confirm posts the PRODUCT AP JE (DR 2020 Accrued Receipts / CR 2010 AP) automatically', async () => {
    // Pre-fix this test asserted the opposite — that no JE posted —
    // because the bill stayed in DRAFT. With auto-confirm wired into
    // postReceipt, the AP JE lands as part of the same tx, so the
    // vendor's AP balance reflects the receipt immediately.
    const { receiptId } = await makePoAndPostReceipt({
      lines: [{ variant: variantA, qty: '3', unitCost: '5' }],
    });
    const link = await db.billReceipt.findFirstOrThrow({ where: { receiptId } });
    const je = await db.journalEntry.findFirstOrThrow({
      where: { entityType: 'Bill', entityId: link.billId },
      include: { lines: { include: { account: true } } },
    });
    const dr = je.lines.find((l) => l.account.code === '2020');
    const cr = je.lines.find((l) => l.account.code === '2010');
    expect(dr?.debit.toString()).toBe(new Prisma.Decimal('15').toString());
    expect(cr?.credit.toString()).toBe(new Prisma.Decimal('15').toString());
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
  //
  // Pre-fix the cascade-cancel path also handled the common case
  // (auto-drafted bill in DRAFT → cancelReceipt flipped it to
  // CANCELLED). Post-auto-confirm that common case is gone: every
  // auto-bill is CONFIRMED, so cancelReceipt always refuses upfront
  // and the operator must cancelBill first. The cascade code path
  // is still wired (for the rare case of an operator-created DRAFT
  // bill linked to the receipt after the auto-confirmed one was
  // cancelled) — exercised by the "already cancelled" test below.

  it('cancelReceipt REFUSES because the auto-confirmed bill links to it; bill must be cancelled first', async () => {
    const { receiptId } = await makePoAndPostReceipt({
      lines: [{ variant: variantA, qty: '5', unitCost: '10' }],
    });
    const link = await db.billReceipt.findFirstOrThrow({ where: { receiptId } });

    // Bill is already CONFIRMED by postReceipt — no manual confirmBill
    // needed. cancelReceipt should refuse immediately.
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

  it('cancel-cascade does not overwrite a bill that was already cancelled by the operator', async () => {
    const { receiptId } = await makePoAndPostReceipt({
      lines: [{ variant: variantA, qty: '2', unitCost: '5' }],
    });
    const link = await db.billReceipt.findFirstOrThrow({ where: { receiptId } });
    // Operator cancels the auto-confirmed bill (cancelBill posts the
    // reversal JE since the bill is in CONFIRMED status). Then the
    // receipt becomes cancellable.
    await cancelBill(db, link.billId, 'manual cancel before receipt cancel');

    await cancelReceipt(db, receiptId, { reason: 'test cascade safety' });

    const billAfter = await db.bill.findUniqueOrThrow({
      where: { id: link.billId },
    });
    // cancelReason should still match the manual cancel — the receipt
    // cancel cascade only targets DRAFT bills, so the already-cancelled
    // bill is left intact.
    expect(billAfter.cancelReason).toBe('manual cancel before receipt cancel');
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
