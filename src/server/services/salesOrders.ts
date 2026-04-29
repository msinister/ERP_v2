import { Prisma, AuditAction, SalesOrderStatus } from '@/generated/tenant';
import type {
  PrismaClient,
  SalesOrder,
  SalesOrderLine,
} from '@/generated/tenant';
import { audit, type AuditContext } from '@/lib/audit/audit';
import { getNextSequence } from '@/lib/sequences/sequences';
import { resolvePrice } from '@/lib/pricing/resolve';
import { lockBin } from '@/server/services/locks';
import { consumeInventoryTx } from '@/server/services/movements';
import {
  cancelSalesOrderInputSchema,
  closeSalesOrderInputSchema,
  createSalesOrderInputSchema,
  updateSalesOrderInputSchema,
  type CancelSalesOrderInput,
  type CloseSalesOrderInput,
  type CreateSalesOrderInput,
  type UpdateSalesOrderInput,
} from '@/lib/validation/sales';

const SO_SEQUENCE_NAME = 'sales_order';
const SO_PREFIX = 'SO';

type SalesOrderWithLines = SalesOrder & { lines: SalesOrderLine[] };

// ---------------------------------------------------------------------------
// Reservation integrity utilities — exposed for tests and any future RMA
// path. Reserved is a denormalized counter on InventoryItem; the source of
// truth is SUM(SalesOrderLine.qtyReserved) over un-deleted lines whose
// parent SO is in {CONFIRMED, DISPATCHED}. Self-heals via recompute, same
// pattern as recomputeQtyReceivedForPoLine on the PO side.
// ---------------------------------------------------------------------------

export async function recomputeReservedForBin(
  tx: Prisma.TransactionClient,
  variantId: string,
  warehouseId: string,
): Promise<Prisma.Decimal> {
  const agg = await tx.salesOrderLine.aggregate({
    where: {
      variantId,
      warehouseId,
      deletedAt: null,
      salesOrder: {
        deletedAt: null,
        status: { in: [SalesOrderStatus.CONFIRMED, SalesOrderStatus.DISPATCHED] },
      },
    },
    _sum: { qtyReserved: true },
  });
  let total = agg._sum.qtyReserved ?? new Prisma.Decimal(0);
  if (total.lessThan(0)) {
    console.warn(
      `recomputeReservedForBin: clamping negative sum to 0 for variantId=${variantId} warehouseId=${warehouseId} sum=${total.toString()}`,
    );
    total = new Prisma.Decimal(0);
  }
  await tx.inventoryItem.upsert({
    where: { variantId_warehouseId: { variantId, warehouseId } },
    create: { variantId, warehouseId, reserved: total },
    update: { reserved: total },
  });
  return total;
}

// ---------------------------------------------------------------------------
// CRUD + lifecycle
// ---------------------------------------------------------------------------

export async function createSalesOrder(
  db: PrismaClient,
  input: CreateSalesOrderInput,
  ctx?: AuditContext,
): Promise<SalesOrderWithLines> {
  const data = createSalesOrderInputSchema.parse(input);
  return db.$transaction(async (tx) => {
    const seq = await getNextSequence(tx, {
      name: SO_SEQUENCE_NAME,
      prefix: SO_PREFIX,
      useYear: true,
    });

    // Resolve every line's unit price through the pricing resolver. Never
    // bypass — see CLAUDE.md non-negotiable rules.
    const resolvedLines = [];
    for (const l of data.lines) {
      const resolved = await resolvePrice(tx, {
        variantId: l.variantId,
        customerId: data.customerId,
        qty: new Prisma.Decimal(l.qtyOrdered),
        manualUnitPrice:
          l.manualUnitPrice != null ? new Prisma.Decimal(l.manualUnitPrice) : null,
      });
      resolvedLines.push({
        variantId: l.variantId,
        warehouseId: l.warehouseId,
        qtyOrdered: new Prisma.Decimal(l.qtyOrdered),
        unitPrice: resolved.unitPrice,
        priceRule: resolved.rule,
        discountPercent:
          l.discountPercent != null ? new Prisma.Decimal(l.discountPercent) : null,
        discountAmount:
          l.discountAmount != null ? new Prisma.Decimal(l.discountAmount) : null,
        customerNote: l.customerNote ?? null,
        internalNote: l.internalNote ?? null,
      });
    }

    const so = await tx.salesOrder.create({
      data: {
        number: seq.formatted,
        customerId: data.customerId,
        warehouseId: data.warehouseId,
        source: data.source ?? 'STAFF',
        currency: data.currency ?? 'USD',
        customerPo: data.customerPo,
        promisedShipDate: data.promisedShipDate,
        orderDate: data.orderDate ?? new Date(),
        orderDiscountPercent:
          data.orderDiscountPercent != null
            ? new Prisma.Decimal(data.orderDiscountPercent)
            : null,
        orderDiscountAmount:
          data.orderDiscountAmount != null
            ? new Prisma.Decimal(data.orderDiscountAmount)
            : null,
        shippingAmount:
          data.shippingAmount != null ? new Prisma.Decimal(data.shippingAmount) : null,
        handlingAmount:
          data.handlingAmount != null ? new Prisma.Decimal(data.handlingAmount) : null,
        shippingAddress: data.shippingAddress,
        customerNotes: data.customerNotes,
        internalNotes: data.internalNotes,
        createdById: data.createdById,
        lines: { create: resolvedLines },
      },
      include: { lines: true },
    });

    await audit(tx, {
      action: AuditAction.CREATE,
      entityType: 'SalesOrder',
      entityId: so.id,
      after: so,
      ctx: {
        userId: ctx?.userId ?? data.createdById ?? null,
        ipAddress: ctx?.ipAddress,
        reason: ctx?.reason,
      },
    });
    return so;
  });
}

export async function updateSalesOrder(
  db: PrismaClient,
  id: string,
  input: UpdateSalesOrderInput,
  ctx?: AuditContext,
): Promise<SalesOrderWithLines> {
  const data = updateSalesOrderInputSchema.parse(input);
  return db.$transaction(async (tx) => {
    const before = await tx.salesOrder.findUnique({
      where: { id },
      include: { lines: true },
    });
    if (!before) throw new Error(`SalesOrder not found: ${id}`);
    if (before.status !== SalesOrderStatus.DRAFT) {
      // Pilot stance: edit-after-Confirmed is deferred. Cancellation +
      // re-create is the documented escape hatch.
      throw new Error(
        `Cannot edit a sales order in ${before.status} status. Cancel the order and create a new one, or wait for an edit-after-confirm workflow in a future release.`,
      );
    }

    const updateData: Prisma.SalesOrderUpdateInput = {};
    if (data.warehouseId !== undefined) {
      updateData.warehouse = { connect: { id: data.warehouseId } };
    }
    if (data.currency !== undefined) updateData.currency = data.currency;
    if ('customerPo' in data) updateData.customerPo = data.customerPo ?? null;
    if ('promisedShipDate' in data)
      updateData.promisedShipDate = data.promisedShipDate ?? null;
    if (data.orderDate !== undefined) updateData.orderDate = data.orderDate;
    if ('orderDiscountPercent' in data)
      updateData.orderDiscountPercent =
        data.orderDiscountPercent != null
          ? new Prisma.Decimal(data.orderDiscountPercent)
          : null;
    if ('orderDiscountAmount' in data)
      updateData.orderDiscountAmount =
        data.orderDiscountAmount != null
          ? new Prisma.Decimal(data.orderDiscountAmount)
          : null;
    if ('shippingAmount' in data)
      updateData.shippingAmount =
        data.shippingAmount != null ? new Prisma.Decimal(data.shippingAmount) : null;
    if ('handlingAmount' in data)
      updateData.handlingAmount =
        data.handlingAmount != null ? new Prisma.Decimal(data.handlingAmount) : null;
    if ('shippingAddress' in data) updateData.shippingAddress = data.shippingAddress ?? null;
    if ('customerNotes' in data) updateData.customerNotes = data.customerNotes ?? null;
    if ('internalNotes' in data) updateData.internalNotes = data.internalNotes ?? null;

    if (data.lines) {
      // DRAFT-only wholesale replace. Resolve each line's price afresh.
      await tx.salesOrderLine.deleteMany({ where: { salesOrderId: id } });
      for (const l of data.lines) {
        const resolved = await resolvePrice(tx, {
          variantId: l.variantId,
          customerId: before.customerId,
          qty: new Prisma.Decimal(l.qtyOrdered),
          manualUnitPrice:
            l.manualUnitPrice != null ? new Prisma.Decimal(l.manualUnitPrice) : null,
        });
        await tx.salesOrderLine.create({
          data: {
            salesOrderId: id,
            variantId: l.variantId,
            warehouseId: l.warehouseId,
            qtyOrdered: new Prisma.Decimal(l.qtyOrdered),
            unitPrice: resolved.unitPrice,
            priceRule: resolved.rule,
            discountPercent:
              l.discountPercent != null ? new Prisma.Decimal(l.discountPercent) : null,
            discountAmount:
              l.discountAmount != null ? new Prisma.Decimal(l.discountAmount) : null,
            customerNote: l.customerNote ?? null,
            internalNote: l.internalNote ?? null,
          },
        });
      }
    }

    const after = await tx.salesOrder.update({
      where: { id },
      data: updateData,
      include: { lines: true },
    });
    await audit(tx, {
      action: AuditAction.UPDATE,
      entityType: 'SalesOrder',
      entityId: id,
      before,
      after,
      ctx,
    });
    return after;
  });
}

export async function confirmSalesOrder(
  db: PrismaClient,
  id: string,
  ctx?: AuditContext,
): Promise<SalesOrderWithLines> {
  return db.$transaction(async (tx) => {
    const before = await tx.salesOrder.findUnique({
      where: { id },
      include: { lines: { where: { deletedAt: null } } },
    });
    if (!before) throw new Error(`SalesOrder not found: ${id}`);
    if (before.status !== SalesOrderStatus.DRAFT) {
      throw new Error(`Cannot confirm SalesOrder in status ${before.status}`);
    }
    if (before.lines.length === 0) {
      throw new Error('Cannot confirm a SalesOrder with no lines');
    }

    // Lock every distinct (variant, warehouse) bin in deterministic order.
    // Single-warehouse SOs in pilot still land here so the multi-warehouse
    // future path Just Works once line.warehouseId starts varying.
    const bins = uniqueBins(before.lines);
    for (const b of bins) {
      await lockBin(tx, b.variantId, b.warehouseId);
    }

    // Set qtyReserved = qtyOrdered on each line, then recompute the
    // denormalized InventoryItem.reserved counter per touched bin.
    for (const line of before.lines) {
      await tx.salesOrderLine.update({
        where: { id: line.id },
        data: { qtyReserved: line.qtyOrdered },
      });
    }

    // Flip status BEFORE recomputeReservedForBin runs — the recompute filters
    // on parent SO status IN (CONFIRMED, DISPATCHED), so the new reservations
    // need to be visible.
    const after = await tx.salesOrder.update({
      where: { id },
      data: { status: SalesOrderStatus.CONFIRMED, confirmedAt: new Date() },
      include: { lines: true },
    });

    for (const b of bins) {
      await recomputeReservedForBin(tx, b.variantId, b.warehouseId);
    }

    await audit(tx, {
      action: AuditAction.STATUS_CHANGE,
      entityType: 'SalesOrder',
      entityId: id,
      before: { status: before.status },
      after: { status: after.status },
      ctx,
    });
    return after;
  });
}

export async function dispatchSalesOrder(
  db: PrismaClient,
  id: string,
  ctx?: AuditContext,
): Promise<SalesOrder> {
  return db.$transaction(async (tx) => {
    const before = await tx.salesOrder.findUnique({ where: { id } });
    if (!before) throw new Error(`SalesOrder not found: ${id}`);
    if (before.status !== SalesOrderStatus.CONFIRMED) {
      throw new Error(`Cannot dispatch SalesOrder in status ${before.status}`);
    }
    const after = await tx.salesOrder.update({
      where: { id },
      data: { status: SalesOrderStatus.DISPATCHED, dispatchedAt: new Date() },
    });
    await audit(tx, {
      action: AuditAction.STATUS_CHANGE,
      entityType: 'SalesOrder',
      entityId: id,
      before: { status: before.status },
      after: { status: after.status },
      ctx,
    });
    return after;
  });
}

export async function closeSalesOrder(
  db: PrismaClient,
  id: string,
  input: CloseSalesOrderInput | undefined,
  ctx?: AuditContext,
): Promise<SalesOrderWithLines> {
  const data = closeSalesOrderInputSchema.parse(input ?? {});
  return db.$transaction(async (tx) => {
    const before = await tx.salesOrder.findUnique({
      where: { id },
      include: { lines: { where: { deletedAt: null } } },
    });
    if (!before) throw new Error(`SalesOrder not found: ${id}`);
    // Pickup orders skip DISPATCHED — accept both as legal source statuses.
    // See docs/05-sales-orders.md "Pickup orders skip Dispatched".
    if (
      before.status !== SalesOrderStatus.CONFIRMED &&
      before.status !== SalesOrderStatus.DISPATCHED
    ) {
      throw new Error(`Cannot close SalesOrder in status ${before.status}`);
    }
    if (before.lines.length === 0) {
      throw new Error('Cannot close a SalesOrder with no lines');
    }

    const bins = uniqueBins(before.lines);
    for (const b of bins) {
      await lockBin(tx, b.variantId, b.warehouseId);
    }

    // Consume each line. consumeInventoryTx already handles its own audit
    // row for the movement, the per-bin lock (no-op since we re-take it),
    // and the strict insufficient-stock guard. We catch that specific error
    // and emit an INSUFFICIENT_STOCK_AT_CLOSE audit row before re-throwing,
    // so we get visibility into how often the spec's "warn-not-block" path
    // would have fired. Loosening later = changing this catch to a warn.
    for (const line of before.lines) {
      try {
        await consumeInventoryTx(
          tx,
          {
            variantId: line.variantId,
            warehouseId: line.warehouseId,
            qty: line.qtyOrdered.toString(),
            reference: before.number,
            createdById: ctx?.userId ?? undefined,
          },
          ctx,
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.startsWith('Insufficient stock')) {
          await audit(tx, {
            action: AuditAction.INSUFFICIENT_STOCK_AT_CLOSE,
            entityType: 'SalesOrder',
            entityId: id,
            after: {
              salesOrderNumber: before.number,
              salesOrderLineId: line.id,
              variantId: line.variantId,
              warehouseId: line.warehouseId,
              qtyRequested: line.qtyOrdered.toString(),
              error: msg,
            },
            ctx,
          });
        }
        throw e;
      }

      await tx.salesOrderLine.update({
        where: { id: line.id },
        data: { qtyShipped: line.qtyOrdered, qtyReserved: new Prisma.Decimal(0) },
      });
    }

    // Apply optional shipping/handling overrides supplied at close.
    const updateData: Prisma.SalesOrderUpdateInput = {
      status: SalesOrderStatus.CLOSED,
      closedAt: new Date(),
    };
    if (data.shippingAmount !== undefined) {
      updateData.shippingAmount = new Prisma.Decimal(data.shippingAmount);
    }
    if (data.handlingAmount !== undefined) {
      updateData.handlingAmount = new Prisma.Decimal(data.handlingAmount);
    }

    const after = await tx.salesOrder.update({
      where: { id },
      data: updateData,
      include: { lines: true },
    });

    // Recompute reserved per bin AFTER status flip so the new CLOSED status
    // (which is excluded from the reservation roll-up) is reflected.
    for (const b of bins) {
      await recomputeReservedForBin(tx, b.variantId, b.warehouseId);
    }

    await audit(tx, {
      action: AuditAction.STATUS_CHANGE,
      entityType: 'SalesOrder',
      entityId: id,
      before: { status: before.status },
      after: { status: after.status },
      ctx,
    });
    return after;
  });
}

export async function cancelSalesOrder(
  db: PrismaClient,
  id: string,
  input: CancelSalesOrderInput,
  ctx?: AuditContext,
): Promise<SalesOrderWithLines> {
  const data = cancelSalesOrderInputSchema.parse(input);
  return db.$transaction(async (tx) => {
    const before = await tx.salesOrder.findUnique({
      where: { id },
      include: { lines: { where: { deletedAt: null } } },
    });
    if (!before) throw new Error(`SalesOrder not found: ${id}`);
    if (before.status === SalesOrderStatus.CLOSED) {
      throw new Error(
        'Cannot cancel a CLOSED SalesOrder — use the RMA/Returns workflow instead',
      );
    }
    if (before.status === SalesOrderStatus.CANCELLED) {
      throw new Error('SalesOrder is already CANCELLED');
    }

    const wasReserved =
      before.status === SalesOrderStatus.CONFIRMED ||
      before.status === SalesOrderStatus.DISPATCHED;

    const bins = wasReserved ? uniqueBins(before.lines) : [];
    for (const b of bins) {
      await lockBin(tx, b.variantId, b.warehouseId);
    }

    if (wasReserved) {
      for (const line of before.lines) {
        await tx.salesOrderLine.update({
          where: { id: line.id },
          data: { qtyReserved: new Prisma.Decimal(0) },
        });
      }
    }

    const after = await tx.salesOrder.update({
      where: { id },
      data: {
        status: SalesOrderStatus.CANCELLED,
        cancelledAt: new Date(),
        cancelReason: data.reason,
      },
      include: { lines: true },
    });

    // After flip, the SO is excluded from the reservation roll-up.
    for (const b of bins) {
      await recomputeReservedForBin(tx, b.variantId, b.warehouseId);
    }

    await audit(tx, {
      action: AuditAction.STATUS_CHANGE,
      entityType: 'SalesOrder',
      entityId: id,
      before: { status: before.status },
      after: { status: after.status },
      ctx: { ...ctx, reason: data.reason },
    });
    return after;
  });
}

export async function softDeleteSalesOrder(
  db: PrismaClient,
  id: string,
  ctx?: AuditContext,
): Promise<SalesOrder> {
  return db.$transaction(async (tx) => {
    const before = await tx.salesOrder.findUnique({ where: { id } });
    if (!before) throw new Error(`SalesOrder not found: ${id}`);
    if (before.deletedAt) throw new Error('SalesOrder is already soft-deleted');
    if (
      before.status !== SalesOrderStatus.DRAFT &&
      before.status !== SalesOrderStatus.CANCELLED
    ) {
      throw new Error(
        `Soft-delete only allowed for DRAFT or CANCELLED SalesOrders (got ${before.status})`,
      );
    }
    const after = await tx.salesOrder.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    await audit(tx, {
      action: AuditAction.DELETE,
      entityType: 'SalesOrder',
      entityId: id,
      before,
      after,
      ctx,
    });
    return after;
  });
}

export async function getSalesOrder(
  db: PrismaClient,
  id: string,
): Promise<SalesOrderWithLines | null> {
  return db.salesOrder.findFirst({
    where: { id, deletedAt: null },
    include: { lines: { where: { deletedAt: null } } },
  });
}

export async function listSalesOrders(
  db: PrismaClient,
  filters: {
    customerId?: string;
    status?: SalesOrderStatus;
    skip?: number;
    take?: number;
  } = {},
): Promise<SalesOrderWithLines[]> {
  const { skip = 0, take = 100, customerId, status } = filters;
  return db.salesOrder.findMany({
    where: {
      deletedAt: null,
      ...(customerId ? { customerId } : {}),
      ...(status ? { status } : {}),
    },
    include: { lines: { where: { deletedAt: null } } },
    orderBy: { createdAt: 'desc' },
    skip,
    take,
  });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

// Sort by (variantId, warehouseId) so concurrent confirms/closes against
// overlapping bins acquire locks in the same order — no deadlocks.
function uniqueBins(
  lines: ReadonlyArray<{ variantId: string; warehouseId: string }>,
): { variantId: string; warehouseId: string }[] {
  const seen = new Set<string>();
  const out: { variantId: string; warehouseId: string }[] = [];
  for (const l of lines) {
    const k = `${l.variantId}\x00${l.warehouseId}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push({ variantId: l.variantId, warehouseId: l.warehouseId });
    }
  }
  out.sort((a, b) => {
    if (a.variantId !== b.variantId) return a.variantId < b.variantId ? -1 : 1;
    return a.warehouseId < b.warehouseId ? -1 : a.warehouseId > b.warehouseId ? 1 : 0;
  });
  return out;
}
