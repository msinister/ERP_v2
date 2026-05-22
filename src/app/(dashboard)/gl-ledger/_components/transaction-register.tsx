import Link from 'next/link';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatCurrency } from '@/lib/format';

export type RegisterRowData = {
  jeId: string;
  postedAt: Date;
  description: string;
  memo: string | null;
  reference: string | null;
  jeNumber: string;
  // Deep link to the source entity, or null when it has no detail page.
  href: string | null;
  debit: string | null; // null when zero
  credit: string | null; // null when zero
  runningBalance: string; // natural orientation, signed string
};

export function TransactionRegister({ rows }: { rows: RegisterRowData[] }) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border p-12 text-center text-sm text-muted-foreground">
        No transactions in this range.
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/30 hover:bg-muted/30">
            <TableHead>Date</TableHead>
            <TableHead>Description</TableHead>
            <TableHead>Reference</TableHead>
            <TableHead>JE #</TableHead>
            <TableHead className="text-right">Debit</TableHead>
            <TableHead className="text-right">Credit</TableHead>
            <TableHead className="text-right">Running balance</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.jeId} className="align-top">
              <TableCell className="whitespace-nowrap text-muted-foreground">
                {formatDate(row.postedAt)}
              </TableCell>
              <TableCell>
                {row.href ? (
                  <Link
                    href={row.href}
                    className="font-medium text-primary hover:underline"
                  >
                    {row.description}
                  </Link>
                ) : (
                  <span className="font-medium">{row.description}</span>
                )}
                {row.memo ? (
                  <div className="text-xs text-muted-foreground">{row.memo}</div>
                ) : null}
              </TableCell>
              <TableCell className="font-mono text-xs text-muted-foreground">
                {row.reference ?? '—'}
              </TableCell>
              <TableCell className="font-mono text-xs text-muted-foreground">
                {row.jeNumber}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {row.debit ? formatCurrency(row.debit) : ''}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {row.credit ? formatCurrency(row.credit) : ''}
              </TableCell>
              <TableCell className="text-right tabular-nums font-medium">
                {formatCurrency(row.runningBalance)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
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
