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
import {
  RecordPaymentButton,
} from './record-payment-button';
import type { CashAccountOption } from './record-payment-dialog';
import { PaymentRowActions } from './payment-row-actions';

export type PaymentRow = {
  id: string;
  number: string;
  paymentDate: Date;
  amount: Prisma.Decimal;
  method: string;
  status: string;
  reference: string | null;
  cashAccountCode: string | null;
  cashAccountName: string | null;
  reversedAt: Date | null;
  reversedReason: string | null;
};

export function PaymentsCard({
  billId,
  billNumber,
  billStatus,
  remainingBalance,
  cashAccounts,
  payments,
}: {
  billId: string;
  billNumber: string;
  billStatus: string;
  remainingBalance: string;
  cashAccounts: CashAccountOption[];
  payments: PaymentRow[];
}) {
  // Record-payment is only available on CONFIRMED bills (service-side
  // rule). DRAFT bills have no AP balance; CANCELLED bills have a $0
  // balance and the service blocks new payments.
  const canRecord = billStatus === 'CONFIRMED';

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="text-sm">Payments</CardTitle>
        {canRecord ? (
          <RecordPaymentButton
            billId={billId}
            billNumber={billNumber}
            remainingBalance={remainingBalance}
            cashAccounts={cashAccounts}
          />
        ) : null}
      </CardHeader>
      <CardContent className="px-0">
        {payments.length === 0 ? (
          <p className="px-6 text-sm text-muted-foreground">
            {canRecord
              ? 'No payments recorded yet.'
              : 'No payments — bill is not eligible for new payments.'}
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/30 hover:bg-muted/30">
                <TableHead className="pl-6">Payment #</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Method</TableHead>
                <TableHead>Cash account</TableHead>
                <TableHead>Reference</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="pr-6 w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {payments.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="pl-6 font-mono text-xs">
                    {p.number}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDate(p.paymentDate)}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatMethod(p.method)}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {p.cashAccountCode ? (
                      <div className="flex flex-col leading-tight">
                        <span>{p.cashAccountCode}</span>
                        {p.cashAccountName ? (
                          <span className="font-sans text-[10px]">
                            {p.cashAccountName}
                          </span>
                        ) : null}
                      </div>
                    ) : (
                      '—'
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {p.reference ?? '—'}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatCurrency(p.amount)}
                  </TableCell>
                  <TableCell>
                    <PaymentStatusBadge status={p.status} />
                    {p.status === 'REVERSED' && p.reversedReason ? (
                      <div
                        className="mt-0.5 max-w-[16ch] truncate text-[10px] text-muted-foreground"
                        title={p.reversedReason}
                      >
                        {p.reversedReason}
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell className="pr-6">
                    <PaymentRowActions
                      paymentId={p.id}
                      paymentNumber={p.number}
                      status={p.status}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function PaymentStatusBadge({ status }: { status: string }) {
  const label = formatStatusLabel(status);
  if (status === 'RECORDED') return <Badge variant="secondary">{label}</Badge>;
  return (
    <Badge variant="outline" className="text-muted-foreground">
      {label}
    </Badge>
  );
}

function formatMethod(value: string): string {
  if (value === 'CREDIT_CARD') return 'Credit card';
  if (value === 'MONEY_ORDER') return 'Money order';
  // ACH / WIRE / CHECK / CASH all read fine titlecased.
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
