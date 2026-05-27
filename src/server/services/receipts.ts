import {
  Prisma,
  AuditAction,
  PurchaseOrderStatus,
  ReceiptStatus,
} from '@/generated/tenant';
import type {
  PrismaClient,
  Receipt,
  ReceiptLine,
} from '@/generated/tenant';
import { audit, type AuditContext } from '@/lib/audit/audit';
import { getNextSequence } from '@/lib/sequences/sequences';
import {
  cancelReceiptInputSchema,
  createReceiptInputSchema,
  updateReceiptInputSchema,
  type CancelReceiptInput,
  type CreateReceiptInput,
  type UpdateReceiptInput,
} from '@/lib/validation/receipts';
import {
  receiveInventoryTx,
  reverseReceiveTx,
} from '@/server/services/movements';
import {
  applyComputedPoStatus,
  recomputeQtyReceivedForPoLine,
} from '@/server/services/purchaseOrders';
import { createFifoLayerOnReceiveTx } from '@/server/services/fifoLayers';
import {
  cancelDraftBillsForReceiptTx,
  confirmBillTx,
  createDraftBillFromReceiptTx,
  hasConfirmedBillForReceiptTx,
} from '@/server/services/bills';
import { applyPoPaymentsToBillTx } from '@/server/services/poPayments';
import { markProductsDirtyFromVariants } from '@/server/services/inventoryPushTriggers';
import { post } from '@/lib/gl/post';

const RECEIPT_SEQUENCE_NAME = 'receipt';
const RECEIPT_PREFIX = 'RCPT';

// GL account code for the credit side of receipt-time JE.
// "Goods received not invoiced" clearing account — DR'd later when the
// AP slice's confirmBill matches the receipt to a vendor bill.
const ACCRUED_RECEIPTS_ACCOUNT = '2020';

type ReceiptWithLines = Receipt & { lines: ReceiptLine[] };

async function validateReceiptLines(
  tx: Prisma.TransactionClient,
  args: {
    vendorId: string;
    warehouseId: string;
    lines: ReadonlyArray<{
      purchaseOrderLineId?: string | null;
      variantId: string;
      warehouseId: string;
    }>;
  },
): Promise<void> {
  for (const l of args.lines) {
    if (l.warehouseId !== args.warehouseId) {
      throw new Error(
        `ReceiptLine warehouseId must match Receipt.warehouseId (got line=${l.warehouseId} receipt=${args.warehouseId})`,
      );
    }
  }
  const poLineIds = args.lines
    .map((l) => l.purchaseOrderLineId)
    .filter((id): id is string => !!id);
  if (poLineIds.length === 0) return;

  const poLines = await tx.purchaseOrderLine.findMany({
    where: { id: { in: poLineIds }, deletedAt: null },
    include: { purchaseOrder: true },
  });
  const found = new Map(poLines.map((p) => [p.id, p]));
  for (const id of poLineIds) {
    const p = found.get(id);
    if (!p) throw new Error(`PurchaseOrderLine not found: ${id}`);
    if (p.purchaseOrder.deletedAt) {
      throw new Error(`PurchaseOrderLine ${id} belongs to a deleted PO`);
    }
    if (p.purchaseOrder.vendorId !== args.vendorId) {
      throw new Error(
        `PurchaseOrderLine ${id} vendor mismatch (line vendor=${p.purchaseOrder.vendorId} receipt vendor=${args.vendorId})`,
      );
    }
    if (
      p.purchaseOrder.status !== PurchaseOrderStatus.CONFIRMED &&
      p.purchaseOrder.status !== PurchaseOrderStatus.PARTIALLY_RECEIVED
    ) {
      throw new Error(
        `PurchaseOrder ${p.purchaseOrder.id} status ${p.purchaseOrder.status} cannot receive`,
      );
    }
  }
}

export async function createDraftReceipt(
  db: PrismaClient,
  input: CreateReceiptInput,
  ctx?: AuditContext,
): Promise<ReceiptWithLines> {
  const data = createReceiptInputSchema.parse(input);
  return db.$transaction(async (tx) => {
    await validateReceiptLines(tx, {
      vendorId: data.vendorId,
      warehouseId: data.warehouseId,
      lines: data.lines,
    });
    const seq = await getNextSequence(tx, {
      name: RECEIPT_SEQUENCE_NAME,
      prefix: RECEIPT_PREFIX,
      useYear: true,
    });
    const receipt = await tx.receipt.create({
      data: {
        number: seq.formatted,
        vendorId: data.vendorId,
        warehouseId: data.warehouseId,
        notes: data.notes,
        lines: {
          create: data.lines.map((l) => ({
            purchaseOrderLineId: l.purchaseOrderLineId ?? null,
            variantId: l.variantId,
            warehouseId: l.warehouseId,
            qtyReceived: new Prisma.Decimal(l.qtyReceived),
            unitCost: new Prisma.Decimal(l.unitCost),
            notes: l.notes,
          })),
        },
      },
      include: { lines: true },
    });
    await audit(tx, {
      action: AuditAction.CREATE,
      entityType: 'Receipt',
      entityId: receipt.id,
      after: receipt,
      ctx: { userId: ctx?.userId ?? data.createdById ?? null, ipAddress: ctx?.ipAddress, reason: ctx?.reason },
    });
    return receipt;
  });
}

export async function updateDraftReceipt(
  db: PrismaClient,
  id: string,
  input: UpdateReceiptInput,
  ctx?: AuditContext,
): Promise<ReceiptWithLines> {
  const data = updateReceiptInputSchema.parse(input);
  return db.$transaction(async (tx) => {
    const before = await tx.receipt.findUnique({ where: { id }, include: { lines: true } });
    if (!before) throw new Error(`Receipt not found: ${id}`);
    if (before.status !== ReceiptStatus.DRAFT) {
      throw new Error(`Cannot edit Receipt in status ${before.status}`);
    }

    if (data.lines) {
      await validateReceiptLines(tx, {
        vendorId: before.vendorId,
        warehouseId: before.warehouseId,
        lines: data.lines,
      });
      await tx.receiptLine.deleteMany({ where: { receiptId: id } });
      for (const l of data.lines) {
        await tx.receiptLine.create({
          data: {
            receiptId: id,
            purchaseOrderLineId: l.purchaseOrderLineId ?? null,
            variantId: l.variantId,
            warehouseId: l.warehouseId,
            qtyReceived: new Prisma.Decimal(l.qtyReceived),
            unitCost: new Prisma.Decimal(l.unitCost),
            notes: l.notes,
          },
        });
      }
    }

    const after = await tx.receipt.update({
      where: { id },
      data: { notes: data.notes ?? before.notes },
      include: { lines: true },
    });
    await audit(tx, {
      action: AuditAction.UPDATE,
      entityType: 'Receipt',
      entityId: id,
      before,
      after,
      ctx,
    });
    return after;
  });
}

export type PostReceiptResult = ReceiptWithLines & {
  wasOverReceived: boolean;
  affectedPurchaseOrderIds: string[];
};

export async function postReceipt(
  db: PrismaClient,
  id: string,
  ctx?: AuditContext,
): Promise<PostReceiptResult> {
  const result = await db.$transaction(async (tx) => {
    const before = await tx.receipt.findUnique({
      where: { id },
      include: {
        lines: true,
        // Warehouse + inventoryAccount.code load eagerly so the GL leg
        // can resolve account codes without a second round-trip. The
        // include extension is local to this query — no propagation to
        // the return type because `final` (re-read at function end) uses
        // the original `{ lines: true }` shape.
        warehouse: {
          select: {
            code: true,
            inventoryAccount: { select: { code: true } },
          },
        },
      },
    });
    if (!before) throw new Error(`Receipt not found: ${id}`);
    if (before.status !== ReceiptStatus.DRAFT) {
      throw new Error(`Cannot post Receipt in status ${before.status}`);
    }
    if (before.lines.length === 0) {
      throw new Error('Cannot post a Receipt with no lines');
    }
    // Fail fast if the receiving warehouse has no inventory GL account.
    // Mirrors cogsPosting / createAdjustmentTx — better to throw upfront
    // than to do all the per-line work + audit + FIFO writes and then
    // fail at the GL leg, forcing a wasteful rollback.
    if (!before.warehouse.inventoryAccount?.code) {
      throw new Error(
        `postReceipt: warehouse '${before.warehouse.code}' has no inventoryAccountId — link it to a GL account before posting receipts against it`,
      );
    }

    let wasOverReceived = false;
    const affectedPoLineIds = new Set<string>();
    const affectedPoIds = new Set<string>();

    // Flip status FIRST so recomputeQtyReceivedForPoLine (which filters on
    // receipt.status = POSTED) sees the receipt as in-scope when it sums.
    // TODO: postReceipt does not currently accept a backdated receivedAt
    // parameter. The FifoLayer.receivedDate created below mirrors this
    // value, which is correct semantics for "right now" receives but
    // blocks user-backdated FIFO scenarios per the spec. Adding an
    // optional receivedAt parameter is a follow-on slice.
    const after = await tx.receipt.update({
      where: { id },
      data: {
        status: ReceiptStatus.POSTED,
        receivedAt: new Date(),
        postedById: ctx?.userId ?? null,
      },
      include: { lines: true },
    });
    await audit(tx, {
      action: AuditAction.STATUS_CHANGE,
      entityType: 'Receipt',
      entityId: id,
      before: { status: before.status },
      after: { status: after.status },
      ctx,
    });

    // GL subtotal accumulator. Σ(qtyReceived × unitCost) across all
    // lines on this receipt. validateReceiptLines (called on draft
    // create + update) enforces every line shares the receipt's
    // warehouseId, so the GL leg collapses to a single DR Inventory +
    // single CR Accrued Receipts pair — not per-warehouse fan-out like
    // COGS posting.
    let glSubtotal = new Prisma.Decimal(0);

    for (const line of before.lines) {
      const movement = await receiveInventoryTx(
        tx,
        {
          variantId: line.variantId,
          warehouseId: line.warehouseId,
          qty: line.qtyReceived.toString(),
          reference: before.number,
          createdById: ctx?.userId ?? undefined,
        },
        ctx,
      );
      // The RECEIVE movement carries the same unitCost as the line — they
      // describe the same event from inventory and costing perspectives.
      await tx.inventoryMovement.update({
        where: { id: movement.id },
        data: { unitCost: line.unitCost },
      });
      await tx.receiptLine.update({
        where: { id: line.id },
        data: { inventoryMovementId: movement.id },
      });
      // Create the FIFO cost layer for this receipt line. receivedDate
      // is sourced from after.receivedAt (the value set on the receipt
      // status flip above) so the layer's FIFO position reflects the
      // business event date, not a redundant new Date() call.
      await createFifoLayerOnReceiveTx(
        tx,
        {
          variantId: line.variantId,
          warehouseId: line.warehouseId,
          qtyReceived: line.qtyReceived,
          unitCost: line.unitCost,
          receivedDate: after.receivedAt!,
          sourceReceiptLineId: line.id,
          sourceMovementId: movement.id,
        },
        ctx,
      );
      // Accumulate GL subtotal for the post() call after this loop.
      glSubtotal = glSubtotal.plus(line.qtyReceived.times(line.unitCost));
      if (line.purchaseOrderLineId) {
        affectedPoLineIds.add(line.purchaseOrderLineId);
      }
    }

    // GL leg: DR Inventory - <warehouse> / CR Accrued Receipts. Single
    // pair because Receipt.warehouseId is one-per-receipt.
    //
    // Skip-when-zero: if every line had qty=0 or unitCost=0 the subtotal
    // is 0 and post() would reject the zero-amount lines (one-side > 0
    // invariant). validateReceiptLines guards against zero-line receipts
    // upstream, but per-line zero qtyReceived/unitCost is allowed by the
    // schema, so the skip is the safe path. Mirrors createAdjustmentTx.
    //
    // postedAt: after.receivedAt — JE business-event date matches the
    // receipt event date, not the row-insertion timestamp. post()
    // honors backdated postedAt per the Part 4 invariant. The non-null
    // assertion is safe because the status update above explicitly sets
    // receivedAt to a non-null Date — same pattern as the FifoLayer
    // receivedDate above.
    if (glSubtotal.greaterThan(0)) {
      await post(tx, {
        entityType: 'Receipt',
        entityId: id,
        description: `Goods received for receipt ${before.number}`,
        postedAt: after.receivedAt!,
        lines: [
          {
            accountCode: before.warehouse.inventoryAccount.code,
            debit: glSubtotal,
            memo: `Goods received at ${before.warehouse.code}`,
          },
          {
            accountCode: ACCRUED_RECEIPTS_ACCOUNT,
            credit: glSubtotal,
            memo: `Accrued receipts pending bill (receipt ${before.number})`,
          },
        ],
      });
    }

    // Recompute qtyReceived on each affected PO line, detect over-receive,
    // and collect affected PO ids.
    for (const poLineId of affectedPoLineIds) {
      const total = await recomputeQtyReceivedForPoLine(tx, poLineId);
      const poLine = await tx.purchaseOrderLine.findUnique({
        where: { id: poLineId },
        select: { qtyOrdered: true, purchaseOrderId: true },
      });
      if (poLine) {
        affectedPoIds.add(poLine.purchaseOrderId);
        if (total.greaterThan(poLine.qtyOrdered)) wasOverReceived = true;
      }
    }

    // Recompute each affected PO's status from current state.
    for (const poId of affectedPoIds) {
      await applyComputedPoStatus(tx, poId, ctx);
    }

    // AP slice: auto-create AND auto-confirm a bill matching this
    // receipt in one shot. The draft is created by
    // createDraftBillFromReceiptTx (idempotent — returns null when a
    // non-cancelled bill already references this receipt, or when
    // every receipt line has qtyReceived = 0). When a draft is
    // produced, confirmBillTx is called against it in the same tx so
    // the AP JE (DR 2020 Accrued Receipts / CR 2010 AP) posts
    // immediately and the bill appears CONFIRMED on the vendor AP
    // tab without operator intervention. The freshly-created bill
    // satisfies every confirmBillTx precondition (DRAFT status,
    // lineSum === subtotal invariant set at create time, lines
    // present), so this composition is safe.
    //
    // Operator workflow change: when the vendor's actual invoice
    // arrives and differs from the receipt, the operator edits the
    // confirmed bill (updateBill handles the re-posting), or cancels
    // it and re-enters from scratch. cancelReceipt now refuses
    // whenever any auto-confirmed bill is still live — the operator
    // must cancelBill first.
    const draftBill = await createDraftBillFromReceiptTx(tx, id, ctx);
    if (draftBill != null) {
      await confirmBillTx(tx, draftBill.id, ctx);
      // PO direct-payment slice: once the bill is confirmed, consume any
      // unapplied deposits on the PO(s) it links to (oldest-first, split-
      // capable). DR 2010 AP / CR 1510 per applied deposit, in this same
      // transaction so the receipt post + bill confirm + deposit apply are
      // atomic. No-op when the PO carries no unapplied deposits.
      await applyPoPaymentsToBillTx(tx, draftBill.id, ctx);
    }

    // Re-read with linked movements for the response.
    const final = (await tx.receipt.findUnique({
      where: { id },
      include: { lines: true },
    }))!;

    return {
      ...final,
      wasOverReceived,
      affectedPurchaseOrderIds: Array.from(affectedPoIds),
    };
  });
  // Shopify inventory push — every RECEIVE bumps onHand, so push the new
  // available numbers to applicable stores after the tx commits.
  await markProductsDirtyFromVariants(
    db,
    result.lines.map((l) => l.variantId),
  );
  return result;
}

export async function cancelReceipt(
  db: PrismaClient,
  id: string,
  input: CancelReceiptInput,
  ctx?: AuditContext,
): Promise<ReceiptWithLines & { affectedPurchaseOrderIds: string[] }> {
  const data = cancelReceiptInputSchema.parse(input);
  const result = await db.$transaction(async (tx) => {
    const before = await tx.receipt.findUnique({
      where: { id },
      include: {
        lines: true,
        // Eager-load warehouse + inventoryAccount.code for the cancel
        // GL leg. Same include shape as postReceipt — the cancel JE is
        // the sign-mirror of the post JE so it needs the same data.
        warehouse: {
          select: {
            code: true,
            inventoryAccount: { select: { code: true } },
          },
        },
      },
    });
    if (!before) throw new Error(`Receipt not found: ${id}`);
    if (before.status !== ReceiptStatus.POSTED) {
      throw new Error(`Cannot cancel Receipt in status ${before.status}`);
    }
    // Fail fast if the warehouse has lost its inventory GL account link
    // since the original post (edge case — admin would have to actively
    // unlink). Better to throw before any side effects than to partially
    // cancel and fail at the GL leg, mid-tx. Mirrors postReceipt.
    if (!before.warehouse.inventoryAccount?.code) {
      throw new Error(
        `cancelReceipt: warehouse '${before.warehouse.code}' has no inventoryAccountId — link it to a GL account before cancelling receipts against it`,
      );
    }

    // AP guard: refuse if any CONFIRMED Bill links to this receipt.
    // The bill carries an AP balance against this receipt's accrued
    // receipts; cancelling the receipt would orphan the bill's GL
    // claim. AP staff must cancel the bill first.
    const blockingBill = await hasConfirmedBillForReceiptTx(tx, id);
    if (blockingBill) {
      throw new Error(
        `Cannot cancel receipt: confirmed bill ${blockingBill.number} is linked. Cancel the bill first.`,
      );
    }

    // Guard: refuse cancel if any layer from this receipt has been
    // consumed. Reversing partially-consumed inventory would require
    // unwinding COGS posts that may already exist; the user must use
    // an inventory adjustment instead.
    const lineIds = before.lines.map((l) => l.id);
    if (lineIds.length > 0) {
      const consumedLayer = await tx.fifoLayer.findFirst({
        where: {
          sourceReceiptLineId: { in: lineIds },
          deletedAt: null,
          qtyConsumed: { gt: new Prisma.Decimal(0) },
        },
        select: { id: true },
      });
      if (consumedLayer) {
        throw new Error(
          'Cannot cancel receipt: receipt has consumed inventory layers. Use inventory adjustment instead.',
        );
      }
    }

    const affectedPoLineIds = new Set<string>();
    const affectedPoIds = new Set<string>();

    // Soft-delete all clean (qtyConsumed = 0) layers from this receipt.
    // Guard above guarantees none have qtyConsumed > 0; this scopes the
    // soft-delete to layers whose source matches one of this receipt's
    // line ids. Done before the per-line loop so the layer state is
    // consistent before any movement reversals fire.
    if (lineIds.length > 0) {
      await tx.fifoLayer.updateMany({
        where: {
          sourceReceiptLineId: { in: lineIds },
          deletedAt: null,
        },
        data: { deletedAt: new Date() },
      });
    }

    // GL subtotal accumulator. Σ(qtyReceived × unitCost) from the
    // original receipt lines — exactly mirrors the post-time JE
    // arithmetic so the cancel JE offsets the post JE to the cent.
    // validateReceiptLines enforces single-warehouse-per-receipt, so
    // the cancel JE collapses to one DR + one CR pair (sign-mirror of
    // postReceipt's DR Inventory / CR Accrued Receipts pair).
    let glSubtotal = new Prisma.Decimal(0);

    for (const line of before.lines) {
      // 1. Reverse the movement via dedicated RECEIVE_REVERSE type.
      await reverseReceiveTx(
        tx,
        {
          variantId: line.variantId,
          warehouseId: line.warehouseId,
          qty: line.qtyReceived.toString(),
          reference: `RECEIPT_CANCEL:${before.number}`,
          createdById: ctx?.userId ?? undefined,
        },
        ctx,
      );
      // 2. Soft-delete the receipt line so it stops contributing to PO roll-up.
      await tx.receiptLine.update({
        where: { id: line.id },
        data: { deletedAt: new Date() },
      });
      // 3. Accumulate GL subtotal for the cancel JE after this loop.
      glSubtotal = glSubtotal.plus(line.qtyReceived.times(line.unitCost));
      if (line.purchaseOrderLineId) affectedPoLineIds.add(line.purchaseOrderLineId);
    }

    // 4. GL leg: DR Accrued Receipts / CR Inventory - <warehouse>.
    // Sign-mirror of postReceipt's JE. Same skip-when-zero guard for
    // symmetry with createAdjustmentTx + postReceipt.
    //
    // postedAt: new Date() — cancel is its own business event with its
    // own date. Receipt has no cancelledAt column today (PurchaseOrder /
    // SalesOrder / Invoice all do; Receipt is the outlier — adding it
    // is a separate slice tied to period-close gating). The audit log
    // row's createdAt + the JE's postedAt together capture the cancel
    // timestamp until that schema fill-in lands.
    //
    // Idempotency: post()'s (entityType, entityId, description) tuple
    // distinguishes "Goods received for receipt X" (post) from
    // "Cancellation of receipt X" (cancel) — both JEs coexist on the
    // same Receipt entityId, which is the design intent.
    if (glSubtotal.greaterThan(0)) {
      await post(tx, {
        entityType: 'Receipt',
        entityId: id,
        description: `Cancellation of receipt ${before.number}`,
        postedAt: new Date(),
        lines: [
          {
            accountCode: ACCRUED_RECEIPTS_ACCOUNT,
            debit: glSubtotal,
            memo: `Cancelled accrued receipts (receipt ${before.number})`,
          },
          {
            accountCode: before.warehouse.inventoryAccount.code,
            credit: glSubtotal,
            memo: `Inventory reversal at ${before.warehouse.code}`,
          },
        ],
      });
    }

    // 5. Recompute qtyReceived for each affected PO line.
    for (const poLineId of affectedPoLineIds) {
      await recomputeQtyReceivedForPoLine(tx, poLineId);
      const poLine = await tx.purchaseOrderLine.findUnique({
        where: { id: poLineId },
        select: { purchaseOrderId: true },
      });
      if (poLine) affectedPoIds.add(poLine.purchaseOrderId);
    }

    // 6. Recompute PO statuses purely from current state.
    for (const poId of affectedPoIds) {
      await applyComputedPoStatus(tx, poId, ctx);
    }

    // 7. Mark receipt CANCELLED.
    const after = await tx.receipt.update({
      where: { id },
      data: { status: ReceiptStatus.CANCELLED },
      include: { lines: true },
    });
    await audit(tx, {
      action: AuditAction.VOID,
      entityType: 'Receipt',
      entityId: id,
      before: { status: before.status },
      after: { status: after.status },
      ctx: { ...ctx, reason: data.reason ?? ctx?.reason ?? null },
    });

    // 8. AP slice cascade: cancel any DRAFT bill that auto-drafted (or
    // was manually linked) from this receipt. CONFIRMED bills were
    // refused upfront by hasConfirmedBillForReceiptTx, so this only
    // touches drafts.
    await cancelDraftBillsForReceiptTx(
      tx,
      id,
      `Source receipt ${before.number} cancelled: ${data.reason ?? ctx?.reason ?? 'no reason given'}`,
      ctx,
    );

    return { ...after, affectedPurchaseOrderIds: Array.from(affectedPoIds) };
  });
  // Shopify inventory push — RECEIVE_REVERSE drops onHand, so push the new
  // available numbers. Use `before.lines` source: result.lines may already
  // be soft-deleted, but the variantIds are the same.
  await markProductsDirtyFromVariants(
    db,
    result.lines.map((l) => l.variantId),
  );
  return result;
}

export async function getReceipt(
  db: PrismaClient,
  id: string,
): Promise<ReceiptWithLines | null> {
  return db.receipt.findFirst({
    where: { id, deletedAt: null },
    include: { lines: true },
  });
}

export async function listReceipts(
  db: PrismaClient,
  filters: { vendorId?: string; status?: ReceiptStatus; skip?: number; take?: number } = {},
): Promise<ReceiptWithLines[]> {
  const { skip = 0, take = 100, vendorId, status } = filters;
  return db.receipt.findMany({
    where: {
      deletedAt: null,
      ...(vendorId ? { vendorId } : {}),
      ...(status ? { status } : {}),
    },
    include: { lines: true },
    orderBy: { createdAt: 'desc' },
    skip,
    take,
  });
}
