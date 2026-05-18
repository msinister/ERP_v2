import type { Prisma } from '@/generated/tenant';
import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatCurrency, formatStatusLabel } from '@/lib/format';
import { RecordCustomerPaymentButton } from '@/components/shared/record-customer-payment-button';

// Per-application row. PAYMENT_TO_INVOICE rows reference a Payment;
// CREDIT_TO_INVOICE rows reference a CreditMemo. Caller flattens
// both into this shape so the table renders uniformly.
//
// `reversedAt` is set when the operator reverses the source payment
// (via reversePayment) — the application is automatically marked
// reversed in that same transaction. Reversed rows render dimmed so
// the audit trail stays visible.
export type AppliedRow = {
  id: string;
  kind: 'PAYMENT' | 'CREDIT_MEMO';
  /** Payment number (PMT-…) or CM number (CM-…). */
  sourceNumber: string;
  appliedAmount: Prisma.Decimal;
  appliedAt: Date;
  method: string | null; // null for CM-sourced rows
  reference: string | null;
  /** Status of the SOURCE doc (RECORDED / REVERSED for payments;
   * DRAFT / CONFIRMED / VOIDED for CMs). */
  sourceStatus: string;
  reversedAt: Date | null;
};

export function PaymentsAppliedCard({
  invoice,
  customerId,
  customerName,
  rows,
}: {
  invoice: {
    id: string;
    number: string;
    total: string;
    amountPaid: string;
    amountCredited: string;
    balance: string;
    status: string;
  };
  customerId: string;
  customerName: string;
  rows: AppliedRow[];
}) {
  // Record-payment is offered when the invoice has a live balance.
  // VOIDED invoices have a $0 obligation and the service-level
  // recordPayment validator would refuse; gate the button here too
  // so the operator doesn't see an action that can't succeed.
  const balanceN = Number(invoice.balance);
  const canRecord =
    invoice.status !== 'VOIDED' &&
    Number.isFinite(balanceN) &&
    balanceN > 0;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <div>
          <CardTitle className="text-sm">Payments &amp; credits</CardTitle>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Against invoice{' '}
            <span className="font-mono">{invoice.number}</span> · balance{' '}
            {formatCurrency(invoice.balance)}
          </p>
        </div>
        {canRecord ? (
          <RecordCustomerPaymentButton
            customerId={customerId}
            customerName={customerName}
            targetInvoice={{
              invoiceId: invoice.id,
              invoiceNumber: invoice.number,
              remainingBalance: invoice.balance,
            }}
          />
        ) : null}
      </CardHeader>
      <CardContent className="px-0">
        {rows.length === 0 ? (
          <p className="px-6 text-sm text-muted-foreground">
            {canRecord
              ? 'No payments or credits applied yet.'
              : 'No payments or credits applied.'}
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/30 hover:bg-muted/30">
                <TableHead className="pl-6">Source</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Method</TableHead>
                <TableHead>Reference</TableHead>
                <TableHead className="text-right">Applied</TableHead>
                <TableHead className="pr-6">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => {
                const reversed = r.reversedAt != null;
                return (
                  <TableRow
                    key={r.id}
                    className={reversed ? 'opacity-60' : ''}
                  >
                    <TableCell className="pl-6 font-mono text-xs">
                      <div className="flex items-center gap-1.5">
                        <span>{r.sourceNumber}</span>
                        <Badge
                          variant="outline"
                          className="text-[10px] font-normal"
                        >
                          {r.kind === 'PAYMENT' ? 'Payment' : 'Credit'}
                        </Badge>
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDate(r.appliedAt)}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {r.method ? formatMethod(r.method) : '—'}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {r.reference ?? '—'}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatCurrency(r.appliedAmount)}
                    </TableCell>
                    <TableCell className="pr-6">
                      <SourceStatusBadge
                        kind={r.kind}
                        status={r.sourceStatus}
                      />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function SourceStatusBadge({
  kind,
  status,
}: {
  kind: 'PAYMENT' | 'CREDIT_MEMO';
  status: string;
}) {
  const label = formatStatusLabel(status);
  const muted = status === 'REVERSED' || status === 'VOIDED';
  if (muted) {
    return (
      <Badge variant="outline" className="text-muted-foreground">
        {label}
      </Badge>
    );
  }
  void kind;
  return <Badge variant="secondary">{label}</Badge>;
}

function formatMethod(value: string): string {
  if (value === 'CREDIT_CARD') return 'Credit card';
  if (value === 'MONEY_ORDER') return 'Money order';
  if (value === 'APPLIED_CREDIT') return 'Applied credit';
  return value.charAt(0) + value.slice(1).toLowerCase();
}

function formatDate(d: Date): string {
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}
