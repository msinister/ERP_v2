import { Prisma, SalesOrderStatus } from '@/generated/tenant';
import type { PrismaClient, SalesOrder, SalesOrderLine } from '@/generated/tenant';
import { computeLineBillableTotal } from '@/lib/sales/lineTotals';

// "Open SOs not yet invoiced" = pre-invoice in-flight exposure for
// credit-limit math. Includes CONFIRMED + DISPATCHED (reserved stock,
// not yet shipped + invoiced). DRAFT is excluded — drafts can be
// abandoned without operator action and don't represent a real
// commitment. CLOSED is excluded — by then an Invoice exists and AR
// counts the exposure. CANCELLED + soft-deleted are excluded.

type SOWithLines = SalesOrder & { lines: SalesOrderLine[] };

// Order-level discount / shipping / handling applied to a line subtotal.
function applyOrderAdjustments(
  so: SOWithLines,
  subtotal: Prisma.Decimal,
): Prisma.Decimal {
  const orderDiscount =
    so.orderDiscountAmount ??
    (so.orderDiscountPercent != null
      ? subtotal.times(so.orderDiscountPercent).dividedBy(100)
      : new Prisma.Decimal(0));
  const shippingAmount = so.shippingAmount ?? new Prisma.Decimal(0);
  const handlingAmount = so.handlingAmount ?? new Prisma.Decimal(0);
  const total = subtotal
    .minus(orderDiscount)
    .plus(shippingAmount)
    .plus(handlingAmount);
  return total.lessThan(0) ? new Prisma.Decimal(0) : total;
}

/**
 * Credit-limit "commitment" total — ALWAYS prices qtyOrdered, regardless of
 * status (the in-flight exposure a confirmed order represents). Forcing the
 * DRAFT basis makes computeLineBillableTotal resolve to qtyOrdered. Distinct
 * from computeSalesOrderDisplayTotal, which prices what's shipped.
 */
export function computeSalesOrderTotal(so: SOWithLines): Prisma.Decimal {
  const liveLines = so.lines.filter((l) => l.deletedAt === null);
  const subtotal = liveLines.reduce(
    (acc, l) => acc.plus(computeLineBillableTotal(l, SalesOrderStatus.DRAFT)),
    new Prisma.Decimal(0),
  );
  return applyOrderAdjustments(so, subtotal);
}

/**
 * Displayed order total — prices the BILLABLE qty for the SO's status
 * (qtyShipped once the warehouse enters it / on CLOSE, else qtyOrdered).
 * Used by the SO detail + list views so the shown total reflects what is
 * actually being delivered, matching the eventual invoice.
 */
export function computeSalesOrderDisplayTotal(
  so: SOWithLines,
): Prisma.Decimal {
  const liveLines = so.lines.filter((l) => l.deletedAt === null);
  const subtotal = liveLines.reduce(
    (acc, l) => acc.plus(computeLineBillableTotal(l, so.status)),
    new Prisma.Decimal(0),
  );
  return applyOrderAdjustments(so, subtotal);
}

/**
 * SUM of order totals across CONFIRMED + DISPATCHED (non-deleted) SOs
 * for the customer. Used by credit-limit enforcement at confirm-time
 * to compute projected exposure (AR + open SOs + this order).
 *
 * Optional `excludeSalesOrderId` lets the caller exclude the SO it
 * is about to confirm — that order's total is added separately by
 * the gate so the comparison stays exact.
 */
export async function getOpenSosNotInvoicedTotal(
  db: PrismaClient,
  customerId: string,
  opts: { excludeSalesOrderId?: string } = {},
): Promise<Prisma.Decimal> {
  const sos = await db.salesOrder.findMany({
    where: {
      customerId,
      deletedAt: null,
      status: { in: [SalesOrderStatus.CONFIRMED, SalesOrderStatus.DISPATCHED] },
      ...(opts.excludeSalesOrderId ? { NOT: { id: opts.excludeSalesOrderId } } : {}),
    },
    include: { lines: true },
  });
  return sos.reduce(
    (acc, so) => acc.plus(computeSalesOrderTotal(so)),
    new Prisma.Decimal(0),
  );
}
