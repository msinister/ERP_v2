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
import { ApplyToBillButton } from './apply-to-bill-button';
import { ApplicationRowActions } from './application-row-actions';

export type VcApplicationRow = {
  id: string;
  billId: string;
  billNumber: string;
  amount: Prisma.Decimal;
  appliedAt: Date;
  reversedAt: Date | null;
  notes: string | null;
};

export function ApplicationsCard({
  vendorCreditId,
  vendorCreditNumber,
  vendorCreditStatus,
  vendorId,
  available,
  applications,
}: {
  vendorCreditId: string;
  vendorCreditNumber: string;
  vendorCreditStatus: string;
  vendorId: string;
  available: string;
  applications: VcApplicationRow[];
}) {
  const canApply = vendorCreditStatus === 'CONFIRMED';

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="text-sm">Applications</CardTitle>
        {canApply ? (
          <ApplyToBillButton
            vendorCreditId={vendorCreditId}
            vendorCreditNumber={vendorCreditNumber}
            vendorId={vendorId}
            available={available}
          />
        ) : null}
      </CardHeader>
      <CardContent className="px-0">
        {applications.length === 0 ? (
          <p className="px-6 text-sm text-muted-foreground">
            {canApply
              ? 'No applications yet — apply this credit to an open bill.'
              : 'No applications — credit is not eligible.'}
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/30 hover:bg-muted/30">
                <TableHead className="pl-6">Bill</TableHead>
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
                        href={`/bills/${a.billId}`}
                        className="text-foreground underline-offset-2 hover:underline"
                      >
                        {a.billNumber}
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
                        billNumber={a.billNumber}
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
