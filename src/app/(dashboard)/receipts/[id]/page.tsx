import { Prisma } from '@/generated/tenant';
import { notFound } from 'next/navigation';
import { db } from '@/lib/db';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { formatCurrency } from '@/lib/format';
import { resolveLineImageUrl } from '@/lib/products/lineItemImage';
import { ReceiptHeader } from './_components/header';
import {
  ReceiptLinesTable,
  type ReceiptLineRow,
} from './_components/lines-table';
import {
  ReceiptInfoCard,
  type ReceiptBillRef,
} from './_components/info-card';

// Always live (no caching) — receipt status flips Draft → Posted →
// Cancelled and the linked bill draft auto-appears on post.
export const revalidate = 0;

export default async function ReceiptDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  // Single round-trip pulling the receipt, its lines (with variant +
  // warehouse + linked PO line + parent PO number), the receipt's
  // warehouse, and the receipt's vendor.
  const receipt = await db.receipt.findFirst({
    where: { id, deletedAt: null },
    include: {
      vendor: { select: { id: true, code: true, name: true } },
      warehouse: { select: { code: true, name: true } },
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
          warehouse: { select: { code: true } },
          purchaseOrderLine: {
            select: {
              id: true,
              purchaseOrder: {
                select: { id: true, number: true, deletedAt: true },
              },
            },
          },
        },
        orderBy: { createdAt: 'asc' },
      },
    },
  });
  if (!receipt) notFound();

  // Linked bills via the M:N BillReceipt join. The auto-draft from
  // postReceipt produces one row here; AP staff can also link a manually
  // created bill spanning multiple receipts, which would surface as
  // additional entries.
  const billLinks = await db.billReceipt.findMany({
    where: { receiptId: receipt.id, bill: { deletedAt: null } },
    include: { bill: { select: { id: true, number: true, status: true } } },
  });
  const linkedBills: ReceiptBillRef[] = billLinks.map((bl) => ({
    id: bl.bill.id,
    number: bl.bill.number,
    status: bl.bill.status,
  }));

  const lineRows: ReceiptLineRow[] = receipt.lines.map((l) => ({
    id: l.id,
    sku: l.variant.sku,
    productName: l.variant.product.name,
    variantName: l.variant.name,
    warehouseCode: l.warehouse.code,
    qtyReceived: l.qtyReceived,
    unitCost: l.unitCost,
    purchaseOrder:
      l.purchaseOrderLine && !l.purchaseOrderLine.purchaseOrder.deletedAt
        ? {
            id: l.purchaseOrderLine.purchaseOrder.id,
            number: l.purchaseOrderLine.purchaseOrder.number,
          }
        : null,
    notes: l.notes,
    imageUrl: resolveLineImageUrl(l.variant),
  }));

  const total = receipt.lines.reduce(
    (acc, l) => acc.plus(l.qtyReceived.times(l.unitCost)),
    new Prisma.Decimal(0),
  );

  return (
    <div className="space-y-6">
      <ReceiptHeader
        receipt={{
          id: receipt.id,
          number: receipt.number,
          status: receipt.status,
          vendor: receipt.vendor,
          receivedAt: receipt.receivedAt,
          createdAt: receipt.createdAt,
        }}
      />

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="space-y-6">
          <ReceiptLinesTable lines={lineRows} />

          <ReceiptInfoCard
            warehouseCode={receipt.warehouse.code}
            warehouseName={receipt.warehouse.name}
            notes={receipt.notes}
            linkedBills={linkedBills}
          />
        </div>

        <div className="space-y-6 lg:sticky lg:top-6 lg:self-start">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Totals</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="space-y-2 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-muted-foreground">Lines</dt>
                  <dd className="tabular-nums">{receipt.lines.length}</dd>
                </div>
                <div className="my-2 border-t" />
                <div className="flex items-center justify-between gap-3">
                  <dt className="font-medium">Receipt total</dt>
                  <dd className="text-base font-semibold tabular-nums">
                    {formatCurrency(total)}
                  </dd>
                </div>
              </dl>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
