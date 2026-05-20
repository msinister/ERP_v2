import Link from 'next/link';
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
import { formatCurrency } from '@/lib/format';
import { UnapplyButton } from './unapply-button';

export type PaymentApplicationRow = {
  id: string;
  invoiceId: string;
  invoiceNumber: string;
  salesOrderId: string | null;
  amount: Prisma.Decimal;
  appliedAt: Date;
  reversedAt: Date | null;
  // Only direct payment applications can be unapplied here; CREDIT_TO_INVOICE
  // (APPLIED_CREDIT) rows draw from a credit memo, not the payment.
  kind: string;
};

export function ApplicationsCard({
  paymentId,
  paymentStatus,
  rows,
}: {
  paymentId: string;
  paymentStatus: string;
  rows: PaymentApplicationRow[];
}) {
  // The Unapply action is only meaningful while the payment is live and
  // for live direct-payment allocations.
  const canUnapplyAny =
    paymentStatus === 'RECORDED' &&
    rows.some((r) => !r.reversedAt && r.kind === 'PAYMENT_TO_INVOICE');
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Applied to invoices</CardTitle>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Each invoice this payment was applied to. Reversed applications
          stay listed (dimmed) for the audit trail.
        </p>
      </CardHeader>
      <CardContent className="px-0">
        {rows.length === 0 ? (
          <p className="px-6 text-sm text-muted-foreground">
            Not applied to any invoice — the full amount is unapplied
            credit on the customer.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/30 hover:bg-muted/30">
                <TableHead className="pl-6">Invoice</TableHead>
                <TableHead>Date applied</TableHead>
                <TableHead className="text-right">Amount applied</TableHead>
                <TableHead>Status</TableHead>
                {canUnapplyAny ? <TableHead className="pr-6 w-0" /> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => {
                const reversed = r.reversedAt != null;
                return (
                  <TableRow key={r.id} className={reversed ? 'opacity-60' : ''}>
                    <TableCell className="pl-6 font-mono text-xs">
                      {r.salesOrderId ? (
                        <Link
                          href={`/sales-orders/${r.salesOrderId}`}
                          className="text-primary hover:underline"
                        >
                          {r.invoiceNumber}
                        </Link>
                      ) : (
                        <span>{r.invoiceNumber}</span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDate(r.appliedAt)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatCurrency(r.amount)}
                    </TableCell>
                    <TableCell>
                      {reversed ? (
                        <Badge
                          variant="outline"
                          className="text-muted-foreground"
                        >
                          Unapplied
                        </Badge>
                      ) : (
                        <Badge variant="secondary">Applied</Badge>
                      )}
                    </TableCell>
                    {canUnapplyAny ? (
                      <TableCell className="pr-6 text-right">
                        {!reversed && r.kind === 'PAYMENT_TO_INVOICE' ? (
                          <UnapplyButton
                            paymentId={paymentId}
                            applicationId={r.id}
                            invoiceNumber={r.invoiceNumber}
                            amount={r.amount.toString()}
                          />
                        ) : null}
                      </TableCell>
                    ) : null}
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

function formatDate(d: Date): string {
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}
