import { notFound } from 'next/navigation';
import { db } from '@/lib/db';
import { BillHeader } from './_components/header';
import {
  BillLinesTable,
  type BillLineRow,
} from './_components/lines-table';
import { BillTotalsCard } from './_components/totals-card';
import {
  BillInfoCard,
  type LinkedPurchaseOrder,
  type LinkedReceipt,
} from './_components/info-card';

// Always live — bill status and payment denorms (amountPaid /
// amountCredited / paymentStatus) flip as payments and credits are
// recorded against it.
export const revalidate = 0;

export default async function BillDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  // Single round-trip pulls bill + vendor + lines (with variant or
  // expense account, plus the optional source receipt line + receipt
  // number) + the M:N join rows enriched with parent number for the
  // linked-POs and linked-receipts panels.
  const bill = await db.bill.findFirst({
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
          receiptLine: {
            select: {
              id: true,
              receipt: { select: { id: true, number: true } },
            },
          },
          expenseAccount: { select: { id: true, code: true, name: true } },
        },
        orderBy: { lineNumber: 'asc' },
      },
      receipts: {
        include: { receipt: { select: { id: true, number: true } } },
      },
      purchaseOrders: {
        include: {
          purchaseOrder: { select: { id: true, number: true } },
        },
      },
    },
  });
  if (!bill) notFound();

  const lineRows: BillLineRow[] = bill.lines.map((l) => ({
    id: l.id,
    description: l.description,
    qty: l.qty,
    unitCost: l.unitCost,
    lineTotal: l.lineTotal,
    notes: l.notes,
    variant: l.variant
      ? {
          id: l.variant.id,
          sku: l.variant.sku,
          name: l.variant.name,
          productName: l.variant.product.name,
        }
      : null,
    receiptLine: l.receiptLine
      ? {
          id: l.receiptLine.id,
          receipt: l.receiptLine.receipt,
        }
      : null,
    expenseAccount: l.expenseAccount,
  }));

  const linkedReceipts: LinkedReceipt[] = bill.receipts.map((br) => ({
    id: br.receipt.id,
    number: br.receipt.number,
  }));
  const linkedPurchaseOrders: LinkedPurchaseOrder[] = bill.purchaseOrders.map(
    (bp) => ({
      id: bp.purchaseOrder.id,
      number: bp.purchaseOrder.number,
    }),
  );

  // Cancel is service-rejected when amountPaid + amountCredited > 0.
  // Mirror that in the UI as a disabled menu item up front (Q2 from
  // discovery).
  const hasAppliedMoney =
    bill.amountPaid.greaterThan(0) || bill.amountCredited.greaterThan(0);

  return (
    <div className="space-y-6">
      <BillHeader
        bill={{
          id: bill.id,
          number: bill.number,
          status: bill.status,
          paymentStatus: bill.paymentStatus,
          source: bill.source,
          vendor: bill.vendor,
          billDate: bill.billDate,
          dueDate: bill.dueDate,
          confirmedAt: bill.confirmedAt,
          cancelledAt: bill.cancelledAt,
          hasAppliedMoney,
        }}
      />

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="space-y-6">
          <BillLinesTable lines={lineRows} source={bill.source} />

          <BillInfoCard
            bill={{
              vendorReference: bill.vendorReference,
              currency: bill.currency ?? 'USD',
              notes: bill.notes,
              cancelReason: bill.cancelReason,
            }}
            linkedReceipts={linkedReceipts}
            linkedPurchaseOrders={linkedPurchaseOrders}
          />
        </div>

        <div className="space-y-6">
          <BillTotalsCard
            status={bill.status}
            subtotal={bill.subtotal}
            freight={bill.freight}
            tax={bill.tax}
            total={bill.total}
            amountPaid={bill.amountPaid}
            amountCredited={bill.amountCredited}
          />
        </div>
      </div>
    </div>
  );
}
