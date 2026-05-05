import { Prisma, SalesOrderStatus } from '@/generated/tenant';
import type { PrismaClient, SalesOrder, SalesOrderLine } from '@/generated/tenant';

// "Open SOs not yet invoiced" = pre-invoice in-flight exposure for
// credit-limit math. Includes CONFIRMED + DISPATCHED (reserved stock,
// not yet shipped + invoiced). DRAFT is excluded — drafts can be
// abandoned without operator action and don't represent a real
// commitment. CLOSED is excluded — by then an Invoice exists and AR
// counts the exposure. CANCELLED + soft-deleted are excluded.
//
// Returns the SUM of computed order totals using the same math as
// invoice generation: line.qty * line.unitPrice − line.discount,
// then order-level discount + shipping + handling.

type SOWithLines = SalesOrder & { lines: SalesOrderLine[] };

export function computeSalesOrderTotal(so: SOWithLines): Prisma.Decimal {
  const liveLines = so.lines.filter((l) => l.deletedAt === null);
  const subtotal = liveLines.reduce((acc, l) => {
    let lineTotal = l.qtyOrdered.times(l.unitPrice);
    if (l.discountAmount != null) {
      lineTotal = lineTotal.minus(l.discountAmount);
    } else if (l.discountPercent != null) {
      lineTotal = lineTotal.minus(
        lineTotal.times(l.discountPercent).dividedBy(100),
      );
    }
    if (lineTotal.lessThan(0)) lineTotal = new Prisma.Decimal(0);
    return acc.plus(lineTotal);
  }, new Prisma.Decimal(0));

  const orderDiscount =
    so.orderDiscountAmount ??
    (so.orderDiscountPercent != null
      ? subtotal.times(so.orderDiscountPercent).dividedBy(100)
      : new Prisma.Decimal(0));
  const shippingAmount = so.shippingAmount ?? new Prisma.Decimal(0);
  const handlingAmount = so.handlingAmount ?? new Prisma.Decimal(0);

  let total = subtotal.minus(orderDiscount).plus(shippingAmount).plus(handlingAmount);
  if (total.lessThan(0)) total = new Prisma.Decimal(0);
  return total;
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
