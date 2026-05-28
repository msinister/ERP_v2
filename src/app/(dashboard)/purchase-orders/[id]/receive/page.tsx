import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import { db } from '@/lib/db';
import { requirePagePermission } from '@/lib/permissions/requirePagePermission';
import {
  ReceiveForm,
  type ReceiveLineSeed,
  type WarehouseOption,
} from './_components/receive-form';

export const revalidate = 0;

export default async function ReceivePurchaseOrderPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requirePagePermission('vendors.receive');
  const { id } = await params;
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
              product: { select: { name: true } },
            },
          },
          warehouse: { select: { id: true, code: true, name: true } },
        },
        orderBy: { createdAt: 'asc' },
      },
    },
  });
  if (!po) notFound();

  // Only receivable in CONFIRMED / PARTIALLY_RECEIVED — service rejects
  // otherwise. Surface as a redirect to detail rather than letting the
  // form load and then fail on submit.
  if (po.status !== 'CONFIRMED' && po.status !== 'PARTIALLY_RECEIVED') {
    redirect(`/purchase-orders/${po.id}`);
  }

  // Distinct warehouses across the PO lines. Pilot has one warehouse,
  // so this is almost always a single entry. If a PO ever spans
  // multiple warehouses, the receive form filters lines to the chosen
  // warehouse since validateReceiptLines requires line.warehouseId ===
  // receipt.warehouseId.
  const warehouseMap = new Map<string, WarehouseOption>();
  for (const l of po.lines) {
    if (!warehouseMap.has(l.warehouse.id)) {
      warehouseMap.set(l.warehouse.id, {
        id: l.warehouse.id,
        code: l.warehouse.code,
        name: l.warehouse.name,
      });
    }
  }
  const warehouses = Array.from(warehouseMap.values());

  const lineSeeds: ReceiveLineSeed[] = po.lines.map((l) => {
    const remaining = l.qtyOrdered.minus(l.qtyReceived);
    return {
      purchaseOrderLineId: l.id,
      variantId: l.variant.id,
      sku: l.variant.sku,
      productName: l.variant.product.name,
      variantName: l.variant.name,
      warehouseId: l.warehouse.id,
      warehouseCode: l.warehouse.code,
      qtyOrdered: l.qtyOrdered.toString(),
      qtyAlreadyReceived: l.qtyReceived.toString(),
      qtyRemaining: remaining.toString(),
      unitCost: l.unitCost.toString(),
      // Pre-check the line if any qty remains (Q8 from discovery). The
      // operator can uncheck individual lines to skip them.
      defaultReceive: remaining.greaterThan(0),
      // Pre-fill qty input with the remaining qty (Q8). Operator can
      // adjust up (over-receive is allowed-with-warning) or down.
      defaultQty: remaining.greaterThan(0) ? remaining.toString() : '0',
    };
  });

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Link
          href={`/purchase-orders/${po.id}`}
          className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="size-3.5" />
          {po.number}
        </Link>
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Receive PO</h1>
          <p className="text-sm text-muted-foreground">
            Posting consumes inventory, writes the FIFO layer, posts the GL
            leg (DR Inventory / CR Accrued Receipts), and auto-drafts a
            vendor bill for AP to confirm.
          </p>
        </div>
      </div>

      <ReceiveForm
        purchaseOrderId={po.id}
        purchaseOrderNumber={po.number}
        vendor={po.vendor}
        warehouses={warehouses}
        lines={lineSeeds}
      />
    </div>
  );
}
