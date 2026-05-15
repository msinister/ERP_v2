import { Prisma, AuditAction, PurchaseOrderStatus } from '@/generated/tenant';
import type { PrismaClient, PurchaseOrder, PurchaseOrderLine } from '@/generated/tenant';
import { audit, type AuditContext } from '@/lib/audit/audit';
import { getNextSequence } from '@/lib/sequences/sequences';
import {
  cancelPurchaseOrderInputSchema,
  closePurchaseOrderInputSchema,
  createPurchaseOrderInputSchema,
  updatePurchaseOrderInputSchema,
  type CancelPurchaseOrderInput,
  type ClosePurchaseOrderInput,
  type CreatePurchaseOrderInput,
  type UpdatePurchaseOrderInput,
} from '@/lib/validation/purchasing';

const PO_SEQUENCE_NAME = 'purchase_order';
const PO_PREFIX = 'PO';

// ---------------------------------------------------------------------------
// Integrity utilities — exposed so receipts service and tests can call them.
// ---------------------------------------------------------------------------

// Recompute PurchaseOrderLine.qtyReceived from the SUM of non-deleted
// ReceiptLine.qtyReceived for receipts in {POSTED}. Self-heals if anything
// drifts. Defensively clamps at 0 if the sum returns negative (which would
// indicate a bug elsewhere) and logs a warning.
export async function recomputeQtyReceivedForPoLine(
  tx: Prisma.TransactionClient,
  poLineId: string,
): Promise<Prisma.Decimal> {
  const agg = await tx.receiptLine.aggregate({
    where: {
      purchaseOrderLineId: poLineId,
      deletedAt: null,
      receipt: { status: 'POSTED', deletedAt: null },
    },
    _sum: { qtyReceived: true },
  });
  let total = agg._sum.qtyReceived ?? new Prisma.Decimal(0);
  if (total.lessThan(0)) {
    console.warn(
      `recomputeQtyReceivedForPoLine: clamping negative sum to 0 for poLineId=${poLineId} sum=${total.toString()}`,
    );
    total = new Prisma.Decimal(0);
  }
  await tx.purchaseOrderLine.update({
    where: { id: poLineId },
    data: { qtyReceived: total },
  });
  return total;
}

// Pure derivation from current state. Honors terminal statuses (DRAFT stays
// DRAFT until confirm; CANCELLED is terminal).
export async function computePoStatus(
  tx: Prisma.TransactionClient,
  purchaseOrderId: string,
): Promise<PurchaseOrderStatus> {
  const po = await tx.purchaseOrder.findUnique({
    where: { id: purchaseOrderId },
    select: { status: true },
  });
  if (!po) throw new Error(`PurchaseOrder not found: ${purchaseOrderId}`);
  if (po.status === PurchaseOrderStatus.DRAFT) return PurchaseOrderStatus.DRAFT;
  if (po.status === PurchaseOrderStatus.CANCELLED) return PurchaseOrderStatus.CANCELLED;

  const lines = await tx.purchaseOrderLine.findMany({
    where: { purchaseOrderId, deletedAt: null },
    select: { qtyOrdered: true, qtyReceived: true },
  });

  if (lines.length === 0) return PurchaseOrderStatus.CONFIRMED;

  const totalOrdered = lines.reduce(
    (acc, l) => acc.plus(l.qtyOrdered),
    new Prisma.Decimal(0),
  );
  const totalReceived = lines.reduce(
    (acc, l) => acc.plus(l.qtyReceived),
    new Prisma.Decimal(0),
  );

  if (totalReceived.lessThanOrEqualTo(0)) return PurchaseOrderStatus.CONFIRMED;
  if (totalReceived.greaterThanOrEqualTo(totalOrdered)) {
    const everyLineMet = lines.every((l) =>
      l.qtyReceived.greaterThanOrEqualTo(l.qtyOrdered),
    );
    if (everyLineMet) return PurchaseOrderStatus.CLOSED;
  }
  return PurchaseOrderStatus.PARTIALLY_RECEIVED;
}

// Apply the recomputed status. Returns the previous + new status.
export async function applyComputedPoStatus(
  tx: Prisma.TransactionClient,
  purchaseOrderId: string,
  ctx?: AuditContext,
): Promise<{ previous: PurchaseOrderStatus; next: PurchaseOrderStatus; changed: boolean }> {
  const po = await tx.purchaseOrder.findUnique({ where: { id: purchaseOrderId } });
  if (!po) throw new Error(`PurchaseOrder not found: ${purchaseOrderId}`);

  const next = await computePoStatus(tx, purchaseOrderId);
  if (next === po.status) {
    return { previous: po.status, next, changed: false };
  }

  // Manual-close survival: when an operator manually closed the PO
  // with a reason (closeReason set), keep it CLOSED even if a
  // downstream receipt cancel would otherwise drop the received total
  // back to a partial state. The explicit operator intent outranks
  // the recomputed status; only the close-with-reason path can leave
  // CLOSED (and that's a separate, deliberate action).
  if (
    po.status === PurchaseOrderStatus.CLOSED &&
    po.closeReason != null &&
    next !== PurchaseOrderStatus.CLOSED
  ) {
    return { previous: po.status, next: po.status, changed: false };
  }

  const updateData: Prisma.PurchaseOrderUpdateInput = { status: next };
  if (next === PurchaseOrderStatus.CLOSED) updateData.closedAt = new Date();
  if (
    po.status === PurchaseOrderStatus.CLOSED &&
    next !== PurchaseOrderStatus.CLOSED
  ) {
    updateData.closedAt = null;
  }

  const updated = await tx.purchaseOrder.update({
    where: { id: purchaseOrderId },
    data: updateData,
  });
  await audit(tx, {
    action: AuditAction.STATUS_CHANGE,
    entityType: 'PurchaseOrder',
    entityId: purchaseOrderId,
    before: { status: po.status },
    after: { status: updated.status },
    ctx,
  });
  return { previous: po.status, next, changed: true };
}

// ---------------------------------------------------------------------------
// CRUD + lifecycle
// ---------------------------------------------------------------------------

export async function createPurchaseOrder(
  db: PrismaClient,
  input: CreatePurchaseOrderInput,
  ctx?: AuditContext,
): Promise<PurchaseOrder & { lines: PurchaseOrderLine[] }> {
  const data = createPurchaseOrderInputSchema.parse(input);
  return db.$transaction(async (tx) => {
    const seq = await getNextSequence(tx, {
      name: PO_SEQUENCE_NAME,
      prefix: PO_PREFIX,
      useYear: true,
    });
    const po = await tx.purchaseOrder.create({
      data: {
        number: seq.formatted,
        vendorId: data.vendorId,
        expectedReceiveDate: data.expectedReceiveDate,
        currency: data.currency ?? 'USD',
        notes: data.notes,
        createdById: data.createdById,
        lines: {
          create: data.lines.map((l) => ({
            variantId: l.variantId,
            warehouseId: l.warehouseId,
            qtyOrdered: new Prisma.Decimal(l.qtyOrdered),
            unitCost: new Prisma.Decimal(l.unitCost),
            vendorSku: l.vendorSku,
            manufacturerPartNumber: l.manufacturerPartNumber,
            notes: l.notes,
          })),
        },
      },
      include: { lines: true },
    });
    await audit(tx, {
      action: AuditAction.CREATE,
      entityType: 'PurchaseOrder',
      entityId: po.id,
      after: po,
      ctx: { userId: ctx?.userId ?? data.createdById ?? null, ipAddress: ctx?.ipAddress, reason: ctx?.reason },
    });
    return po;
  });
}

export async function updatePurchaseOrder(
  db: PrismaClient,
  id: string,
  input: UpdatePurchaseOrderInput,
  ctx?: AuditContext,
): Promise<PurchaseOrder & { lines: PurchaseOrderLine[] }> {
  const data = updatePurchaseOrderInputSchema.parse(input);
  return db.$transaction(async (tx) => {
    const before = await tx.purchaseOrder.findUnique({ where: { id }, include: { lines: true } });
    if (!before) throw new Error(`PurchaseOrder not found: ${id}`);
    if (before.status !== PurchaseOrderStatus.DRAFT) {
      throw new Error(`Cannot edit PurchaseOrder in status ${before.status}`);
    }

    const updateData: Prisma.PurchaseOrderUpdateInput = {};
    if ('expectedReceiveDate' in data) updateData.expectedReceiveDate = data.expectedReceiveDate ?? null;
    if (data.currency !== undefined) updateData.currency = data.currency;
    if ('notes' in data) updateData.notes = data.notes ?? null;

    if (data.lines) {
      // Wholesale replace lines (DRAFT only). Soft-delete existing, create new.
      await tx.purchaseOrderLine.deleteMany({ where: { purchaseOrderId: id } });
      for (const l of data.lines) {
        await tx.purchaseOrderLine.create({
          data: {
            purchaseOrderId: id,
            variantId: l.variantId,
            warehouseId: l.warehouseId,
            qtyOrdered: new Prisma.Decimal(l.qtyOrdered),
            unitCost: new Prisma.Decimal(l.unitCost),
            vendorSku: l.vendorSku,
            manufacturerPartNumber: l.manufacturerPartNumber,
            notes: l.notes,
          },
        });
      }
    }

    const after = await tx.purchaseOrder.update({
      where: { id },
      data: updateData,
      include: { lines: true },
    });
    await audit(tx, {
      action: AuditAction.UPDATE,
      entityType: 'PurchaseOrder',
      entityId: id,
      before,
      after,
      ctx,
    });
    return after;
  });
}

export async function confirmPurchaseOrder(
  db: PrismaClient,
  id: string,
  ctx?: AuditContext,
): Promise<PurchaseOrder> {
  return db.$transaction(async (tx) => {
    const before = await tx.purchaseOrder.findUnique({ where: { id } });
    if (!before) throw new Error(`PurchaseOrder not found: ${id}`);
    if (before.status !== PurchaseOrderStatus.DRAFT) {
      throw new Error(`Cannot confirm PurchaseOrder in status ${before.status}`);
    }
    const after = await tx.purchaseOrder.update({
      where: { id },
      data: { status: PurchaseOrderStatus.CONFIRMED, confirmedAt: new Date() },
    });
    await audit(tx, {
      action: AuditAction.STATUS_CHANGE,
      entityType: 'PurchaseOrder',
      entityId: id,
      before: { status: before.status },
      after: { status: after.status },
      ctx,
    });
    return after;
  });
}

/**
 * Manual close. Allowed on CONFIRMED + PARTIALLY_RECEIVED — both
 * states where some receipts may have already posted but no further
 * receipts are coming. Sets `closeReason` so applyComputedPoStatus
 * won't auto-revert if a downstream receipt cancel later changes the
 * received totals.
 *
 * Distinct from the auto-close path inside applyComputedPoStatus —
 * that path fires when every line is fully received and leaves
 * closeReason NULL. The two close paths share `status = CLOSED` and
 * `closedAt`, but only the manual path stores a reason.
 */
export async function closePurchaseOrder(
  db: PrismaClient,
  id: string,
  input: ClosePurchaseOrderInput,
  ctx?: AuditContext,
): Promise<PurchaseOrder> {
  const data = closePurchaseOrderInputSchema.parse(input);
  return db.$transaction(async (tx) => {
    const before = await tx.purchaseOrder.findUnique({ where: { id } });
    if (!before) throw new Error(`PurchaseOrder not found: ${id}`);
    if (
      before.status !== PurchaseOrderStatus.CONFIRMED &&
      before.status !== PurchaseOrderStatus.PARTIALLY_RECEIVED
    ) {
      throw new Error(
        `Cannot close PurchaseOrder in status ${before.status} — only CONFIRMED or PARTIALLY_RECEIVED can be manually closed`,
      );
    }

    const after = await tx.purchaseOrder.update({
      where: { id },
      data: {
        status: PurchaseOrderStatus.CLOSED,
        closedAt: new Date(),
        closeReason: data.reason,
      },
    });
    await audit(tx, {
      action: AuditAction.STATUS_CHANGE,
      entityType: 'PurchaseOrder',
      entityId: id,
      before: { status: before.status, closeReason: before.closeReason },
      after: { status: after.status, closeReason: after.closeReason },
      ctx: { ...ctx, reason: data.reason },
    });
    return after;
  });
}

export async function cancelPurchaseOrder(
  db: PrismaClient,
  id: string,
  input: CancelPurchaseOrderInput,
  ctx?: AuditContext,
): Promise<PurchaseOrder> {
  const data = cancelPurchaseOrderInputSchema.parse(input);
  return db.$transaction(async (tx) => {
    const before = await tx.purchaseOrder.findUnique({
      where: { id },
      include: {
        lines: { include: { receiptLines: { where: { deletedAt: null } } } },
      },
    });
    if (!before) throw new Error(`PurchaseOrder not found: ${id}`);
    if (before.status === PurchaseOrderStatus.CLOSED) {
      throw new Error('Cannot cancel a CLOSED PurchaseOrder');
    }
    if (before.status === PurchaseOrderStatus.CANCELLED) {
      throw new Error('PurchaseOrder is already CANCELLED');
    }
    const hasActiveReceiptLines = before.lines.some((l) => l.receiptLines.length > 0);
    if (hasActiveReceiptLines) {
      throw new Error('Cannot cancel PurchaseOrder with active receipt lines');
    }

    const after = await tx.purchaseOrder.update({
      where: { id },
      data: { status: PurchaseOrderStatus.CANCELLED, cancelledAt: new Date() },
    });
    await audit(tx, {
      action: AuditAction.STATUS_CHANGE,
      entityType: 'PurchaseOrder',
      entityId: id,
      before: { status: before.status },
      after: { status: after.status },
      ctx: { ...ctx, reason: data.reason ?? ctx?.reason ?? null },
    });
    return after;
  });
}

export async function softDeletePurchaseOrder(
  db: PrismaClient,
  id: string,
  ctx?: AuditContext,
): Promise<PurchaseOrder> {
  return db.$transaction(async (tx) => {
    const before = await tx.purchaseOrder.findUnique({ where: { id } });
    if (!before) throw new Error(`PurchaseOrder not found: ${id}`);
    if (before.deletedAt) throw new Error('PurchaseOrder is already soft-deleted');
    if (
      before.status !== PurchaseOrderStatus.DRAFT &&
      before.status !== PurchaseOrderStatus.CANCELLED
    ) {
      throw new Error(
        `Soft-delete only allowed for DRAFT or CANCELLED PurchaseOrders (got ${before.status})`,
      );
    }
    const after = await tx.purchaseOrder.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    await audit(tx, {
      action: AuditAction.DELETE,
      entityType: 'PurchaseOrder',
      entityId: id,
      before,
      after,
      ctx,
    });
    return after;
  });
}

export async function getPurchaseOrder(
  db: PrismaClient,
  id: string,
): Promise<(PurchaseOrder & { lines: PurchaseOrderLine[] }) | null> {
  return db.purchaseOrder.findFirst({
    where: { id, deletedAt: null },
    include: { lines: { where: { deletedAt: null } } },
  });
}

export async function listPurchaseOrders(
  db: PrismaClient,
  filters: { vendorId?: string; status?: PurchaseOrderStatus; skip?: number; take?: number } = {},
): Promise<(PurchaseOrder & { lines: PurchaseOrderLine[] })[]> {
  const { skip = 0, take = 100, vendorId, status } = filters;
  return db.purchaseOrder.findMany({
    where: {
      deletedAt: null,
      ...(vendorId ? { vendorId } : {}),
      ...(status ? { status } : {}),
    },
    include: { lines: { where: { deletedAt: null } } },
    orderBy: { createdAt: 'desc' },
    skip,
    take,
  });
}

export type PurchaseOrderListFilters = {
  vendorId?: string;
  status?: PurchaseOrderStatus;
  // Inclusive date range on PO createdAt (order date). dateTo is bumped
  // to end-of-day by the caller (page.tsx) so the range stays inclusive.
  dateFrom?: Date;
  dateTo?: Date;
  // Substring match on PO number (case-insensitive). Numbers look like
  // PO-2026-00001 so partial matches are useful.
  q?: string;
  skip?: number;
  take?: number;
};

function purchaseOrderWhere(
  filters: Omit<PurchaseOrderListFilters, 'skip' | 'take'>,
): Prisma.PurchaseOrderWhereInput {
  const { status, vendorId, dateFrom, dateTo, q } = filters;
  const dateClause: Prisma.DateTimeFilter | undefined =
    dateFrom || dateTo
      ? {
          ...(dateFrom ? { gte: dateFrom } : {}),
          ...(dateTo ? { lte: dateTo } : {}),
        }
      : undefined;
  return {
    deletedAt: null,
    ...(status ? { status } : {}),
    ...(vendorId ? { vendorId } : {}),
    ...(dateClause ? { createdAt: dateClause } : {}),
    ...(q ? { number: { contains: q, mode: 'insensitive' as const } } : {}),
  };
}

// Paginated list with vendor (id, code, name) eager-loaded so the table
// can render the vendor name without a second round-trip. Lines are
// also included so the page can compute the PO total per row (Σ qty ×
// unit cost). Same N+1-by-design pattern as the SO list.
export async function listPurchaseOrdersPaged(
  db: PrismaClient,
  filters: PurchaseOrderListFilters = {},
): Promise<{
  rows: Array<
    PurchaseOrder & {
      lines: PurchaseOrderLine[];
      vendor: { id: string; code: string; name: string };
    }
  >;
  total: number;
}> {
  const { skip = 0, take = 100, ...rest } = filters;
  const where = purchaseOrderWhere(rest);
  const [rows, total] = await Promise.all([
    db.purchaseOrder.findMany({
      where,
      include: {
        lines: { where: { deletedAt: null } },
        vendor: { select: { id: true, code: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    }),
    db.purchaseOrder.count({ where }),
  ]);
  return { rows, total };
}
