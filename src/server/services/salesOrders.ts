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
import { generateInvoiceForClosedSOTx } from '@/server/services/invoices';
import { postCogsForInvoiceTx } from '@/server/services/cogsPosting';
import { arBalanceForCustomer, agingForCustomer } from '@/server/services/ar';
import {
  computeSalesOrderTotal,
  getOpenSosNotInvoicedTotal,
} from '@/lib/ar/openSos';
import {
  ArHoldExceededError,
  CreditLimitExceededError,
  SalesOrderCancelBlockedError,
} from '@/lib/errors/credit';
import {
  cancelSalesOrderInputSchema,
  closeSalesOrderInputSchema,
  createSalesOrderInputSchema,
  updateSalesOrderInputSchema,
  updateSalesOrderLineQtyShippedInputSchema,
  type CancelSalesOrderInput,
  type CloseSalesOrderInput,
  type CreateSalesOrderInput,
  type UpdateSalesOrderInput,
  type UpdateSalesOrderLineQtyShippedInput,
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
      // Operator-supplied discountPercent / discountAmount always win.
      // Tier-discount pre-fill (resolved.discountPercent) only applies
      // when the operator left BOTH discount fields blank. No stacking.
      const operatorSetDiscount =
        l.discountPercent != null || l.discountAmount != null;
      const effectiveDiscountPercent = operatorSetDiscount
        ? l.discountPercent != null
          ? new Prisma.Decimal(l.discountPercent)
          : null
        : resolved.discountPercent;
      const effectiveDiscountAmount =
        l.discountAmount != null ? new Prisma.Decimal(l.discountAmount) : null;
      resolvedLines.push({
        variantId: l.variantId,
        warehouseId: l.warehouseId,
        qtyOrdered: new Prisma.Decimal(l.qtyOrdered),
        unitPrice: resolved.unitPrice,
        priceRule: resolved.rule,
        discountPercent: effectiveDiscountPercent,
        discountAmount: effectiveDiscountAmount,
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
        const operatorSetDiscount =
          l.discountPercent != null || l.discountAmount != null;
        const effectiveDiscountPercent = operatorSetDiscount
          ? l.discountPercent != null
            ? new Prisma.Decimal(l.discountPercent)
            : null
          : resolved.discountPercent;
        const effectiveDiscountAmount =
          l.discountAmount != null ? new Prisma.Decimal(l.discountAmount) : null;
        await tx.salesOrderLine.create({
          data: {
            salesOrderId: id,
            variantId: l.variantId,
            warehouseId: l.warehouseId,
            qtyOrdered: new Prisma.Decimal(l.qtyOrdered),
            unitPrice: resolved.unitPrice,
            priceRule: resolved.rule,
            discountPercent: effectiveDiscountPercent,
            discountAmount: effectiveDiscountAmount,
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

    // Credit-limit + AR-hold enforcement. Both gates run before any
    // inventory state change; bin locks are acquired only after they
    // pass. Manager-override path waits for RBAC (Module 01); pilot
    // always blocks. Errors are typed so the GUI can render an
    // actionable banner without re-querying.
    await enforceCreditAndArHold(tx, {
      salesOrderId: id,
      customerId: before.customerId,
      orderTotal: computeSalesOrderTotal(before),
    });

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

  // If the close fails because of insufficient stock, the inner tx rolls
  // back — we write this audit row AFTER the rollback (against the outer
  // db client) so the visibility signal survives. Spec: strict guard for
  // pilot, but we want to know how often we'd hit "warn-not-block" later.
  let pendingInsufficientAudit: {
    salesOrderNumber: string;
    salesOrderLineId: string;
    variantId: string;
    warehouseId: string;
    qtyRequested: string;
    error: string;
  } | null = null;

  try {
    return await db.$transaction(async (tx) => {
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

      // Resolve qtyShipped per line. When the caller supplies lines, each
      // entry must reference a real line on THIS SO, no duplicates, and
      // qtyShipped ≤ qtyOrdered. Lines not in the payload default to
      // full qtyOrdered — matches the historical "ship everything"
      // behavior.
      const qtyShippedByLineId = new Map<string, Prisma.Decimal>();
      if (data.lines && data.lines.length > 0) {
        const validIds = new Set(before.lines.map((l) => l.id));
        const qtyOrderedById = new Map(
          before.lines.map((l) => [l.id, l.qtyOrdered]),
        );
        const seen = new Set<string>();
        for (const inputLine of data.lines) {
          if (!validIds.has(inputLine.id)) {
            throw new Error(
              `close(): line id ${inputLine.id} does not belong to SalesOrder ${id}`,
            );
          }
          if (seen.has(inputLine.id)) {
            throw new Error(
              `close(): duplicate line id ${inputLine.id} in close payload`,
            );
          }
          seen.add(inputLine.id);
          const qtyShipped = new Prisma.Decimal(inputLine.qtyShipped);
          const qtyOrdered = qtyOrderedById.get(inputLine.id)!;
          if (qtyShipped.greaterThan(qtyOrdered)) {
            throw new Error(
              `close(): qtyShipped (${qtyShipped}) exceeds qtyOrdered (${qtyOrdered}) on line ${inputLine.id}`,
            );
          }
          qtyShippedByLineId.set(inputLine.id, qtyShipped);
        }
      }

      const bins = uniqueBins(before.lines);
      for (const b of bins) {
        await lockBin(tx, b.variantId, b.warehouseId);
      }

      for (const line of before.lines) {
        // Fallback chain for the effective shipped qty:
        //   1. explicit close-dialog override (still supported on the
        //      service contract for scripts / future flows)
        //   2. inline-saved SOL.qtyShipped from the editable column on
        //      the detail page (warehouse fills this in while the SO
        //      is CONFIRMED / DISPATCHED) — only if > 0, since the
        //      column defaults to 0 and 0 here means "operator never
        //      touched it"
        //   3. qtyOrdered — historical full-ship default for SOs
        //      created before the inline-shipped column existed
        const qtyToShip =
          qtyShippedByLineId.get(line.id) ??
          (line.qtyShipped.greaterThan(0)
            ? line.qtyShipped
            : line.qtyOrdered);
        let movementId: string;
        try {
          const movement = await consumeInventoryTx(
            tx,
            {
              variantId: line.variantId,
              warehouseId: line.warehouseId,
              qty: qtyToShip.toString(),
              reference: before.number,
              createdById: ctx?.userId ?? undefined,
            },
            ctx,
          );
          movementId = movement.id;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (msg.startsWith('Insufficient stock')) {
            pendingInsufficientAudit = {
              salesOrderNumber: before.number,
              salesOrderLineId: line.id,
              variantId: line.variantId,
              warehouseId: line.warehouseId,
              qtyRequested: qtyToShip.toString(),
              error: msg,
            };
          }
          throw e;
        }

        await tx.salesOrderLine.update({
          where: { id: line.id },
          data: {
            qtyShipped: qtyToShip,
            qtyReserved: new Prisma.Decimal(0),
            inventoryMovementId: movementId,
          },
        });
      }

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

      // Auto-invoice generation. Same transaction as the close, so
      // either both succeed or both roll back. Idempotent against
      // re-call (existing invoice for the SO is returned without
      // throwing).
      const invoice = await generateInvoiceForClosedSOTx(tx, id, ctx);

      // Part 3 of the costing engine slice: COGS posting. Walks the
      // CONSUME movements created above (linked to SOLines via the
      // inventoryMovementId we just stamped) and posts DR 5100 COGS /
      // CR <warehouse.inventoryAccount>. Idempotent — re-runs see
      // Invoice.cogsPosted=true and short-circuit. Zero-COGS invoices
      // (drop-ship/service-only) flip the flag and skip the JE.
      await postCogsForInvoiceTx(tx, invoice.id, ctx);

      return after;
    });
  } catch (e) {
    if (pendingInsufficientAudit) {
      // Outer-db write so the audit row survives the inner rollback.
      await audit(db, {
        action: AuditAction.INSUFFICIENT_STOCK_AT_CLOSE,
        entityType: 'SalesOrder',
        entityId: id,
        after: pendingInsufficientAudit,
        ctx,
      });
    }
    throw e;
  }
}

/**
 * Inline qtyShipped editor — warehouse records what actually shipped
 * per line before clicking Close. Available on CONFIRMED + DISPATCHED;
 * other statuses are read-only (pre-CONFIRMED nothing has shipped;
 * post-CLOSED the value is frozen because the invoice has been
 * generated and inventory consumed).
 *
 * Validates 0 < qtyShipped ≤ line.qtyOrdered. closeSalesOrder later
 * uses the saved value as its default when its `lines` payload is
 * absent — see the fallback chain comment in closeSalesOrder.
 */
export async function updateSalesOrderLineQtyShipped(
  db: PrismaClient,
  salesOrderId: string,
  lineId: string,
  input: UpdateSalesOrderLineQtyShippedInput,
  ctx?: AuditContext,
): Promise<SalesOrderLine> {
  const data = updateSalesOrderLineQtyShippedInputSchema.parse(input);
  return db.$transaction(async (tx) => {
    const line = await tx.salesOrderLine.findUnique({
      where: { id: lineId },
      include: { salesOrder: { select: { id: true, status: true } } },
    });
    if (!line || line.deletedAt != null) {
      throw new Error(`SalesOrderLine not found: ${lineId}`);
    }
    if (line.salesOrder.id !== salesOrderId) {
      throw new Error(
        `Line ${lineId} does not belong to SalesOrder ${salesOrderId}`,
      );
    }
    if (
      line.salesOrder.status !== SalesOrderStatus.CONFIRMED &&
      line.salesOrder.status !== SalesOrderStatus.DISPATCHED
    ) {
      throw new Error(
        `Cannot edit qtyShipped while SalesOrder is in status ${line.salesOrder.status}`,
      );
    }
    const qtyShipped = new Prisma.Decimal(data.qtyShipped);
    if (qtyShipped.greaterThan(line.qtyOrdered)) {
      throw new Error(
        `qtyShipped (${qtyShipped}) exceeds qtyOrdered (${line.qtyOrdered})`,
      );
    }

    const before = { qtyShipped: line.qtyShipped };
    const after = await tx.salesOrderLine.update({
      where: { id: lineId },
      data: { qtyShipped },
    });
    await audit(tx, {
      action: AuditAction.UPDATE,
      entityType: 'SalesOrderLine',
      entityId: lineId,
      before,
      after: { qtyShipped: after.qtyShipped },
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
      // Per audit doc resolution 2 (option b — see audit doc 2026-05-03):
      // CLOSED cancel still routes through RMA. The RMA path already
      // handles inventory reversal + AR credit atomically via
      // creditFromRma. Reimplementing that inside cancel would
      // duplicate logic and is not worth the risk for pilot.
      throw new Error(
        'Cannot cancel a CLOSED SalesOrder — use the RMA/Returns workflow instead',
      );
    }
    if (before.status === SalesOrderStatus.CANCELLED) {
      throw new Error('SalesOrder is already CANCELLED');
    }

    // Pre-CLOSED cancel: block when any RECORDED payment has been
    // applied through this SO's (yet-to-exist) invoice path. Today
    // an invoice only exists once the SO closes, so this guard is
    // a no-op for DRAFT / CONFIRMED / DISPATCHED in pilot — but
    // wiring it now keeps the cancel surface honest if a future
    // pre-close payment-capture path lands (e.g., 50% deposit
    // workflow). Looks for an Invoice on this SO, then any
    // non-reversed CreditApplication attached to a RECORDED payment.
    const invoice = await tx.invoice.findUnique({
      where: { salesOrderId: id },
      select: { id: true },
    });
    if (invoice) {
      const apps = await tx.creditApplication.findMany({
        where: {
          invoiceId: invoice.id,
          reversedAt: null,
          paymentId: { not: null },
          payment: { status: 'RECORDED' },
        },
        include: { payment: { select: { number: true } } },
      });
      if (apps.length > 0) {
        const numbers = Array.from(
          new Set(apps.map((a) => a.payment!.number)),
        ).sort();
        throw new SalesOrderCancelBlockedError({
          salesOrderId: id,
          paymentNumbers: numbers,
        });
      }
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

/**
 * Create a new DRAFT SalesOrder by copying lines + line-level discounts
 * + order-level discounts + notes from a source SO. Resets transient
 * lifecycle data: new SO number, orderDate=now, blank ship date /
 * shipping fields / status timestamps, no inventoryMovement linkage,
 * no qtyReserved / qtyShipped. Soft-deleted source rows are not
 * copied; soft-deleted source SOs are rejected (callers should pull a
 * live SO).
 *
 * Customer + warehouse are inherited from the source. Pricing is NOT
 * re-resolved — line.unitPrice / priceRule are copied verbatim so
 * "duplicate" produces an identical-money draft. If the operator
 * wants today's prices, they edit the draft afterward.
 */
export async function duplicateSalesOrder(
  db: PrismaClient,
  sourceId: string,
  ctx?: AuditContext,
): Promise<SalesOrderWithLines> {
  return db.$transaction(async (tx) => {
    const source = await tx.salesOrder.findUnique({
      where: { id: sourceId },
      include: { lines: { where: { deletedAt: null } } },
    });
    if (!source) throw new Error(`SalesOrder not found: ${sourceId}`);
    if (source.deletedAt) {
      throw new Error(`Cannot duplicate a soft-deleted SalesOrder: ${sourceId}`);
    }
    if (source.lines.length === 0) {
      throw new Error(`Cannot duplicate SalesOrder with no live lines: ${sourceId}`);
    }

    const seq = await getNextSequence(tx, {
      name: SO_SEQUENCE_NAME,
      prefix: SO_PREFIX,
      useYear: true,
    });

    const so = await tx.salesOrder.create({
      data: {
        number: seq.formatted,
        customerId: source.customerId,
        warehouseId: source.warehouseId,
        source: source.source,
        currency: source.currency,
        customerPo: source.customerPo,
        // Reset shipping/dates — these are per-shipment, not per-template.
        promisedShipDate: null,
        orderDate: new Date(),
        orderDiscountPercent: source.orderDiscountPercent,
        orderDiscountAmount: source.orderDiscountAmount,
        // Shipping + handling are recomputed at close for the new
        // shipment, not inherited.
        shippingAmount: null,
        handlingAmount: null,
        shippingAddress: source.shippingAddress,
        customerNotes: source.customerNotes,
        internalNotes: source.internalNotes,
        createdById: ctx?.userId ?? null,
        lines: {
          create: source.lines.map((l) => ({
            variantId: l.variantId,
            warehouseId: l.warehouseId,
            qtyOrdered: l.qtyOrdered,
            unitPrice: l.unitPrice,
            priceRule: l.priceRule,
            discountPercent: l.discountPercent,
            discountAmount: l.discountAmount,
            customerNote: l.customerNote,
            internalNote: l.internalNote,
          })),
        },
      },
      include: { lines: true },
    });

    await audit(tx, {
      action: AuditAction.CREATE,
      entityType: 'SalesOrder',
      entityId: so.id,
      after: { ...so, duplicatedFromId: sourceId },
      ctx,
    });
    return so;
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

export type SalesOrderListFilters = {
  status?: SalesOrderStatus;
  customerId?: string;
  // Sales rep is on the customer record; we filter via the relation.
  salesRepId?: string;
  // Inclusive date range on orderDate. dateTo is bumped to end-of-day
  // by the caller (page.tsx) so the comparison stays inclusive.
  dateFrom?: Date;
  dateTo?: Date;
  // Substring match on SO number (case-insensitive). Numbers look like
  // SO-2026-00001 so partial matches are useful.
  q?: string;
  skip?: number;
  take?: number;
};

function salesOrderWhere(
  filters: Omit<SalesOrderListFilters, 'skip' | 'take'>,
): Prisma.SalesOrderWhereInput {
  const { status, customerId, salesRepId, dateFrom, dateTo, q } = filters;
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
    ...(customerId ? { customerId } : {}),
    ...(salesRepId ? { customer: { salesRepId } } : {}),
    ...(dateClause ? { orderDate: dateClause } : {}),
    ...(q ? { number: { contains: q, mode: 'insensitive' as const } } : {}),
  };
}

// Paginated list with customer (id, code, name, salesRepId) eager-
// loaded so the table can render the customer name and sales-rep
// lookup in a single round-trip. Lines are also included so the page
// can call computeSalesOrderTotal per row (pilot scale; same N+1
// pattern as the customers list AR balance).
export async function listSalesOrdersPaged(
  db: PrismaClient,
  filters: SalesOrderListFilters = {},
): Promise<{
  rows: Array<
    SalesOrderWithLines & {
      customer: { id: string; code: string; name: string; salesRepId: string };
    }
  >;
  total: number;
}> {
  const { skip = 0, take = 100, ...rest } = filters;
  const where = salesOrderWhere(rest);
  const [rows, total] = await Promise.all([
    db.salesOrder.findMany({
      where,
      include: {
        lines: { where: { deletedAt: null } },
        customer: {
          select: { id: true, code: true, name: true, salesRepId: true },
        },
      },
      orderBy: [{ orderDate: 'desc' }, { createdAt: 'desc' }],
      skip,
      take,
    }),
    db.salesOrder.count({ where }),
  ]);
  return { rows, total };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

// Credit-limit + AR-hold gates for confirmSalesOrder. Reads run
// against `tx` (same transaction as the confirm) so a concurrent
// payment / invoice mutation either commits before our reads or
// blocks until we finish. Both gates short-circuit when their
// configured customer field is null (creditLimit IS NULL = no
// limit; arHoldDays IS NULL = AR hold off).
async function enforceCreditAndArHold(
  tx: Prisma.TransactionClient,
  args: { salesOrderId: string; customerId: string; orderTotal: Prisma.Decimal },
): Promise<void> {
  const customer = await tx.customer.findUniqueOrThrow({
    where: { id: args.customerId },
    select: { id: true, creditLimit: true, arHoldDays: true },
  });

  // Credit limit: AR + open SOs (excluding this one) + this order's
  // total must be <= limit. Cast `tx` to the read-only PrismaClient
  // shape the helpers expect — the helpers only do `findMany`, which
  // is identical on tx and PrismaClient.
  if (customer.creditLimit != null) {
    const txAsClient = tx as unknown as PrismaClient;
    const [{ arBalance }, openSosTotal] = await Promise.all([
      arBalanceForCustomer(txAsClient, args.customerId),
      getOpenSosNotInvoicedTotal(txAsClient, args.customerId, {
        excludeSalesOrderId: args.salesOrderId,
      }),
    ]);
    const projected = arBalance.plus(openSosTotal).plus(args.orderTotal);
    if (projected.greaterThan(customer.creditLimit)) {
      throw new CreditLimitExceededError({
        customerId: args.customerId,
        creditLimit: customer.creditLimit.toString(),
        arBalance: arBalance.toString(),
        openSosTotal: openSosTotal.toString(),
        thisOrderTotal: args.orderTotal.toString(),
        projectedExposure: projected.toString(),
      });
    }
  }

  // AR hold: any open invoice with daysPastDue >= arHoldDays blocks.
  // Reuses the aging service so PaymentTerm.netDays semantics +
  // bucket math stay in one place.
  if (customer.arHoldDays != null) {
    const txAsClient = tx as unknown as PrismaClient;
    const aging = await agingForCustomer(txAsClient, args.customerId);
    const overdue = aging.invoices.filter(
      (inv) => inv.daysPastDue >= customer.arHoldDays!,
    );
    if (overdue.length > 0) {
      // Worst = most days past due (aging.invoices is already sorted DESC).
      const worst = overdue[0]!;
      throw new ArHoldExceededError({
        customerId: args.customerId,
        arHoldDays: customer.arHoldDays,
        worstInvoiceNumber: worst.number,
        worstInvoiceDaysPastDue: worst.daysPastDue,
      });
    }
  }
}

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
