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
import { ApplyToInvoiceButton } from './apply-to-invoice-button';

export type CmApplicationRow = {
  id: string;
  invoiceId: string;
  invoiceNumber: string;
  amount: Prisma.Decimal;
  appliedAt: Date;
  reversedAt: Date | null;
  notes: string | null;
};

export function ApplicationsCard({
  creditMemoId,
  creditMemoNumber,
  creditMemoStatus,
  customerId,
  available,
  applications,
}: {
  creditMemoId: string;
  creditMemoNumber: string;
  creditMemoStatus: string;
  customerId: string;
  available: string;
  applications: CmApplicationRow[];
}) {
  const canApply = creditMemoStatus === 'CONFIRMED';

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="text-sm">Applications</CardTitle>
        {canApply ? (
          <ApplyToInvoiceButton
            creditMemoId={creditMemoId}
            creditMemoNumber={creditMemoNumber}
            customerId={customerId}
            available={available}
          />
        ) : null}
      </CardHeader>
      <CardContent className="px-0">
        {applications.length === 0 ? (
          <p className="px-6 text-sm text-muted-foreground">
            {canApply
              ? 'No applications yet — apply this credit to an open invoice.'
              : 'No applications — credit is not eligible.'}
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/30 hover:bg-muted/30">
                <TableHead className="pl-6">Invoice</TableHead>
                <TableHead>Applied date</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Source</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {applications.map((a) => {
                const reversed = a.reversedAt != null;
                // The confirm-time auto-app carries an internal marker
                // in notes. Show it as such so users understand why it
                // exists even though they didn't create it.
                const isAuto =
                  a.notes === '__auto_apply_on_confirm__' ||
                  a.notes?.startsWith('__auto_apply_on_confirm__');
                return (
                  <TableRow key={a.id}>
                    <TableCell className="pl-6 font-mono text-xs">
                      <Link
                        href={`/invoices/${a.invoiceId}`}
                        className="text-foreground underline-offset-2 hover:underline"
                      >
                        {a.invoiceNumber}
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDate(a.appliedAt)}
                    </TableCell>
                    <TableCell
                      className={
                        'text-right tabular-nums ' +
                        (reversed ? 'text-muted-foreground line-through' : '')
                      }
                    >
                      {formatCurrency(a.amount)}
                    </TableCell>
                    <TableCell>
                      {reversed ? (
                        <Badge variant="outline" className="text-muted-foreground">
                          Reversed {a.reversedAt ? formatDate(a.reversedAt) : ''}
                        </Badge>
                      ) : (
                        <Badge variant="secondary">Applied</Badge>
                      )}
                    </TableCell>
                    <TableCell className="pr-6 text-xs text-muted-foreground">
                      {isAuto ? 'Auto (on confirm)' : 'Manual'}
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

function formatDate(d: Date): string {
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}
