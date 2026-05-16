import { Prisma, AuditAction, PurchaseOrderStatus } from '@/generated/tenant';
import type { PrismaClient, PurchaseOrder, PurchaseOrderLine } from '@/generated/tenant';
import { audit, type AuditContext } from '@/lib/audit/audit';
import { getNextSequence } from '@/lib/sequences/sequences';
import {
  addPurchaseOrderLinesInputSchema,
  cancelPurchaseOrderInputSchema,
  closePurchaseOrderInputSchema,
  createPurchaseOrderInputSchema,
  reopenPurchaseOrderInputSchema,
  updatePurchaseOrderInputSchema,
  updatePurchaseOrderLineFieldsInputSchema,
  type AddPurchaseOrderLinesInput,
  type CancelPurchaseOrderInput,
  type ClosePurchaseOrderInput,
  type CreatePurchaseOrderInput,
  type ReopenPurchaseOrderInput,
  type UpdatePurchaseOrderInput,
  type UpdatePurchaseOrderLineFieldsInput,
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
    // Edits allowed on DRAFT, CONFIRMED, PARTIALLY_RECEIVED. CONFIRMED
    // is safe for the wholesale lines-replace because by definition no
    // receipts have posted (computePoStatus auto-flips to PARTIALLY_
    // RECEIVED on the first posted receipt). PARTIALLY_RECEIVED can
    // only edit header fields — replacing lines would FK-violate
    // against ReceiptLine.purchaseOrderLineId. CLOSED + CANCELLED
    // remain hard-rejected.
    if (
      before.status !== PurchaseOrderStatus.DRAFT &&
      before.status !== PurchaseOrderStatus.CONFIRMED &&
      before.status !== PurchaseOrderStatus.PARTIALLY_RECEIVED
    ) {
      throw new Error(`Cannot edit PurchaseOrder in status ${before.status}`);
    }

    const updateData: Prisma.PurchaseOrderUpdateInput = {};
    if ('expectedReceiveDate' in data) updateData.expectedReceiveDate = data.expectedReceiveDate ?? null;
    if (data.currency !== undefined) updateData.currency = data.currency;
    if ('notes' in data) updateData.notes = data.notes ?? null;

    if (data.lines) {
      if (before.status === PurchaseOrderStatus.PARTIALLY_RECEIVED) {
        // PR POs always have at least one line with receipts attached.
        // Wholesale delete would either FK-violate (ON DELETE RESTRICT)
        // or orphan ReceiptLine.purchaseOrderLineId. Per-line
        // edit-by-id is a separate slice; until then, header fields
        // are the editable surface and lines need cancel-and-recreate
        // or receipt reversal to change.
        throw new Error(
          'Cannot replace lines on a PartiallyReceived PurchaseOrder — edit header fields only. To change lines, reverse the receipts first or cancel-and-recreate the PO.',
        );
      }
      // Wholesale replace lines (DRAFT + CONFIRMED, where no receipts
      // exist). Soft-delete existing, create new.
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

/**
 * Manual reopen — reverse of closePurchaseOrder. Status gate: only
 * CLOSED. Reverts to PARTIALLY_RECEIVED when any non-deleted PO line
 * has qtyReceived > 0, else CONFIRMED. Clears closeReason + closedAt
 * so a subsequent close-and-reopen cycle is clean (and so the manual-
 * close sentinel that applyComputedPoStatus checks goes back to NULL).
 *
 * Pairs with closePurchaseOrder + the applyComputedPoStatus sentinel:
 * after reopen, receipt cancels go back to driving the status the
 * normal way. The auto-close path (every line fully received again)
 * still works as it did before the close.
 */
export async function reopenPurchaseOrder(
  db: PrismaClient,
  id: string,
  input: ReopenPurchaseOrderInput,
  ctx?: AuditContext,
): Promise<PurchaseOrder> {
  const data = reopenPurchaseOrderInputSchema.parse(input);
  return db.$transaction(async (tx) => {
    const before = await tx.purchaseOrder.findUnique({ where: { id } });
    if (!before) throw new Error(`PurchaseOrder not found: ${id}`);
    if (before.status !== PurchaseOrderStatus.CLOSED) {
      throw new Error(
        `Cannot reopen PurchaseOrder in status ${before.status} — only CLOSED can be reopened`,
      );
    }

    const lines = await tx.purchaseOrderLine.findMany({
      where: { purchaseOrderId: id, deletedAt: null },
      select: { qtyReceived: true },
    });
    const totalReceived = lines.reduce(
      (acc, l) => acc.plus(l.qtyReceived),
      new Prisma.Decimal(0),
    );
    const nextStatus = totalReceived.greaterThan(0)
      ? PurchaseOrderStatus.PARTIALLY_RECEIVED
      : PurchaseOrderStatus.CONFIRMED;

    const after = await tx.purchaseOrder.update({
      where: { id },
      data: {
        status: nextStatus,
        closedAt: null,
        closeReason: null,
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

/**
 * Inline per-field edit on a single PO line. Status gate: CONFIRMED +
 * PARTIALLY_RECEIVED. DRAFT continues to use the wholesale Edit form;
 * CLOSED + CANCELLED are rejected.
 *
 * qtyOrdered enforces a floor of qtyReceived — reducing below would
 * leave the line in a logical inconsistency (more received than
 * ordered).
 *
 * unitCost edits do NOT touch FIFO / already-posted ReceiptLines —
 * those snapshot the cost at receipt time. The PO line's unitCost is
 * a forward-looking hint that drives future receipt UI defaults +
 * reporting.
 *
 * After the update, applyComputedPoStatus is invoked so that lowering
 * qtyOrdered to exactly match qtyReceived on the last unfilled line
 * can auto-close the PO via the normal compute path.
 */
export async function updatePurchaseOrderLineFields(
  db: PrismaClient,
  purchaseOrderId: string,
  lineId: string,
  input: UpdatePurchaseOrderLineFieldsInput,
  ctx?: AuditContext,
): Promise<PurchaseOrderLine> {
  const data = updatePurchaseOrderLineFieldsInputSchema.parse(input);
  return db.$transaction(async (tx) => {
    const line = await tx.purchaseOrderLine.findUnique({
      where: { id: lineId },
      include: { purchaseOrder: true },
    });
    if (!line || line.deletedAt != null) {
      throw new Error(`PurchaseOrderLine not found: ${lineId}`);
    }
    if (line.purchaseOrder.id !== purchaseOrderId) {
      throw new Error(
        `Line ${lineId} does not belong to PurchaseOrder ${purchaseOrderId}`,
      );
    }
    if (
      line.purchaseOrder.status !== PurchaseOrderStatus.CONFIRMED &&
      line.purchaseOrder.status !== PurchaseOrderStatus.PARTIALLY_RECEIVED
    ) {
      throw new Error(
        `Cannot edit line fields while PurchaseOrder is in status ${line.purchaseOrder.status}`,
      );
    }

    const updateData: Prisma.PurchaseOrderLineUpdateInput = {};

    if (data.qtyOrdered !== undefined) {
      const next = new Prisma.Decimal(data.qtyOrdered);
      if (next.lessThan(line.qtyReceived)) {
        throw new Error(
          `Cannot reduce qtyOrdered (${next.toString()}) below qtyReceived (${line.qtyReceived.toString()}) — receive history would be inconsistent`,
        );
      }
      if (!next.equals(line.qtyOrdered)) {
        updateData.qtyOrdered = next;
      }
    }
    if (data.unitCost !== undefined) {
      const next = new Prisma.Decimal(data.unitCost);
      if (!next.equals(line.unitCost)) {
        updateData.unitCost = next;
      }
    }
    if (data.vendorSku !== undefined) {
      updateData.vendorSku = data.vendorSku;
    }
    if (data.manufacturerPartNumber !== undefined) {
      updateData.manufacturerPartNumber = data.manufacturerPartNumber;
    }
    if (data.notes !== undefined) {
      updateData.notes = data.notes;
    }

    if (Object.keys(updateData).length === 0) {
      // No-op edit (operator typed the same value back) — return
      // existing line without an audit row. The validator already
      // enforces a non-empty payload.
      return line;
    }

    const before = {
      qtyOrdered: line.qtyOrdered,
      unitCost: line.unitCost,
      vendorSku: line.vendorSku,
      manufacturerPartNumber: line.manufacturerPartNumber,
      notes: line.notes,
    };

    const after = await tx.purchaseOrderLine.update({
      where: { id: lineId },
      data: updateData,
    });

    await audit(tx, {
      action: AuditAction.UPDATE,
      entityType: 'PurchaseOrderLine',
      entityId: lineId,
      before,
      after: {
        qtyOrdered: after.qtyOrdered,
        unitCost: after.unitCost,
        vendorSku: after.vendorSku,
        manufacturerPartNumber: after.manufacturerPartNumber,
        notes: after.notes,
      },
      ctx,
    });

    // qtyOrdered changes can push the PO across the auto-close
    // threshold (every line fully received). Run the same recompute
    // hook receipts use, so the state stays consistent.
    if (updateData.qtyOrdered !== undefined) {
      await applyComputedPoStatus(tx, purchaseOrderId);
    }

    return after;
  });
}

/**
 * Add one or more lines to an existing PO. Status gate: CONFIRMED +
 * PARTIALLY_RECEIVED. DRAFT continues to use the wholesale Edit form
 * (which already supports adding lines via the lines-replace path);
 * CLOSED + CANCELLED are rejected.
 *
 * New lines start at qtyReceived = 0 (schema default). No status flip
 * needed: adding unreceived lines to CONFIRMED stays CONFIRMED, and
 * adding to PARTIALLY_RECEIVED stays PARTIALLY_RECEIVED. The
 * computePoStatus formula handles both cases (more lines to receive
 * keeps the PO in its current pre-close state).
 */
export async function addPurchaseOrderLines(
  db: PrismaClient,
  purchaseOrderId: string,
  input: AddPurchaseOrderLinesInput,
  ctx?: AuditContext,
): Promise<PurchaseOrder & { lines: PurchaseOrderLine[] }> {
  const data = addPurchaseOrderLinesInputSchema.parse(input);
  return db.$transaction(async (tx) => {
    const before = await tx.purchaseOrder.findUnique({
      where: { id: purchaseOrderId },
      include: { lines: { where: { deletedAt: null } } },
    });
    if (!before) {
      throw new Error(`PurchaseOrder not found: ${purchaseOrderId}`);
    }
    if (
      before.status !== PurchaseOrderStatus.CONFIRMED &&
      before.status !== PurchaseOrderStatus.PARTIALLY_RECEIVED
    ) {
      throw new Error(
        `Cannot add lines to PurchaseOrder in status ${before.status} — only CONFIRMED or PARTIALLY_RECEIVED`,
      );
    }

    const createdLines: { id: string }[] = [];
    for (const l of data.lines) {
      const created = await tx.purchaseOrderLine.create({
        data: {
          purchaseOrderId,
          variantId: l.variantId,
          warehouseId: l.warehouseId,
          qtyOrdered: new Prisma.Decimal(l.qtyOrdered),
          unitCost: new Prisma.Decimal(l.unitCost),
          vendorSku: l.vendorSku,
          manufacturerPartNumber: l.manufacturerPartNumber,
          notes: l.notes,
        },
      });
      createdLines.push({ id: created.id });
    }

    const after = await tx.purchaseOrder.findUniqueOrThrow({
      where: { id: purchaseOrderId },
      include: { lines: { where: { deletedAt: null } } },
    });

    await audit(tx, {
      action: AuditAction.UPDATE,
      entityType: 'PurchaseOrder',
      entityId: purchaseOrderId,
      before: { lineCount: before.lines.length },
      after: {
        lineCount: after.lines.length,
        addedLineIds: createdLines.map((l) => l.id),
      },
      ctx,
    });

    return after;
  });
}
