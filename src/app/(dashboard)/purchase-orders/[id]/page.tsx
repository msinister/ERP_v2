import { notFound } from 'next/navigation';
import { db } from '@/lib/db';
import { resolveLineImageUrl } from '@/lib/products/lineItemImage';
import { PurchaseOrderHeader } from './_components/header';
import { PurchaseOrderLinesTable } from './_components/lines-table';
import { PurchaseOrderTotalsCard } from './_components/totals-card';
import { PurchaseOrderInfoCard } from './_components/info-card';
import {
  PurchaseOrderReceiptsTable,
  type ReceiptRow,
} from './_components/receipts-table';

// Always live (no caching) — PO status and qtyReceived flip as
// receipts get posted; we want every visit to reflect current state.
export const revalidate = 0;

export default async function PurchaseOrderDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  // Single round-trip: PO with vendor + lines (variant + warehouse +
  // receiptLines). We pull each receiptLine's parent receipt so the
  // receipts table can collapse them by receipt id without a second
  // findMany on receipts.
  const po = await db.purchaseOrder.findFirst({
    where: { id, deletedAt: null },
    include: {
      vendor: { select: { id: true, code: true, name: true } },
      lines: {
        where: { deletedAt: null },
        include: {
          variant: {
            select: {
              id: true,
              sku: true,
              name: true,
              imageUrl: true,
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
            },
          },
          warehouse: { select: { code: true, name: true } },
          receiptLines: {
            where: { deletedAt: null },
            include: {
              receipt: {
                select: {
                  id: true,
                  number: true,
                  status: true,
                  receivedAt: true,
                  createdAt: true,
                  deletedAt: true,
                },
              },
            },
          },
        },
        orderBy: { createdAt: 'asc' },
      },
    },
  });
  if (!po) notFound();

  // Collapse receipt lines (already filtered to this PO via the
  // include) by receipt id. Skip soft-deleted parent receipts and the
  // service-side CANCELLED status keeps its row (visible for audit).
  const receiptMap = new Map<string, ReceiptRow>();
  for (const line of po.lines) {
    for (const rl of line.receiptLines) {
      const r = rl.receipt;
      if (!r || r.deletedAt) continue;
      const existing = receiptMap.get(r.id);
      const matchingLine = {
        qtyReceived: rl.qtyReceived,
        unitCost: rl.unitCost,
      };
      if (existing) {
        existing.matchingLines.push(matchingLine);
      } else {
        receiptMap.set(r.id, {
          id: r.id,
          number: r.number,
          status: r.status,
          receivedAt: r.receivedAt,
          createdAt: r.createdAt,
          matchingLines: [matchingLine],
        });
      }
    }
  }
  // Sort newest-first by receivedAt (fall back to createdAt for DRAFTs
  // that haven't posted yet).
  const receipts = Array.from(receiptMap.values()).sort((a, b) => {
    const at = (a.receivedAt ?? a.createdAt).getTime();
    const bt = (b.receivedAt ?? b.createdAt).getTime();
    return bt - at;
  });

  return (
    <div className="space-y-6">
      <PurchaseOrderHeader
        po={{
          id: po.id,
          number: po.number,
          status: po.status,
          vendor: po.vendor,
          orderDate: po.createdAt,
          confirmedAt: po.confirmedAt,
          closedAt: po.closedAt,
          cancelledAt: po.cancelledAt,
        }}
      />

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="space-y-6">
          <PurchaseOrderLinesTable
            purchaseOrderId={po.id}
            status={po.status}
            lines={po.lines.map((l) => ({
              id: l.id,
              sku: l.variant.sku,
              productName: l.variant.product.name,
              variantName: l.variant.name,
              warehouseCode: l.warehouse.code,
              qtyOrdered: l.qtyOrdered,
              qtyReceived: l.qtyReceived,
              unitCost: l.unitCost,
              vendorSku: l.vendorSku,
              manufacturerPartNumber: l.manufacturerPartNumber,
              notes: l.notes,
              imageUrl: resolveLineImageUrl(l.variant),
            }))}
          />

          <PurchaseOrderInfoCard
            po={{
              expectedReceiveDate: po.expectedReceiveDate,
              currency: po.currency ?? 'USD',
              notes: po.notes,
              closeReason: po.closeReason,
            }}
          />

          <PurchaseOrderReceiptsTable receipts={receipts} />
        </div>

        <div className="space-y-6 lg:sticky lg:top-6 lg:self-start">
          <PurchaseOrderTotalsCard
            lines={po.lines}
            currency={po.currency ?? 'USD'}
          />
        </div>
      </div>
    </div>
  );
}
