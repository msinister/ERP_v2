import Link from 'next/link';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { formatCurrency } from '@/lib/format';

export type TransferRowData = {
  id: string;
  number: string;
  postedAt: Date;
  fromCode: string | null;
  fromName: string | null;
  toCode: string | null;
  toName: string | null;
  amount: string;
  reference: string | null;
  notes: string | null;
  reversedAt: Date | null;
};

export function TransferTable({ rows }: { rows: TransferRowData[] }) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border p-12 text-center text-sm text-muted-foreground">
        No transfers match these filters.
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/30 hover:bg-muted/30">
            <TableHead>Date</TableHead>
            <TableHead>From</TableHead>
            <TableHead>To</TableHead>
            <TableHead className="text-right">Amount</TableHead>
            <TableHead>Reference</TableHead>
            <TableHead>Notes</TableHead>
            <TableHead>JE #</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow
              key={row.id}
              className="relative cursor-pointer hover:bg-muted/50"
            >
              <TableCell className="text-muted-foreground">
                {/* Stretched-link overlay → the transfer's JE detail page. */}
                <Link
                  href={`/transfers/${row.id}`}
                  className="absolute inset-0 rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  <span className="sr-only">View transfer {row.number}</span>
                </Link>
                {formatDate(row.postedAt)}
              </TableCell>
              <TableCell>
                <AccountCell code={row.fromCode} name={row.fromName} />
              </TableCell>
              <TableCell>
                <AccountCell code={row.toCode} name={row.toName} />
              </TableCell>
              <TableCell className="text-right tabular-nums font-medium">
                {formatCurrency(row.amount)}
              </TableCell>
              <TableCell className="font-mono text-xs text-muted-foreground">
                {row.reference ?? '—'}
              </TableCell>
              <TableCell className="max-w-[16rem] truncate text-sm text-muted-foreground">
                {row.notes ?? '—'}
              </TableCell>
              <TableCell className="font-mono text-xs">
                <span className="inline-flex items-center gap-1.5">
                  {row.number}
                  {row.reversedAt ? (
                    <Badge variant="destructive" className="text-[10px]">
                      Reversed
                    </Badge>
                  ) : null}
                </span>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function AccountCell({
  code,
  name,
}: {
  code: string | null;
  name: string | null;
}) {
  if (!name) return <span className="text-xs text-muted-foreground">—</span>;
  return (
    <div className="flex flex-col text-sm leading-tight">
      <span className="font-medium">{name}</span>
      <span className="font-mono text-[10px] text-muted-foreground">{code}</span>
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
