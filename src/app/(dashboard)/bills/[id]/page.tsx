import { notFound } from 'next/navigation';
import { AccountType } from '@/generated/tenant';
import { db } from '@/lib/db';
import { listAccounts } from '@/server/services/glAccounts';
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
import {
  PaymentsCard,
  type PaymentRow,
} from './_components/payments-card';
import type { CashAccountOption } from './_components/record-payment-dialog';
import {
  AppliedCreditsCard,
  type AppliedCreditRow,
} from './_components/applied-credits-card';

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
  // Three parallel reads: the bill (with vendor + lines + M:N joins +
  // payments + cashAccount on each payment), and the active GL account
  // list filtered to ASSET so the record-payment dialog has a picker.
  const [bill, allAccounts] = await Promise.all([
    db.bill.findFirst({
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
        payments: {
          where: { deletedAt: null },
          include: {
            cashAccount: { select: { code: true, name: true } },
          },
          orderBy: { paymentDate: 'desc' },
        },
        creditApplications: {
          include: {
            vendorCredit: { select: { id: true, number: true } },
          },
          orderBy: { appliedAt: 'desc' },
        },
      },
    }),
    listAccounts(db, { active: true, take: 500 }),
  ]);
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

  const paymentRows: PaymentRow[] = bill.payments.map((p) => ({
    id: p.id,
    number: p.number,
    paymentDate: p.paymentDate,
    amount: p.amount,
    method: p.method,
    status: p.status,
    reference: p.reference,
    cashAccountCode: p.cashAccount?.code ?? null,
    cashAccountName: p.cashAccount?.name ?? null,
    reversedAt: p.reversedAt,
    reversedReason: p.reversedReason,
  }));

  const cashAccounts: CashAccountOption[] = allAccounts
    .filter((a) => a.type === AccountType.ASSET)
    .map((a) => ({ id: a.id, code: a.code, name: a.name }));

  const remainingBalance = bill.total
    .minus(bill.amountPaid)
    .minus(bill.amountCredited)
    .toString();

  const appliedCreditRows: AppliedCreditRow[] = bill.creditApplications.map(
    (a) => ({
      id: a.id,
      vendorCreditId: a.vendorCreditId,
      vendorCreditNumber: a.vendorCredit.number,
      amount: a.amount,
      appliedAt: a.appliedAt,
      reversedAt: a.reversedAt,
      notes: a.notes,
    }),
  );

  // Hide the payments + applied-credits cards entirely for DRAFT bills
  // (no AP entry yet); show them for CONFIRMED (with the action button)
  // and for CANCELLED (read-only) when historical rows exist.
  const showPaymentsCard =
    bill.status !== 'DRAFT' || paymentRows.length > 0;
  const showAppliedCreditsCard =
    bill.status !== 'DRAFT' || appliedCreditRows.length > 0;

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

          {showPaymentsCard ? (
            <PaymentsCard
              billId={bill.id}
              billNumber={bill.number}
              billStatus={bill.status}
              remainingBalance={remainingBalance}
              cashAccounts={cashAccounts}
              payments={paymentRows}
            />
          ) : null}

          {showAppliedCreditsCard ? (
            <AppliedCreditsCard
              billId={bill.id}
              billNumber={bill.number}
              billStatus={bill.status}
              vendorId={bill.vendorId}
              remainingBalance={remainingBalance}
              applications={appliedCreditRows}
            />
          ) : null}

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
