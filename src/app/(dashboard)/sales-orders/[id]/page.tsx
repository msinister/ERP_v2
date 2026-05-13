import { notFound } from 'next/navigation';
import { db } from '@/lib/db';
import { computeSalesOrderTotal } from '@/lib/ar/openSos';
import { SalesOrderHeader } from './_components/header';
import { SalesOrderLinesTable } from './_components/lines-table';
import { SalesOrderTotalsCard } from './_components/totals-card';
import { SalesOrderInfoCard } from './_components/info-card';

// Always live (no caching) — SO lifecycle / reservations / invoice
// linkage change frequently. Same convention as customer detail.
export const revalidate = 0;

export default async function SalesOrderDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const so = await db.salesOrder.findFirst({
    where: { id, deletedAt: null },
    include: {
      lines: {
        where: { deletedAt: null },
        include: {
          variant: {
            select: {
              id: true,
              sku: true,
              name: true,
              product: { select: { name: true } },
            },
          },
          warehouse: { select: { code: true, name: true } },
        },
        orderBy: { createdAt: 'asc' },
      },
      customer: {
        select: { id: true, code: true, name: true, salesRepId: true },
      },
      warehouse: { select: { id: true, code: true, name: true } },
      invoice: { select: { id: true, number: true } },
    },
  });
  if (!so) notFound();

  const salesRep = await db.salesRep.findUnique({
    where: { id: so.customer.salesRepId },
    select: { id: true, name: true },
  });

  const total = computeSalesOrderTotal(so);

  return (
    <div className="space-y-6">
      <SalesOrderHeader
        so={{
          id: so.id,
          number: so.number,
          status: so.status,
          customer: so.customer,
          orderDate: so.orderDate,
          confirmedAt: so.confirmedAt,
          dispatchedAt: so.dispatchedAt,
          closedAt: so.closedAt,
          cancelledAt: so.cancelledAt,
          invoice: so.invoice,
          shippingAmount: so.shippingAmount?.toString() ?? null,
          handlingAmount: so.handlingAmount?.toString() ?? null,
        }}
      />

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="space-y-6">
          <SalesOrderLinesTable
            lines={so.lines.map((l) => ({
              id: l.id,
              sku: l.variant.sku,
              productName: l.variant.product.name,
              variantName: l.variant.name,
              warehouseCode: l.warehouse.code,
              qtyOrdered: l.qtyOrdered,
              qtyReserved: l.qtyReserved,
              qtyShipped: l.qtyShipped,
              unitPrice: l.unitPrice,
              priceRule: l.priceRule,
              discountPercent: l.discountPercent,
              discountAmount: l.discountAmount,
              customerNote: l.customerNote,
              internalNote: l.internalNote,
            }))}
          />

          <SalesOrderInfoCard
            so={{
              customerPo: so.customerPo,
              promisedShipDate: so.promisedShipDate,
              shippingAddress: so.shippingAddress,
              customerNotes: so.customerNotes,
              internalNotes: so.internalNotes,
              cancelReason: so.cancelReason,
              currency: so.currency ?? 'USD',
              source: so.source,
            }}
            warehouse={so.warehouse}
            salesRep={salesRep}
          />
        </div>

        <div className="space-y-6">
          <SalesOrderTotalsCard
            lines={so.lines}
            orderDiscountAmount={so.orderDiscountAmount}
            orderDiscountPercent={so.orderDiscountPercent}
            shippingAmount={so.shippingAmount}
            handlingAmount={so.handlingAmount}
            total={total}
          />
        </div>
      </div>
    </div>
  );
}
