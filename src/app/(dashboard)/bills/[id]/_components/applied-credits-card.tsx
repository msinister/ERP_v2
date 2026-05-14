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
import { ApplyCreditButton } from './apply-credit-button';
import { ApplicationRowActions } from './application-row-actions';

export type AppliedCreditRow = {
  id: string;
  vendorCreditId: string;
  vendorCreditNumber: string;
  amount: Prisma.Decimal;
  appliedAt: Date;
  reversedAt: Date | null;
  notes: string | null;
};

export function AppliedCreditsCard({
  billId,
  billNumber,
  billStatus,
  vendorId,
  remainingBalance,
  applications,
}: {
  billId: string;
  billNumber: string;
  billStatus: string;
  vendorId: string;
  remainingBalance: string;
  applications: AppliedCreditRow[];
}) {
  // Apply is service-rejected unless the bill is CONFIRMED. The button
  // also disables when bill remaining ≤ 0 (its own internal check).
  const canApply = billStatus === 'CONFIRMED';

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="text-sm">Applied credits</CardTitle>
        {canApply ? (
          <ApplyCreditButton
            billId={billId}
            billNumber={billNumber}
            vendorId={vendorId}
            remainingBalance={remainingBalance}
          />
        ) : null}
      </CardHeader>
      <CardContent className="px-0">
        {applications.length === 0 ? (
          <p className="px-6 text-sm text-muted-foreground">
            {canApply
              ? 'No vendor credits applied yet.'
              : 'No applied credits — bill is not eligible.'}
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/30 hover:bg-muted/30">
                <TableHead className="pl-6">VC #</TableHead>
                <TableHead>Applied date</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="pr-6 w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {applications.map((a) => {
                const reversed = a.reversedAt != null;
                return (
                  <TableRow key={a.id}>
                    <TableCell className="pl-6 font-mono text-xs">
                      <Link
                        href={`/vendor-credits/${a.vendorCreditId}`}
                        className="text-foreground underline-offset-2 hover:underline"
                      >
                        {a.vendorCreditNumber}
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
                    <TableCell className="pr-6">
                      <ApplicationRowActions
                        applicationId={a.id}
                        vendorCreditNumber={a.vendorCreditNumber}
                        reversed={reversed}
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

function formatDate(d: Date): string {
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}
