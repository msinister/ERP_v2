import { notFound } from 'next/navigation';
import { Prisma, SalesOrderStatus } from '@/generated/tenant';
import { db } from '@/lib/db';
import { computeSalesOrderTotal } from '@/lib/ar/openSos';
import {
  lineItemImageVariantSelect,
  resolveLineImageUrl,
} from '@/lib/products/lineItemImage';
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
              product: {
                select: {
                  name: true,
                  images: {
                    where: { isPrimary: true, deletedAt: null },
                    select: { url: true },
                    orderBy: { sortOrder: 'asc' },
                    take: 1,
                  },
                },
              },
              imageUrl: true,
            },
          },
          warehouse: { select: { code: true, name: true } },
          // Pull the parent bundle's display data for any line that
          // came from a bundle explode. The lines-table uses this to
          // synthesize a header row above each bundle group.
          bundleSourceProduct: { select: { id: true, sku: true, name: true } },
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

  // computeSalesOrderTotal stays on qtyOrdered — it's the projected
  // commitment, used by credit-limit math for in-flight exposure.
  // For the displayed grand-total on a CLOSED order we want the
  // invoiced basis (qtyShipped), so the totals card matches the
  // invoice line totals. Pre-CLOSED both numbers coincide.
  const displayTotal =
    so.status === SalesOrderStatus.CLOSED
      ? computeSalesOrderTotal({
          ...so,
          lines: so.lines.map((l) => ({
            ...l,
            qtyOrdered: l.qtyShipped as Prisma.Decimal,
          })),
        })
      : computeSalesOrderTotal(so);

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
            salesOrderId={so.id}
            status={so.status}
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
              imageUrl: resolveLineImageUrl(l.variant),
              bundleGroupId: l.bundleGroupId,
              bundleSourceSku: l.bundleSourceProduct?.sku ?? null,
              bundleSourceName: l.bundleSourceProduct?.name ?? null,
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

        {/* lg:self-start lets the column shrink to content so sticky has
            somewhere to stick within the grid cell; without it the grid
            stretches the column to match the lines column's height and
            sticky becomes a no-op. */}
        <div className="space-y-6 lg:sticky lg:top-6 lg:self-start">
          <SalesOrderTotalsCard
            lines={so.lines}
            orderDiscountAmount={so.orderDiscountAmount}
            orderDiscountPercent={so.orderDiscountPercent}
            shippingAmount={so.shippingAmount}
            handlingAmount={so.handlingAmount}
            total={displayTotal}
            status={so.status}
          />
        </div>
      </div>
    </div>
  );
}
