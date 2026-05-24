import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
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
import { cn } from '@/lib/utils';

// Shared presentational register for the vendor + customer ledgers. Pure
// display: the owning tab resolves hrefs + formats money to strings.

export type LedgerTone = 'charge' | 'reduce' | 'neutral';

// Type → display label + tone. Shared so the tabs map service rows
// consistently. 'charge' = increases what's owed (bill/invoice); 'reduce'
// = decreases it (payment/credit/deposit); 'neutral' = balance-neutral
// detail (applications).
export const LEDGER_TYPE_META: Record<
  string,
  { label: string; tone: LedgerTone }
> = {
  BILL: { label: 'Bill', tone: 'charge' },
  BILL_PAYMENT: { label: 'Payment', tone: 'reduce' },
  VENDOR_CREDIT: { label: 'Vendor credit', tone: 'reduce' },
  VENDOR_CREDIT_APPLIED: { label: 'Credit applied', tone: 'neutral' },
  PO_DEPOSIT: { label: 'Deposit', tone: 'reduce' },
  PO_DEPOSIT_APPLIED: { label: 'Deposit applied', tone: 'neutral' },
  INVOICE: { label: 'Invoice', tone: 'charge' },
  CUSTOMER_PAYMENT: { label: 'Payment', tone: 'reduce' },
  CREDIT_MEMO: { label: 'Credit memo', tone: 'reduce' },
  CREDIT_APPLIED: { label: 'Credit applied', tone: 'neutral' },
};

const TONE_CLASSES: Record<LedgerTone, string> = {
  charge: 'bg-amber-100 text-amber-900 border-transparent dark:bg-amber-900/40 dark:text-amber-200',
  reduce: 'bg-emerald-100 text-emerald-900 border-transparent dark:bg-emerald-900/40 dark:text-emerald-200',
  neutral: 'bg-background text-muted-foreground border-border',
};

export type LedgerRegisterRow = {
  id: string;
  date: Date;
  typeLabel: string;
  typeTone: LedgerTone;
  number: string;
  description: string;
  href: string | null;
  debit: string | null; // decimal string, or null when zero
  credit: string | null; // decimal string, or null when zero
  runningBalance: string; // signed decimal string
};

function formatDate(d: Date): string {
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export function LedgerRegister({
  rows,
  windowDebits,
  windowCredits,
  currentBalance,
}: {
  rows: LedgerRegisterRow[];
  // Decimal strings for the totals row.
  windowDebits: string;
  windowCredits: string;
  currentBalance: string;
}) {
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
            <TableHead>Type</TableHead>
            <TableHead>Reference</TableHead>
            <TableHead>Description</TableHead>
            <TableHead className="text-right">Debit</TableHead>
            <TableHead className="text-right">Credit</TableHead>
            <TableHead className="text-right">Balance</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.id} className="align-top">
              <TableCell className="whitespace-nowrap text-muted-foreground">
                {formatDate(row.date)}
              </TableCell>
              <TableCell>
                <Badge className={cn('whitespace-nowrap', TONE_CLASSES[row.typeTone])}>
                  {row.typeLabel}
                </Badge>
              </TableCell>
              <TableCell className="font-mono text-xs">
                {row.href ? (
                  <Link href={row.href} className="text-primary hover:underline">
                    {row.number}
                  </Link>
                ) : (
                  <span className="text-muted-foreground">{row.number}</span>
                )}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {row.description}
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
        <TableFooter>
          <TableRow className="bg-muted/30 hover:bg-muted/30">
            <TableCell colSpan={4} className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Totals (shown rows)
            </TableCell>
            <TableCell className="text-right tabular-nums font-medium">
              {formatCurrency(windowDebits)}
            </TableCell>
            <TableCell className="text-right tabular-nums font-medium">
              {formatCurrency(windowCredits)}
            </TableCell>
            <TableCell className="text-right tabular-nums font-semibold">
              {formatCurrency(currentBalance)}
            </TableCell>
          </TableRow>
        </TableFooter>
      </Table>
    </div>
  );
}
