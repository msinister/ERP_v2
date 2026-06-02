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

export type DepositApplicationRow = {
  id: string;
  poPaymentId: string;
  poPaymentNumber: string;
  method: string | null;
  cashAccountCode: string | null;
  cashAccountName: string | null;
  amount: Prisma.Decimal;
  appliedAt: Date;
  reversedAt: Date | null;
};

export function DepositApplicationsCard({
  applications,
}: {
  applications: DepositApplicationRow[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">PO deposits applied</CardTitle>
      </CardHeader>
      <CardContent className="px-0">
        {applications.length === 0 ? (
          <p className="px-6 text-sm text-muted-foreground">
            No PO deposits applied.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/30 hover:bg-muted/30">
                <TableHead className="pl-6">Deposit #</TableHead>
                <TableHead>Applied date</TableHead>
                <TableHead>Method</TableHead>
                <TableHead>Cash account</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead className="pr-6">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {applications.map((a) => {
                const reversed = a.reversedAt != null;
                return (
                  <TableRow key={a.id}>
                    <TableCell className="pl-6 font-mono text-xs">
                      <Link
                        href={`/purchase-orders?highlight=${a.poPaymentId}`}
                        className="text-foreground underline-offset-2 hover:underline"
                      >
                        {a.poPaymentNumber}
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDate(a.appliedAt)}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {a.method ?? '—'}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {a.cashAccountCode
                        ? `${a.cashAccountCode} — ${a.cashAccountName}`
                        : '—'}
                    </TableCell>
                    <TableCell
                      className={
                        'text-right tabular-nums ' +
                        (reversed ? 'text-muted-foreground line-through' : '')
                      }
                    >
                      {formatCurrency(a.amount)}
                    </TableCell>
                    <TableCell className="pr-6">
                      {reversed ? (
                        <Badge variant="outline" className="text-muted-foreground">
                          Reversed {a.reversedAt ? formatDate(a.reversedAt) : ''}
                        </Badge>
                      ) : (
                        <Badge variant="secondary">Applied</Badge>
                      )}
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
