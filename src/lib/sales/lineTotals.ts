import { Prisma, SalesOrderStatus } from '@/generated/tenant';

// =============================================================================
// Single source of truth for the *billable* quantity + line total of a sales
// order line, given the order's status. "Billable" = the qty the displayed
// totals (and the eventual invoice) should price on:
//
//   DRAFT                 → qtyOrdered (nothing shipped yet)
//   CONFIRMED / DISPATCHED→ qtyShipped when the warehouse has entered it
//                           (> 0), otherwise qtyOrdered (the commitment)
//   CLOSED                → qtyShipped (matches the generated invoice)
//   CANCELLED / other     → qtyOrdered (no shipment)
//
// This is intentionally distinct from credit-limit "commitment" math
// (lib/ar/openSos.computeSalesOrderTotal), which always prices qtyOrdered.
// =============================================================================

const ZERO = new Prisma.Decimal(0);

// Structural shape — both Prisma.SalesOrderLine and the detail-page row type
// satisfy it.
export type BillableLine = {
  qtyOrdered: Prisma.Decimal;
  qtyShipped: Prisma.Decimal;
  unitPrice: Prisma.Decimal;
  discountPercent: Prisma.Decimal | null;
  discountAmount: Prisma.Decimal | null;
};

export function effectiveBillableQty(
  line: Pick<BillableLine, 'qtyOrdered' | 'qtyShipped'>,
  status: string,
): Prisma.Decimal {
  if (status === SalesOrderStatus.CLOSED) return line.qtyShipped;
  if (
    status === SalesOrderStatus.CONFIRMED ||
    status === SalesOrderStatus.DISPATCHED
  ) {
    return line.qtyShipped.greaterThan(0) ? line.qtyShipped : line.qtyOrdered;
  }
  return line.qtyOrdered;
}

export function computeLineBillableTotal(
  line: BillableLine,
  status: string,
): Prisma.Decimal {
  const qty = effectiveBillableQty(line, status);
  let lineTotal = qty.times(line.unitPrice);
  if (line.discountAmount != null) {
    lineTotal = lineTotal.minus(line.discountAmount);
  } else if (line.discountPercent != null) {
    lineTotal = lineTotal.minus(
      lineTotal.times(line.discountPercent).dividedBy(100),
    );
  }
  return lineTotal.lessThan(0) ? ZERO : lineTotal;
}
