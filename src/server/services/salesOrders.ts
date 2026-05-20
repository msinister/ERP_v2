import {
  Prisma,
  AuditAction,
  InventoryMovementType,
  PriceResolutionRule,
  SalesOrderStatus,
} from '@/generated/tenant';
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
  generateInvoiceForClosedSOTx,
  voidInvoiceTx,
} from '@/server/services/invoices';
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
  SalesOrderReopenBlockedError,
} from '@/lib/errors/credit';
import { reverseCogsForInvoiceTx } from '@/server/services/cogsReversal';
import { reversePaymentTx } from '@/server/services/payments';
import { recomputeOnHand } from '@/server/services/movements';
import { expandBundleLinesInTx } from '@/server/services/bundleExplode';
import { getOverShippingPolicy } from '@/server/services/overShipping';
import {
  addSalesOrderLinesInputSchema,
  cancelSalesOrderInputSchema,
  closeSalesOrderInputSchema,
  createSalesOrderInputSchema,
  removeSalesOrderLineInputSchema,
  reopenSalesOrderInputSchema,
  setSalesOrderSalesRepInputSchema,
  updateSalesOrderInputSchema,
  updateSalesOrderLineFieldsInputSchema,
  updateSalesOrderLineQtyShippedInputSchema,
  type AddSalesOrderLinesInput,
  type CancelSalesOrderInput,
  type CloseSalesOrderInput,
  type CreateSalesOrderInput,
  type RemoveSalesOrderLineInput,
  type ReopenSalesOrderInput,
  type SetSalesOrderSalesRepInput,
  type UpdateSalesOrderInput,
  type UpdateSalesOrderLineFieldsInput,
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

    // Explode any BUNDLE inputs into component-line inputs first.
    // Non-bundle inputs pass through untouched. The explode returns
    // pre-allocated prices on bundle children so the resolver doesn't
    // re-price them.
    const expandedInputs = await expandBundleLinesInTx(
      tx,
      data.lines,
      data.warehouseId,
    );

    // Resolve every line's unit price through the pricing resolver. Never
    // bypass — see CLAUDE.md non-negotiable rules. Bundle-allocated
    // lines short-circuit the resolver: they carry their pre-computed
    // unitPrice + BUNDLE_ALLOCATED rule. Inline edit later flips the
    // rule to MANUAL_OVERRIDE.
    const resolvedLines = [];
    for (const l of expandedInputs) {
      const isBundleAllocated = l._allocatedUnitPrice != null;
      const unitPrice = isBundleAllocated
        ? new Prisma.Decimal(l._allocatedUnitPrice!)
        : null;
      const resolved = isBundleAllocated
        ? null
        : await resolvePrice(tx, {
            variantId: l.variantId,
            customerId: data.customerId,
            qty: new Prisma.Decimal(l.qtyOrdered),
            manualUnitPrice:
              l.manualUnitPrice != null ? new Prisma.Decimal(l.manualUnitPrice) : null,
          });
      // Operator-supplied discountPercent / discountAmount always win.
      // Tier-discount pre-fill (resolved.discountPercent) only applies
      // when the operator left BOTH discount fields blank. No stacking.
      // Bundle-allocated lines never carry resolver discounts.
      const operatorSetDiscount =
        l.discountPercent != null || l.discountAmount != null;
      const effectiveDiscountPercent = operatorSetDiscount
        ? l.discountPercent != null
          ? new Prisma.Decimal(l.discountPercent)
          : null
        : resolved?.discountPercent ?? null;
      const effectiveDiscountAmount =
        l.discountAmount != null ? new Prisma.Decimal(l.discountAmount) : null;
      resolvedLines.push({
        variantId: l.variantId,
        warehouseId: l.warehouseId,
        qtyOrdered: new Prisma.Decimal(l.qtyOrdered),
        unitPrice: unitPrice ?? resolved!.unitPrice,
        priceRule: isBundleAllocated
          ? PriceResolutionRule.BUNDLE_ALLOCATED
          : resolved!.rule,
        discountPercent: effectiveDiscountPercent,
        discountAmount: effectiveDiscountAmount,
        customerNote: l.customerNote ?? null,
        internalNote: l.internalNote ?? null,
        bundleGroupId: l._bundleGroupId ?? null,
        bundleSourceProductId: l._bundleSourceProductId ?? null,
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
    // Per-order rep override. null clears it (inherit customer's rep).
    // A bad id surfaces as a connect failure → 400 at the route.
    if ('salesRepId' in data) {
      updateData.salesRep = data.salesRepId
        ? { connect: { id: data.salesRepId } }
        : { disconnect: true };
    }

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

/**
 * Change (or clear) the per-order sales-rep override. Unlike
 * updateSalesOrder (DRAFT-only), this is allowed on DRAFT, CONFIRMED, and
 * DISPATCHED — operators routinely reassign in-flight orders. CLOSED and
 * CANCELLED are rejected: a closed order may already have accrued
 * commission to the old rep, and reassigning would silently mis-credit it.
 *
 * salesRepId = null clears the override → the order inherits the
 * customer's rep again. A non-null id must reference a live SalesRep.
 * Effective-rep readers (commission accrual, "view own" scoping, list +
 * detail display) resolve `so.salesRepId ?? customer.salesRepId`.
 */
export async function setSalesOrderSalesRep(
  db: PrismaClient,
  id: string,
  input: SetSalesOrderSalesRepInput,
  ctx?: AuditContext,
): Promise<SalesOrder> {
  const data = setSalesOrderSalesRepInputSchema.parse(input);
  return db.$transaction(async (tx) => {
    const before = await tx.salesOrder.findUnique({
      where: { id },
      select: { id: true, status: true, salesRepId: true, deletedAt: true },
    });
    if (!before || before.deletedAt) {
      throw new Error(`SalesOrder not found: ${id}`);
    }
    if (
      before.status === SalesOrderStatus.CLOSED ||
      before.status === SalesOrderStatus.CANCELLED
    ) {
      throw new Error(
        `Cannot change the sales rep on a ${before.status} order`,
      );
    }
    if (data.salesRepId) {
      const rep = await tx.salesRep.findFirst({
        where: { id: data.salesRepId, deletedAt: null },
        select: { id: true },
      });
      if (!rep) throw new Error('Sales rep not found');
    }

    const after = await tx.salesOrder.update({
      where: { id },
      data: data.salesRepId
        ? { salesRep: { connect: { id: data.salesRepId } } }
        : { salesRep: { disconnect: true } },
    });
    await audit(tx, {
      action: AuditAction.UPDATE,
      entityType: 'SalesOrder',
      entityId: id,
      before: { salesRepId: before.salesRepId },
      after: { salesRepId: after.salesRepId },
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

/**
 * DISPATCHED → CONFIRMED. Pure status flip — dispatched is a
 * shipping-intent marker, not an inventory-state change (inventory
 * movements happen on Confirm and Close only), so reverting it has
 * no inventory side-effects. Useful when the warehouse was prepping
 * an order, marked it dispatched, then discovered a problem that
 * blocks shipment.
 */
export async function undispatchSalesOrder(
  db: PrismaClient,
  id: string,
  ctx?: AuditContext,
): Promise<SalesOrder> {
  return db.$transaction(async (tx) => {
    const before = await tx.salesOrder.findUnique({ where: { id } });
    if (!before) throw new Error(`SalesOrder not found: ${id}`);
    if (before.status !== SalesOrderStatus.DISPATCHED) {
      throw new Error(
        `Cannot un-dispatch SalesOrder in status ${before.status}`,
      );
    }
    const after = await tx.salesOrder.update({
      where: { id },
      data: {
        status: SalesOrderStatus.CONFIRMED,
        dispatchedAt: null,
      },
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
      // qtyShipped ≤ qtyOrdered (unless the tenant-wide overShipping
      // policy permits otherwise — same gate the inline qtyShipped
      // editor uses). Lines not in the payload default to full
      // qtyOrdered — matches the historical "ship everything" behavior.
      const qtyShippedByLineId = new Map<string, Prisma.Decimal>();
      if (data.lines && data.lines.length > 0) {
        const validIds = new Set(before.lines.map((l) => l.id));
        const qtyOrderedById = new Map(
          before.lines.map((l) => [l.id, l.qtyOrdered]),
        );
        const seen = new Set<string>();
        // Fetch the policy once before walking the payload.
        const overShippingPolicy = await getOverShippingPolicy(tx);
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
          if (
            qtyShipped.greaterThan(qtyOrdered) &&
            overShippingPolicy === 'BLOCK'
          ) {
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
 * CLOSED → CONFIRMED | DISPATCHED | CANCELLED. Operator-driven
 * corrections workflow when a close happened in error or needs
 * adjustment. In one transaction:
 *   1. Refuse if the invoice has non-reversed applied payments and
 *      paymentDecision !== 'unapply' — throws SalesOrderReopenBlocked-
 *      Error so the UI can prompt for confirmation.
 *   2. Reverse each non-reversed payment (when opted in). Uses
 *      reversePaymentTx so the reversal is atomic with the rest of
 *      this transaction. Note: a payment split across multiple
 *      invoices comes unapplied EVERYWHERE — operator is warned
 *      client-side.
 *   3. Reverse COGS via reverseCogsForInvoiceTx — restores FIFO
 *      layers, posts the offsetting JE, recomputes onHand. Inventory
 *      is fully back at this point.
 *   4. Per line: clear inventoryMovementId, zero qtyShipped. Restore
 *      qtyReserved = qtyOrdered when target ∈ {CONFIRMED, DISPATCHED};
 *      leave at 0 for CANCELLED.
 *   5. Void the invoice via voidInvoiceTx. Flips status → VOIDED,
 *      posts the offsetting AR/Revenue/Shipping/Handling JE, and
 *      calls reverseCogsForInvoiceTx (idempotent — step 3 already
 *      did this, second call is a no-op via cogsReversed=true).
 *      Without this step the orphaned invoice's AR posting stays on
 *      the books and a subsequent re-close double-counts AR.
 *   6. Unlink the invoice (Invoice.salesOrderId → null). Voided +
 *      unlinked together ensures the next close's idempotency probe
 *      (findFirst where salesOrderId=, deletedAt: null) doesn't
 *      return the voided row and skip generation.
 *   7. Update SO: status → target, clear closedAt, set/clear
 *      dispatchedAt + cancelledAt to match the target.
 *   8. Recompute reserved per bin so the denormalized counter
 *      reflects the new state.
 *
 * The invoice's AR exposure IS reversed in step 5. A subsequent
 * close on this SO will generate a fresh invoice with an -R{n}
 * suffix (per generateInvoiceForClosedSOTx's numbering rule), and
 * that fresh invoice's AR posting is the only one live in the GL.
 */
export async function reopenSalesOrder(
  db: PrismaClient,
  id: string,
  input: ReopenSalesOrderInput,
  ctx?: AuditContext,
): Promise<SalesOrderWithLines> {
  const data = reopenSalesOrderInputSchema.parse(input);
  return db.$transaction(async (tx) => {
    const before = await tx.salesOrder.findUnique({
      where: { id },
      include: {
        lines: { where: { deletedAt: null } },
        invoice: {
          include: {
            applications: { where: { reversedAt: null } },
          },
        },
      },
    });
    if (!before) throw new Error(`SalesOrder not found: ${id}`);
    if (before.status !== SalesOrderStatus.CLOSED) {
      throw new Error(`Cannot reopen SalesOrder in status ${before.status}`);
    }
    if (!before.invoice) {
      // No invoice means close was rolled back somehow — there's
      // nothing to unlink/reverse; just flip status. Defensive guard
      // mostly — CLOSED SOs always have an invoice in pilot.
      throw new Error(
        `SalesOrder ${id} is CLOSED but has no linked invoice; manual cleanup required`,
      );
    }
    const invoice = before.invoice;

    // 1. Payment-application gate.
    if (
      invoice.applications.length > 0 &&
      data.paymentDecision !== 'unapply'
    ) {
      const paymentIds = Array.from(
        new Set(
          invoice.applications
            .map((a) => a.paymentId)
            .filter((p): p is string => p != null),
        ),
      );
      const payments = await tx.payment.findMany({
        where: { id: { in: paymentIds }, reversedAt: null },
        select: { id: true, number: true, receivedAt: true, amount: true },
      });
      const appliedByPaymentToThisInvoice = new Map<string, Prisma.Decimal>();
      for (const a of invoice.applications) {
        if (a.paymentId == null) continue;
        const cur =
          appliedByPaymentToThisInvoice.get(a.paymentId) ?? new Prisma.Decimal(0);
        appliedByPaymentToThisInvoice.set(a.paymentId, cur.plus(a.amount));
      }
      throw new SalesOrderReopenBlockedError({
        salesOrderId: id,
        invoiceId: invoice.id,
        invoiceNumber: invoice.number,
        payments: payments.map((p) => ({
          paymentId: p.id,
          paymentNumber: p.number,
          receivedAt: p.receivedAt.toISOString(),
          amount: p.amount.toString(),
          amountAppliedToThisInvoice: (
            appliedByPaymentToThisInvoice.get(p.id) ?? new Prisma.Decimal(0)
          ).toString(),
        })),
      });
    }

    // 2. Reverse payments (when opted in). Group by paymentId so a
    // payment split across multiple invoice-applications is reversed
    // exactly once.
    if (data.paymentDecision === 'unapply' && invoice.applications.length > 0) {
      const paymentIds = Array.from(
        new Set(
          invoice.applications
            .map((a) => a.paymentId)
            .filter((p): p is string => p != null),
        ),
      );
      const reason =
        data.unapplyReason ?? `SO ${before.number} reopened by operator`;
      for (const paymentId of paymentIds) {
        await reversePaymentTx(tx, { paymentId, reason }, ctx);
      }
    }

    // 3. Reverse COGS. Idempotent — if the invoice's cogsReversed flag
    // is already set (operator double-clicked, replay), this is a no-op.
    // Handles GL reversal + FIFO layer rebuild + onHand restore when
    // FifoConsumption rows exist on the consume movements.
    await reverseCogsForInvoiceTx(tx, invoice.id, ctx);

    // 3b. Inventory restore fallback. reverseCogsForInvoiceTx
    // short-circuits ("zero_reversal") on lines whose CONSUME
    // movement has no FifoConsumption rows — common when stock was
    // seeded outside the PO/receipt FIFO flow (e.g., direct
    // receiveInventory). Without this sweep the onHand drop from
    // close would linger. Per-line: detect zero-FIFO consume and
    // post a manual ADJUST to bring the bin back. Lines whose stock
    // is already restored (because COGS reversal handled it) are
    // skipped by the FifoConsumption count check.
    for (const line of before.lines) {
      if (!line.inventoryMovementId) continue;
      const consumed = await tx.fifoConsumption.count({
        where: { movementId: line.inventoryMovementId },
      });
      if (consumed > 0) continue;
      const consumeMovement = await tx.inventoryMovement.findUnique({
        where: { id: line.inventoryMovementId },
        select: { qty: true, variantId: true, warehouseId: true },
      });
      if (!consumeMovement) continue;
      // Forward consume was negative qty; reverse is the positive twin.
      await tx.inventoryMovement.create({
        data: {
          variantId: consumeMovement.variantId,
          warehouseId: consumeMovement.warehouseId,
          type: InventoryMovementType.ADJUST,
          qty: consumeMovement.qty.negated(),
          reference: before.number,
          notes: `SO ${before.number} reopen — stock restored`,
        },
      });
      await recomputeOnHand(
        tx,
        consumeMovement.variantId,
        consumeMovement.warehouseId,
      );
    }

    // 4. Per-line cleanup. Drop the consume-movement back-pointer
    // (the prior CONSUME has been reversed) and restore reservation
    // when re-opening to a status that still holds inventory
    // (CONFIRMED / DISPATCHED); CANCELLED releases reservation
    // outright. qtyShipped is PRESERVED — the operator is reopening
    // to make corrections, not to lose their shipping data. Without
    // preservation, an over-ship (qtyShipped > qtyOrdered) gets
    // silently rewritten on reopen and the warehouse loses what was
    // actually picked. If the operator wants to revise the shipped
    // count, they edit it inline via the QtyShippedInput on the
    // reopened SO.
    const restoreReservation =
      data.targetStatus === 'CONFIRMED' || data.targetStatus === 'DISPATCHED';
    const bins = uniqueBins(before.lines);
    for (const b of bins) {
      await lockBin(tx, b.variantId, b.warehouseId);
    }
    for (const line of before.lines) {
      await tx.salesOrderLine.update({
        where: { id: line.id },
        data: {
          inventoryMovementId: null,
          qtyReserved: restoreReservation
            ? line.qtyOrdered
            : new Prisma.Decimal(0),
        },
      });
    }

    // 5. Void the invoice. Composes voidInvoiceTx inside this tx so
    // AR/Revenue reversal commits atomically with the SO status flip.
    // voidInvoiceTx re-invokes reverseCogsForInvoiceTx but that path
    // short-circuits when cogsReversed=true (set by step 3 above), so
    // there's no double-COGS reversal. The CM-with-reversed-COGS
    // guard inside voidInvoiceTx now also blocks reopen — that's
    // intentional: composing partial-CM-reversal with a full void
    // would double-restore the CM's lines. Operator must resolve via
    // the CM flow first in that edge case.
    const voidReason = `SO ${before.number} reopened by operator → ${data.targetStatus}`;
    await voidInvoiceTx(tx, invoice.id, voidReason, ctx);

    // 6. Unlink invoice. NULL the FK so the next close's idempotency
    // probe (findFirst where salesOrderId=, deletedAt: null) sees no
    // existing row and generates a fresh invoice. Without this, the
    // probe would return the voided row and short-circuit, leaving
    // the SO without a live invoice after re-close.
    await tx.invoice.update({
      where: { id: invoice.id },
      data: { salesOrderId: null },
    });

    // 7. Status flip + timestamp surgery. closedAt is always cleared;
    // dispatchedAt + cancelledAt are set/cleared per target.
    const now = new Date();
    const targetStatus = SalesOrderStatus[data.targetStatus];
    const updateData: Prisma.SalesOrderUpdateInput = {
      status: targetStatus,
      closedAt: null,
    };
    if (data.targetStatus === 'DISPATCHED') {
      updateData.dispatchedAt = before.dispatchedAt ?? now;
      updateData.cancelledAt = null;
      updateData.cancelReason = null;
    } else if (data.targetStatus === 'CONFIRMED') {
      updateData.dispatchedAt = null;
      updateData.cancelledAt = null;
      updateData.cancelReason = null;
    } else {
      // CANCELLED — keep the original cancel-reason machinery
      // available, but seed cancelledAt now and leave cancelReason
      // for the operator to fill in via the existing cancel UI if
      // they want a richer note. Reopen → CANCELLED is the "abandon
      // this order's inventory effects" path.
      updateData.dispatchedAt = null;
      updateData.cancelledAt = now;
      updateData.cancelReason =
        before.cancelReason ?? `Reopened from CLOSED and cancelled`;
    }
    const after = await tx.salesOrder.update({
      where: { id },
      data: updateData,
      include: { lines: true },
    });

    // 8. Recompute reserved per bin so the InventoryItem.reserved
    // counter reflects the new SO state. Done AFTER the status flip
    // so the new status drives the roll-up filter inside
    // recomputeReservedForBin.
    for (const b of bins) {
      await recomputeReservedForBin(tx, b.variantId, b.warehouseId);
    }

    await audit(tx, {
      action: AuditAction.STATUS_CHANGE,
      entityType: 'SalesOrder',
      entityId: id,
      before: { status: before.status },
      after: {
        status: after.status,
        targetStatus: data.targetStatus,
        invoiceId: invoice.id,
        invoiceNumber: invoice.number,
        invoiceVoided: true,
        invoiceUnlinked: true,
        paymentsUnapplied: data.paymentDecision === 'unapply',
      },
      ctx,
    });

    return after;
  });
}

/**
 * CONFIRMED-only line add. Existing lines stay untouched; new lines
 * go through the same resolvePrice + qtyReserved flow as confirm so
 * they're immediately part of the reservation roll-up. Credit-limit
 * and AR-hold gates re-run with the updated SO total — adding lines
 * to a CONFIRMED order shouldn't be a back-door around credit
 * enforcement.
 *
 * Why a separate service from updateSalesOrder: updateSalesOrder does
 * wholesale lines-replace and rejects non-DRAFT. Folding partial-add
 * semantics into it would muddy the contract; the spec'd "Edit a
 * CONFIRMED order" UX is strictly add-only on the lines surface, so
 * a dedicated entry point is cleaner.
 */
export async function addSalesOrderLines(
  db: PrismaClient,
  id: string,
  input: AddSalesOrderLinesInput,
  ctx?: AuditContext,
): Promise<SalesOrderWithLines> {
  const data = addSalesOrderLinesInputSchema.parse(input);
  return db.$transaction(async (tx) => {
    const before = await tx.salesOrder.findUnique({
      where: { id },
      include: { lines: { where: { deletedAt: null } } },
    });
    if (!before) throw new Error(`SalesOrder not found: ${id}`);
    if (before.status !== SalesOrderStatus.CONFIRMED) {
      throw new Error(
        `Cannot add lines to a SalesOrder in ${before.status} status — adding lines is only supported on CONFIRMED orders`,
      );
    }

    // Explode any BUNDLE inputs first. After this the loop only sees
    // concrete component lines + non-bundle pass-throughs.
    const expandedInputs = await expandBundleLinesInTx(
      tx,
      data.lines,
      before.warehouseId,
    );

    // Resolve price + create + reserve each new line. Locks every
    // (variant, warehouse) bin we're touching — including ones the
    // existing lines already touch, so concurrent ops on the same
    // bin serialize.
    const newBins = uniqueBins(
      expandedInputs.map((l) => ({
        variantId: l.variantId,
        warehouseId: l.warehouseId,
      })),
    );
    for (const b of newBins) {
      await lockBin(tx, b.variantId, b.warehouseId);
    }

    const createdLines: { id: string }[] = [];
    for (const l of expandedInputs) {
      const isBundleAllocated = l._allocatedUnitPrice != null;
      const unitPrice = isBundleAllocated
        ? new Prisma.Decimal(l._allocatedUnitPrice!)
        : null;
      const resolved = isBundleAllocated
        ? null
        : await resolvePrice(tx, {
            variantId: l.variantId,
            customerId: before.customerId,
            qty: new Prisma.Decimal(l.qtyOrdered),
            manualUnitPrice:
              l.manualUnitPrice != null
                ? new Prisma.Decimal(l.manualUnitPrice)
                : null,
          });
      const operatorSetDiscount =
        l.discountPercent != null || l.discountAmount != null;
      const effectiveDiscountPercent = operatorSetDiscount
        ? l.discountPercent != null
          ? new Prisma.Decimal(l.discountPercent)
          : null
        : resolved?.discountPercent ?? null;
      const effectiveDiscountAmount =
        l.discountAmount != null ? new Prisma.Decimal(l.discountAmount) : null;
      const created = await tx.salesOrderLine.create({
        data: {
          salesOrderId: id,
          variantId: l.variantId,
          warehouseId: l.warehouseId,
          qtyOrdered: new Prisma.Decimal(l.qtyOrdered),
          // Reserve immediately — the SO is CONFIRMED, so reservation
          // is the expected state.
          qtyReserved: new Prisma.Decimal(l.qtyOrdered),
          unitPrice: unitPrice ?? resolved!.unitPrice,
          priceRule: isBundleAllocated
            ? PriceResolutionRule.BUNDLE_ALLOCATED
            : resolved!.rule,
          discountPercent: effectiveDiscountPercent,
          discountAmount: effectiveDiscountAmount,
          customerNote: l.customerNote ?? null,
          internalNote: l.internalNote ?? null,
          bundleGroupId: l._bundleGroupId ?? null,
          bundleSourceProductId: l._bundleSourceProductId ?? null,
        },
      });
      createdLines.push({ id: created.id });
    }

    // Re-run credit-limit + AR-hold gates with the post-add total.
    // We re-fetch lines so the gate sees the full new shape.
    const afterLines = await tx.salesOrderLine.findMany({
      where: { salesOrderId: id, deletedAt: null },
    });
    await enforceCreditAndArHold(tx, {
      salesOrderId: id,
      customerId: before.customerId,
      orderTotal: computeSalesOrderTotal({ ...before, lines: afterLines }),
    });

    // Recompute reserved on every touched bin. Includes the newly
    // added bins; existing bins are unaffected by the add.
    for (const b of newBins) {
      await recomputeReservedForBin(tx, b.variantId, b.warehouseId);
    }

    const after = await tx.salesOrder.findUniqueOrThrow({
      where: { id },
      include: { lines: true },
    });
    await audit(tx, {
      action: AuditAction.UPDATE,
      entityType: 'SalesOrder',
      entityId: id,
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
      // Tenant-wide over-shipping policy decides whether qtyShipped >
      // qtyOrdered is allowed. BLOCK rejects (original behavior);
      // CONFIRM + ALLOW both pass through (CONFIRM relies on the UI
      // to surface a confirmation dialog before this PATCH lands).
      const policy = await getOverShippingPolicy(tx);
      if (policy === 'BLOCK') {
        throw new Error(
          `qtyShipped (${qtyShipped}) exceeds qtyOrdered (${line.qtyOrdered})`,
        );
      }
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

/**
 * Inline per-field edit for a SO line. Used by the SO detail page's
 * click-to-edit cells while the order is DRAFT or CONFIRMED. The
 * caller sends ONLY the fields that changed; absent keys are left
 * untouched. Mutual-exclusion rule on discountPercent/discountAmount
 * is preserved by nulling the counterpart whenever one is set.
 *
 * Status windows:
 *   - DRAFT: free edits; no reservation/credit-gate side effects.
 *   - CONFIRMED: qty edits update qtyReserved + recompute the bin
 *     counter; total-changing edits (qty, unitPrice, discount) re-run
 *     the credit-limit + AR-hold gate against the post-edit total.
 *   - DISPATCHED / CLOSED / CANCELLED: rejected.
 *
 * Audit-side: emits a single UPDATE row covering the field diff.
 */
export async function updateSalesOrderLineFields(
  db: PrismaClient,
  salesOrderId: string,
  lineId: string,
  input: UpdateSalesOrderLineFieldsInput,
  ctx?: AuditContext,
): Promise<SalesOrderLine> {
  const data = updateSalesOrderLineFieldsInputSchema.parse(input);
  return db.$transaction(async (tx) => {
    // Pull the full SO row so computeSalesOrderTotal (which expects
    // every SalesOrder column) works without casts. Pilot scale —
    // single-row fetch on a tx-locked context.
    const line = await tx.salesOrderLine.findUnique({
      where: { id: lineId },
      include: { salesOrder: true },
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
      line.salesOrder.status !== SalesOrderStatus.DRAFT &&
      line.salesOrder.status !== SalesOrderStatus.CONFIRMED
    ) {
      throw new Error(
        `Cannot edit line fields while SalesOrder is in status ${line.salesOrder.status}`,
      );
    }

    // Build the update payload. Note that `null` is a meaningful value
    // here (clears the field); we distinguish "unset" via the schema's
    // .optional() — absent key means don't touch. Discount mutual-
    // exclusion: when one is set non-null, the other goes to null so
    // we never leave both populated.
    const updateData: Prisma.SalesOrderLineUpdateInput = {};
    let qtyChanged = false;
    let totalAffecting = false;

    if (data.qtyOrdered !== undefined) {
      const next = new Prisma.Decimal(data.qtyOrdered);
      if (!next.equals(line.qtyOrdered)) {
        updateData.qtyOrdered = next;
        qtyChanged = true;
        totalAffecting = true;
        // CONFIRMED orders keep qtyReserved = qtyOrdered. DRAFT
        // orders don't reserve, so qtyReserved stays at 0.
        if (line.salesOrder.status === SalesOrderStatus.CONFIRMED) {
          updateData.qtyReserved = next;
        }
      }
    }
    if (data.unitPrice !== undefined) {
      const next = new Prisma.Decimal(data.unitPrice);
      if (!next.equals(line.unitPrice)) {
        updateData.unitPrice = next;
        // Operator overriding the resolver's chosen price — flag the
        // priceRule so the audit trail and the line's price-rule
        // badge accurately reflect the source.
        updateData.priceRule = 'MANUAL_OVERRIDE';
        totalAffecting = true;
      }
    }
    if (data.discountPercent !== undefined) {
      updateData.discountPercent =
        data.discountPercent != null
          ? new Prisma.Decimal(data.discountPercent)
          : null;
      // Mutual exclusion — null the counterpart unless the caller
      // explicitly sent a discountAmount in the same payload (in which
      // case the validator already rejected the request).
      if (data.discountAmount === undefined) {
        updateData.discountAmount = null;
      }
      totalAffecting = true;
    }
    if (data.discountAmount !== undefined) {
      updateData.discountAmount =
        data.discountAmount != null
          ? new Prisma.Decimal(data.discountAmount)
          : null;
      if (data.discountPercent === undefined) {
        updateData.discountPercent = null;
      }
      totalAffecting = true;
    }
    if (data.customerNote !== undefined) {
      updateData.customerNote = data.customerNote;
    }
    if (data.internalNote !== undefined) {
      updateData.internalNote = data.internalNote;
    }

    if (Object.keys(updateData).length === 0) {
      // No real changes — return the existing line without an audit
      // row. The validator already enforces a non-empty payload, but
      // the operator might have edited to the same value.
      return line;
    }

    // If the qty changed on a CONFIRMED order, lock the bin so a
    // concurrent SO close on the same bin serializes against this
    // edit. The recompute below will see the updated qtyReserved.
    if (qtyChanged && line.salesOrder.status === SalesOrderStatus.CONFIRMED) {
      await lockBin(tx, line.variantId, line.warehouseId);
    }

    const before = {
      qtyOrdered: line.qtyOrdered,
      unitPrice: line.unitPrice,
      priceRule: line.priceRule,
      discountPercent: line.discountPercent,
      discountAmount: line.discountAmount,
      customerNote: line.customerNote,
      internalNote: line.internalNote,
    };

    const after = await tx.salesOrderLine.update({
      where: { id: lineId },
      data: updateData,
    });

    if (qtyChanged && line.salesOrder.status === SalesOrderStatus.CONFIRMED) {
      await recomputeReservedForBin(tx, line.variantId, line.warehouseId);
    }

    // Credit-limit + AR-hold re-check on CONFIRMED orders when the
    // edit might have pushed the total higher. Reuses the same
    // enforce helper that confirm + add-lines call so the contract
    // stays in one place.
    if (
      totalAffecting &&
      line.salesOrder.status === SalesOrderStatus.CONFIRMED
    ) {
      const afterLines = await tx.salesOrderLine.findMany({
        where: { salesOrderId, deletedAt: null },
      });
      await enforceCreditAndArHold(tx, {
        salesOrderId,
        customerId: line.salesOrder.customerId,
        orderTotal: computeSalesOrderTotal({
          ...line.salesOrder,
          lines: afterLines,
        }),
      });
    }

    await audit(tx, {
      action: AuditAction.UPDATE,
      entityType: 'SalesOrderLine',
      entityId: lineId,
      before,
      after: {
        qtyOrdered: after.qtyOrdered,
        unitPrice: after.unitPrice,
        priceRule: after.priceRule,
        discountPercent: after.discountPercent,
        discountAmount: after.discountAmount,
        customerNote: after.customerNote,
        internalNote: after.internalNote,
      },
      ctx,
    });

    return after;
  });
}

/**
 * Soft-delete one SalesOrderLine (or a whole bundle group) from a
 * DRAFT or CONFIRMED order. Mirrors the lifecycle gates the inline
 * field-edit path uses (DRAFT + CONFIRMED only), since both flows
 * mutate the order's commitment basis.
 *
 * Reservation:
 *   - DRAFT — qtyReserved is already 0, nothing to release. Bin
 *     reserved counter is unaffected.
 *   - CONFIRMED — clear qtyReserved → 0 on each removed line, lock
 *     every touched bin BEFORE the writes, then recompute
 *     InventoryItem.reserved per bin afterward. Same shape as
 *     cancelSalesOrder's release path.
 *
 * Bundle handling: when `removeBundleGroup` is true and the targeted
 * line belongs to a bundle (bundleGroupId != null), every sibling
 * line sharing that bundleGroupId on this SO is removed in the same
 * transaction. When false (default), only the single targeted line
 * is removed — useful when the customer drops one item from a bundle
 * without scrapping the whole group. The flag is a no-op when the
 * line isn't part of a bundle.
 *
 * Credit-limit / AR-hold: removing a line can only LOWER the order
 * total, so the gate is intentionally not re-run — there's no way
 * the smaller projection breaks a limit the original passed.
 *
 * Audit: one DELETE row per soft-deleted line. The lines-table render
 * (which filters deletedAt: null) drops the rows on the next refresh.
 */
export async function removeSalesOrderLine(
  db: PrismaClient,
  salesOrderId: string,
  lineId: string,
  input: RemoveSalesOrderLineInput,
  ctx?: AuditContext,
): Promise<SalesOrderWithLines> {
  const data = removeSalesOrderLineInputSchema.parse(input);
  return db.$transaction(async (tx) => {
    const targetLine = await tx.salesOrderLine.findUnique({
      where: { id: lineId },
      include: { salesOrder: { select: { id: true, status: true } } },
    });
    if (!targetLine || targetLine.deletedAt != null) {
      throw new Error(`SalesOrderLine not found: ${lineId}`);
    }
    if (targetLine.salesOrder.id !== salesOrderId) {
      throw new Error(
        `Line ${lineId} does not belong to SalesOrder ${salesOrderId}`,
      );
    }
    const status = targetLine.salesOrder.status;
    if (
      status !== SalesOrderStatus.DRAFT &&
      status !== SalesOrderStatus.CONFIRMED
    ) {
      throw new Error(
        `Cannot remove line while SalesOrder is in status ${status} — only DRAFT and CONFIRMED orders support inline line removal`,
      );
    }

    // Collect every line we're removing in this call. When the flag
    // is set and the targeted line has a bundleGroupId, expand to all
    // live siblings. Otherwise it's just the one targeted line.
    let linesToRemove = [targetLine];
    if (data.removeBundleGroup && targetLine.bundleGroupId != null) {
      const siblings = await tx.salesOrderLine.findMany({
        where: {
          salesOrderId,
          bundleGroupId: targetLine.bundleGroupId,
          deletedAt: null,
        },
        include: { salesOrder: { select: { id: true, status: true } } },
      });
      linesToRemove = siblings;
    }

    // Bin locking + reservation release only matters on CONFIRMED.
    // Sort via uniqueBins so concurrent reservation-touching ops on
    // overlapping bins acquire locks in the same canonical order.
    const bins = uniqueBins(
      linesToRemove.map((l) => ({
        variantId: l.variantId,
        warehouseId: l.warehouseId,
      })),
    );
    if (status === SalesOrderStatus.CONFIRMED) {
      for (const b of bins) {
        await lockBin(tx, b.variantId, b.warehouseId);
      }
    }

    const now = new Date();
    for (const l of linesToRemove) {
      await tx.salesOrderLine.update({
        where: { id: l.id },
        data: {
          deletedAt: now,
          // Clear qtyReserved so the reservation roll-up's
          // deletedAt: null filter is belt-and-braces with the
          // counter. Mirrors cancelSalesOrder's release.
          qtyReserved: new Prisma.Decimal(0),
        },
      });
      await audit(tx, {
        action: AuditAction.DELETE,
        entityType: 'SalesOrderLine',
        entityId: l.id,
        before: {
          salesOrderId: l.salesOrderId,
          variantId: l.variantId,
          warehouseId: l.warehouseId,
          qtyOrdered: l.qtyOrdered,
          qtyReserved: l.qtyReserved,
          unitPrice: l.unitPrice,
          bundleGroupId: l.bundleGroupId,
        },
        after: { deletedAt: now },
        ctx,
      });
    }

    if (status === SalesOrderStatus.CONFIRMED) {
      for (const b of bins) {
        await recomputeReservedForBin(tx, b.variantId, b.warehouseId);
      }
    }

    return tx.salesOrder.findUniqueOrThrow({
      where: { id: salesOrderId },
      include: { lines: { where: { deletedAt: null } } },
    });
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
  // Optional data-scope fragment (lib/permissions/scope.salesOrderScopeWhere).
  // Out-of-scope SOs resolve to null. Omitted by unscoped/internal callers.
  scope?: Prisma.SalesOrderWhereInput,
): Promise<SalesOrderWithLines | null> {
  return db.salesOrder.findFirst({
    where: { AND: [{ id, deletedAt: null }, scope ?? {}] },
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
  // Data-scope fragment from lib/permissions/scope.salesOrderScopeWhere.
  scope?: Prisma.SalesOrderWhereInput;
  skip?: number;
  take?: number;
};

function salesOrderWhere(
  filters: Omit<SalesOrderListFilters, 'skip' | 'take'>,
): Prisma.SalesOrderWhereInput {
  const { status, customerId, salesRepId, dateFrom, dateTo, q, scope } = filters;
  const dateClause: Prisma.DateTimeFilter | undefined =
    dateFrom || dateTo
      ? {
          ...(dateFrom ? { gte: dateFrom } : {}),
          ...(dateTo ? { lte: dateTo } : {}),
        }
      : undefined;
  const base: Prisma.SalesOrderWhereInput = {
    deletedAt: null,
    ...(status ? { status } : {}),
    ...(customerId ? { customerId } : {}),
    // Filter by EFFECTIVE rep: orders explicitly overridden to this rep,
    // OR orders with no override whose customer's rep is this rep.
    ...(salesRepId
      ? {
          OR: [
            { salesRepId },
            { salesRepId: null, customer: { salesRepId } },
          ],
        }
      : {}),
    ...(dateClause ? { orderDate: dateClause } : {}),
    ...(q ? { number: { contains: q, mode: 'insensitive' as const } } : {}),
  };
  // AND so an explicit salesRepId filter can't widen past the scope.
  return scope ? { AND: [base, scope] } : base;
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
