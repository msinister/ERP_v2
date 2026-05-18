import { notFound } from 'next/navigation';
import { Prisma, SalesOrderStatus } from '@/generated/tenant';
import { db } from '@/lib/db';
import { computeSalesOrderTotal } from '@/lib/ar/openSos';
import {
  lineItemImageVariantSelect,
  resolveLineImageUrl,
} from '@/lib/products/lineItemImage';
import { getOverShippingPolicy } from '@/server/services/overShipping';
import { computeWac, getLastPurchaseCost } from '@/server/services/wac';
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
        // createdAt + id tiebreaker: bundle-explode emits N lines
        // inside one transaction with effectively-identical
        // createdAt timestamps, so a single-key sort on createdAt
        // leaves Postgres free to swap their order between renders.
        // After an inline edit fires router.refresh(), the resorted
        // lines made the just-edited row appear to jump position.
        // Cuids are time-prefixed, so id-asc gives a stable secondary
        // ordering that matches the original insertion order.
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
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

  // Fetch the tenant-wide over-shipping policy once per page render —
  // QtyShippedInput uses it to decide whether to save immediately,
  // confirm-then-save, or refuse when qty > ordered. The setting falls
  // back to 'CONFIRM' when the row is missing.
  const overShippingPolicy = await getOverShippingPolicy(db);

  // Stock context + cost reference for each line — internal-only,
  // hidden from customer-facing documents and toggleable via the
  // Stock-info toggle. Batched: one InventoryItem query for all
  // (variantId, warehouseId) pairs on the order, then parallel
  // computeWac + getLastPurchaseCost per unique pair (typical order
  // is <20 lines, dedup keeps WAC work modest even for bundle
  // explodes that repeat the same variant).
  const stockKey = (variantId: string, warehouseId: string) =>
    `${variantId}::${warehouseId}`;
  const uniquePairs = Array.from(
    new Map(
      so.lines.map((l) => [
        stockKey(l.variantId, l.warehouseId),
        { variantId: l.variantId, warehouseId: l.warehouseId },
      ]),
    ).values(),
  );

  const [inventoryRows, costResults] = await Promise.all([
    uniquePairs.length === 0
      ? Promise.resolve([])
      : db.inventoryItem.findMany({
          where: {
            OR: uniquePairs.map((p) => ({
              variantId: p.variantId,
              warehouseId: p.warehouseId,
            })),
          },
          select: {
            variantId: true,
            warehouseId: true,
            onHand: true,
            reserved: true,
          },
        }),
    Promise.all(
      uniquePairs.map((p) =>
        Promise.all([
          computeWac(db, p.variantId, p.warehouseId),
          getLastPurchaseCost(db, p.variantId, p.warehouseId),
        ]),
      ),
    ),
  ]);

  const inventoryByKey = new Map<
    string,
    { onHand: Prisma.Decimal; reserved: Prisma.Decimal }
  >();
  for (const row of inventoryRows) {
    inventoryByKey.set(stockKey(row.variantId, row.warehouseId), {
      onHand: row.onHand,
      reserved: row.reserved,
    });
  }
  const costByKey = new Map<
    string,
    { wac: Prisma.Decimal | null; lastCost: Prisma.Decimal | null }
  >();
  uniquePairs.forEach((p, i) => {
    costByKey.set(stockKey(p.variantId, p.warehouseId), {
      wac: costResults[i][0],
      lastCost: costResults[i][1],
    });
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
            overShippingPolicy={overShippingPolicy}
            lines={so.lines.map((l) => {
              const key = stockKey(l.variantId, l.warehouseId);
              const inv = inventoryByKey.get(key);
              const cost = costByKey.get(key);
              return {
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
                onHand: inv?.onHand ?? null,
                // Available = onHand - reserved. Kept signed (no
                // clamp to zero) so the lines table can flag
                // oversold positions in red, matching how operators
                // think about commitment vs. stock.
                available:
                  inv == null ? null : inv.onHand.minus(inv.reserved),
                wac: cost?.wac ?? null,
                lastCost: cost?.lastCost ?? null,
              };
            })}
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
