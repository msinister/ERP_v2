import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import { Prisma } from '@/generated/tenant';
import { db } from '@/lib/db';
import { getAccountTransfer } from '@/server/services/accountTransfers';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatCurrency } from '@/lib/format';

export const revalidate = 0;

export default async function TransferDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const transfer = await getAccountTransfer(db, id);
  if (!transfer) notFound();

  const totalDebit = transfer.lines.reduce(
    (acc, l) => acc.plus(l.debit),
    new Prisma.Decimal(0),
  );
  const totalCredit = transfer.lines.reduce(
    (acc, l) => acc.plus(l.credit),
    new Prisma.Decimal(0),
  );

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Link
          href="/transfers"
          className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="size-3.5" />
          Transfers
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="font-mono text-2xl font-semibold tracking-tight">
            {transfer.number}
          </h1>
          {transfer.reversedAt ? (
            <Badge variant="destructive">Reversed</Badge>
          ) : null}
        </div>
        <p className="text-sm text-muted-foreground">{transfer.description}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Details</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
            <Detail label="Date" value={formatDate(transfer.postedAt)} />
            <Detail label="Reference" value={transfer.reference ?? '—'} mono />
            <Detail
              label="Reversed"
              value={transfer.reversedAt ? formatDate(transfer.reversedAt) : '—'}
            />
            <Detail label="JE #" value={transfer.number} mono />
            {transfer.notes ? (
              <div className="col-span-2 space-y-0.5 sm:col-span-4">
                <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  Notes
                </dt>
                <dd className="whitespace-pre-line">{transfer.notes}</dd>
              </div>
            ) : null}
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Journal entry</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Account</TableHead>
                <TableHead>Memo</TableHead>
                <TableHead className="text-right">Debit</TableHead>
                <TableHead className="text-right">Credit</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {transfer.lines.map((l) => (
                <TableRow key={l.id}>
                  <TableCell>
                    <span className="font-mono text-xs text-muted-foreground">
                      {l.account.code}
                    </span>{' '}
                    {l.account.name}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {l.memo ?? ''}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {l.debit.greaterThan(0) ? formatCurrency(l.debit) : ''}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {l.credit.greaterThan(0) ? formatCurrency(l.credit) : ''}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell colSpan={2} className="font-medium">
                  Totals
                </TableCell>
                <TableCell className="text-right tabular-nums font-medium">
                  {formatCurrency(totalDebit)}
                </TableCell>
                <TableCell className="text-right tabular-nums font-medium">
                  {formatCurrency(totalCredit)}
                </TableCell>
              </TableRow>
            </TableFooter>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

function Detail({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="space-y-0.5">
      <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className={mono ? 'font-mono text-xs' : ''}>{value}</dd>
    </div>
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
