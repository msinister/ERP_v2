import Link from 'next/link';
import { Prisma } from '@/generated/tenant';
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

export type ReceiptRow = {
  id: string;
  number: string;
  status: string;
  receivedAt: Date | null;
  createdAt: Date;
  // Lines on this receipt that touch the PO we're viewing — pre-filtered
  // server-side. Other receipt lines for other POs are not shown.
  matchingLines: Array<{
    qtyReceived: Prisma.Decimal;
    unitCost: Prisma.Decimal;
  }>;
};

export function PurchaseOrderReceiptsTable({
  receipts,
}: {
  receipts: ReceiptRow[];
}) {
  if (receipts.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Receipts</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            No receipts against this PO yet.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Receipts</CardTitle>
      </CardHeader>
      <CardContent className="px-0">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/30 hover:bg-muted/30">
              <TableHead className="pl-6">Receipt #</TableHead>
              <TableHead>Date</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Lines</TableHead>
              <TableHead className="pr-6 text-right">Value</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {receipts.map((r) => {
              const value = r.matchingLines.reduce(
                (acc, l) => acc.plus(l.qtyReceived.times(l.unitCost)),
                new Prisma.Decimal(0),
              );
              const when = r.receivedAt ?? r.createdAt;
              return (
                <TableRow
                  key={r.id}
                  className="relative cursor-pointer hover:bg-muted/50"
                >
                  <TableCell className="pl-6 font-mono text-xs">
                    {/* Stretched link → receipt detail page (lands in 6G). */}
                    <Link
                      href={`/receipts/${r.id}`}
                      className="absolute inset-0 rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    >
                      <span className="sr-only">View {r.number}</span>
                    </Link>
                    {r.number}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {when.toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric',
                      timeZone: 'UTC',
                    })}
                  </TableCell>
                  <TableCell>
                    <ReceiptStatusBadge status={r.status} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {r.matchingLines.length}
                  </TableCell>
                  <TableCell className="pr-6 text-right tabular-nums">
                    {formatCurrency(value)}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function ReceiptStatusBadge({ status }: { status: string }) {
  const label = formatStatusLabel(status);
  if (status === 'POSTED') return <Badge variant="secondary">{label}</Badge>;
  if (status === 'CANCELLED') {
    return (
      <Badge variant="outline" className="text-muted-foreground">
        {label}
      </Badge>
    );
  }
  return <Badge variant="outline">{label}</Badge>;
}
