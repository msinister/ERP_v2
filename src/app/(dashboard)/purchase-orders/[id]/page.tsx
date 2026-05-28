import { notFound } from 'next/navigation';
import { AccountType, Prisma } from '@/generated/tenant';
import { db } from '@/lib/db';
import { requirePagePermission } from '@/lib/permissions/requirePagePermission';
import { listAccounts } from '@/server/services/glAccounts';
import { resolveLineImageUrl } from '@/lib/products/lineItemImage';
import { rollupShipmentStatus } from '@/lib/po/shipmentRollup';
import { PurchaseOrderHeader } from './_components/header';
import { PurchaseOrderLinesTable } from './_components/lines-table';
import { PurchaseOrderTotalsCard } from './_components/totals-card';
import { PurchaseOrderInfoCard } from './_components/info-card';
import {
  PurchaseOrderReceiptsTable,
  type ReceiptRow,
} from './_components/receipts-table';
import { ShipmentsCard, type ShipmentRow } from './_components/shipments-card';
import {
  PoPaymentsCard,
  type PoPaymentRow,
  type CashAccountOption,
} from './_components/po-payments-card';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { OrderTagsEditor } from '@/components/shared/order-tags-editor';

// Always live (no caching) — PO status and qtyReceived flip as
// receipts get posted; we want every visit to reflect current state.
export const revalidate = 0;

export default async function PurchaseOrderDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requirePagePermission('vendors.view');
  const { id } = await params;

  // Single round-trip: PO with vendor + lines (variant + warehouse +
  // receiptLines) + shipments + payments (with cash account + live
  // applications). Parallel with the active GL account list (filtered to
  // ASSET + LIABILITY) that feeds the record-deposit dialog's picker.
  const [po, allAccounts] = await Promise.all([
    db.purchaseOrder.findFirst({
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
        shipments: {
          where: { deletedAt: null },
          orderBy: { createdAt: 'desc' },
        },
        payments: {
          where: { deletedAt: null },
          orderBy: { paymentDate: 'desc' },
          include: {
            cashAccount: { select: { code: true, name: true } },
            applications: {
              where: { reversedAt: null },
              include: { bill: { select: { id: true, number: true } } },
            },
          },
        },
        tags: {
          include: { tag: { select: { id: true, name: true } } },
          orderBy: { createdAt: 'asc' },
        },
      },
    }),
    listAccounts(db, { active: true, take: 500 }),
  ]);
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

  // PO total (Σ qtyOrdered × unitCost) drives the payments card's
  // PO Total | Paid | Balance summary row.
  const poTotal = po.lines.reduce(
    (acc, l) => acc.plus(l.qtyOrdered.times(l.unitCost)),
    new Prisma.Decimal(0),
  );
  // Net cash deposited = sum of RECORDED (non-reversed) deposits.
  const totalPaid = po.payments
    .filter((p) => p.status === 'RECORDED')
    .reduce((acc, p) => acc.plus(p.amount), new Prisma.Decimal(0));
  const balance = poTotal.minus(totalPaid);

  const shipmentRows: ShipmentRow[] = po.shipments.map((s) => ({
    id: s.id,
    shipmentStatus: s.shipmentStatus,
    trackingNumber: s.trackingNumber,
    carrierName: s.carrierName,
    trackingUrl: s.trackingUrl,
    cartonCount: s.cartonCount,
    totalWeight: s.totalWeight ? s.totalWeight.toString() : null,
    weightUnit: s.weightUnit,
    estimatedArrival: s.estimatedArrival,
    notes: s.notes,
  }));

  const shipmentRollup = rollupShipmentStatus(
    po.shipments.map((s) => s.shipmentStatus),
  );

  const paymentRows: PoPaymentRow[] = po.payments.map((p) => ({
    id: p.id,
    number: p.number,
    paymentDate: p.paymentDate,
    amount: p.amount.toString(),
    method: p.method,
    status: p.status,
    reference: p.reference,
    cashAccountCode: p.cashAccount?.code ?? null,
    cashAccountName: p.cashAccount?.name ?? null,
    appliedAmount: p.appliedAmount.toString(),
    reversedReason: p.reversedReason,
    applications: p.applications.map((a) => ({
      id: a.id,
      billId: a.bill.id,
      billNumber: a.bill.number,
      amount: a.amount.toString(),
    })),
  }));

  const cashAccounts: CashAccountOption[] = allAccounts
    .filter(
      (a) => a.type === AccountType.ASSET || a.type === AccountType.LIABILITY,
    )
    .map((a) => ({ id: a.id, code: a.code, name: a.name }));

  // Deposits can be recorded while the PO is live (not cancelled). DRAFT is
  // unusual but allowed — operators sometimes wire a deposit before the PO
  // is formally confirmed.
  const canRecordPayment = po.status !== 'CANCELLED';

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
          shipmentRollup,
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

          <ShipmentsCard
            purchaseOrderId={po.id}
            shipments={shipmentRows}
          />

          <PoPaymentsCard
            purchaseOrderId={po.id}
            canRecord={canRecordPayment}
            currency={po.currency ?? 'USD'}
            poTotal={poTotal.toString()}
            totalPaid={totalPaid.toString()}
            balance={balance.toString()}
            cashAccounts={cashAccounts}
            payments={paymentRows}
          />

          <PurchaseOrderInfoCard
            po={{
              expectedReceiveDate: po.expectedReceiveDate,
              currency: po.currency ?? 'USD',
              notes: po.notes,
              closeReason: po.closeReason,
            }}
          />

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Tags</CardTitle>
            </CardHeader>
            <CardContent>
              <OrderTagsEditor
                apiPath={`/api/purchase-orders/${po.id}/tags`}
                initialTags={po.tags.map((a) => ({
                  id: a.tag.id,
                  name: a.tag.name,
                }))}
              />
            </CardContent>
          </Card>

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
