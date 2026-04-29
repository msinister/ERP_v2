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

const RECEIPT_SEQUENCE_NAME = 'receipt';
const RECEIPT_PREFIX = 'RCPT';

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
  return db.$transaction(async (tx) => {
    const before = await tx.receipt.findUnique({
      where: { id },
      include: { lines: true },
    });
    if (!before) throw new Error(`Receipt not found: ${id}`);
    if (before.status !== ReceiptStatus.DRAFT) {
      throw new Error(`Cannot post Receipt in status ${before.status}`);
    }
    if (before.lines.length === 0) {
      throw new Error('Cannot post a Receipt with no lines');
    }

    let wasOverReceived = false;
    const affectedPoLineIds = new Set<string>();
    const affectedPoIds = new Set<string>();

    // Flip status FIRST so recomputeQtyReceivedForPoLine (which filters on
    // receipt.status = POSTED) sees the receipt as in-scope when it sums.
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
      await tx.receiptLine.update({
        where: { id: line.id },
        data: { inventoryMovementId: movement.id },
      });
      if (line.purchaseOrderLineId) {
        affectedPoLineIds.add(line.purchaseOrderLineId);
      }
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
}

export async function cancelReceipt(
  db: PrismaClient,
  id: string,
  input: CancelReceiptInput,
  ctx?: AuditContext,
): Promise<ReceiptWithLines & { affectedPurchaseOrderIds: string[] }> {
  const data = cancelReceiptInputSchema.parse(input);
  return db.$transaction(async (tx) => {
    const before = await tx.receipt.findUnique({
      where: { id },
      include: { lines: true },
    });
    if (!before) throw new Error(`Receipt not found: ${id}`);
    if (before.status !== ReceiptStatus.POSTED) {
      throw new Error(`Cannot cancel Receipt in status ${before.status}`);
    }

    const affectedPoLineIds = new Set<string>();
    const affectedPoIds = new Set<string>();

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
      if (line.purchaseOrderLineId) affectedPoLineIds.add(line.purchaseOrderLineId);
    }

    // 3. Recompute qtyReceived for each affected PO line.
    for (const poLineId of affectedPoLineIds) {
      await recomputeQtyReceivedForPoLine(tx, poLineId);
      const poLine = await tx.purchaseOrderLine.findUnique({
        where: { id: poLineId },
        select: { purchaseOrderId: true },
      });
      if (poLine) affectedPoIds.add(poLine.purchaseOrderId);
    }

    // 4. Recompute PO statuses purely from current state.
    for (const poId of affectedPoIds) {
      await applyComputedPoStatus(tx, poId, ctx);
    }

    // 5. Mark receipt CANCELLED.
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

    return { ...after, affectedPurchaseOrderIds: Array.from(affectedPoIds) };
  });
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
