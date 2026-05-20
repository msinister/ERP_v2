'use client';

import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
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
import { formatCurrency } from '@/lib/format';
import { cn } from '@/lib/utils';

// Row shape mirrors JournalReportEntry from
// src/server/services/reports/financial.ts so the service result
// drops straight into the prop. Kept as a local re-declaration to
// avoid the client component importing from a server-services file.
export type JournalEntryRow = {
  id: string;
  number: string;
  postedAt: Date;
  description: string;
  entityType: string;
  entityId: string;
  reversedAt: Date | null;
  lines: Array<{
    accountCode: string;
    accountName: string;
    // Pass through as the Decimal-as-string so we don't have to
    // round-trip the Prisma.Decimal through Next's RSC boundary.
    debit: string;
    credit: string;
    memo: string | null;
  }>;
};

// Per-row collapsed-by-default disclosure. Header shows the
// transaction summary (number, description, primary DR/CR accounts
// + amount). Click expands the full per-line breakdown.
//
// "Primary accounts" for the header line are derived from the legs:
//   - If exactly one debit and one credit leg, show those.
//   - Otherwise show "(multiple)" — the operator expands to see all.
//
// The card itself is always visible. The user spec calls for a
// dedicated section on the SO detail page below the payments card.

export function JournalEntriesCard({ entries }: { entries: JournalEntryRow[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Journal entries</CardTitle>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Every JE that posts against this order&apos;s invoice —
          close, COGS, payments, voids, and reversals. Click a row to
          see the full debit/credit legs.
        </p>
      </CardHeader>
      <CardContent className="px-0">
        {entries.length === 0 ? (
          <p className="px-6 text-sm text-muted-foreground">
            No journal entries yet — the close JE posts when the order
            ships and closes.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/30 hover:bg-muted/30">
                <TableHead className="w-6 pl-6" />
                <TableHead>Date</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Debit</TableHead>
                <TableHead>Credit</TableHead>
                <TableHead className="pr-6 text-right">Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((e) => (
                <EntryRow key={e.id} entry={e} />
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function EntryRow({ entry }: { entry: JournalEntryRow }) {
  const [open, setOpen] = useState(false);

  // Total amount = sum of debits (= sum of credits when balanced).
  // Used for the header row's right-side amount.
  const totalDebit = entry.lines.reduce(
    (acc, l) => acc.plus(new Prisma.Decimal(l.debit || '0')),
    new Prisma.Decimal(0),
  );

  const debitLegs = entry.lines.filter((l) =>
    new Prisma.Decimal(l.debit || '0').greaterThan(0),
  );
  const creditLegs = entry.lines.filter((l) =>
    new Prisma.Decimal(l.credit || '0').greaterThan(0),
  );
  const summaryDr =
    debitLegs.length === 1
      ? `${debitLegs[0].accountCode} ${debitLegs[0].accountName}`
      : `${debitLegs.length} debit${debitLegs.length === 1 ? '' : 's'}`;
  const summaryCr =
    creditLegs.length === 1
      ? `${creditLegs[0].accountCode} ${creditLegs[0].accountName}`
      : `${creditLegs.length} credit${creditLegs.length === 1 ? '' : 's'}`;

  return (
    <>
      <TableRow
        className={cn(
          'cursor-pointer',
          entry.reversedAt ? 'opacity-60' : '',
        )}
        onClick={() => setOpen((o) => !o)}
      >
        <TableCell className="pl-6">
          <ChevronRight
            className={cn(
              'size-3.5 text-muted-foreground transition-transform',
              open ? 'rotate-90' : '',
            )}
            aria-hidden
          />
        </TableCell>
        <TableCell className="text-xs text-muted-foreground">
          {formatDate(entry.postedAt)}
        </TableCell>
        <TableCell>
          <div className="flex items-baseline gap-2">
            <span className="text-sm">{entry.description}</span>
            <span className="font-mono text-[10px] text-muted-foreground">
              {entry.number}
            </span>
            {entry.reversedAt ? (
              <Badge variant="outline" className="text-[10px]">
                Reversed
              </Badge>
            ) : null}
          </div>
        </TableCell>
        <TableCell className="text-xs text-muted-foreground">
          <span className="font-mono">{summaryDr}</span>
        </TableCell>
        <TableCell className="text-xs text-muted-foreground">
          <span className="font-mono">{summaryCr}</span>
        </TableCell>
        <TableCell className="pr-6 text-right tabular-nums">
          {formatCurrency(totalDebit)}
        </TableCell>
      </TableRow>
      {open ? (
        <TableRow className="bg-muted/10 hover:bg-muted/10">
          <TableCell colSpan={6} className="px-6 py-3">
            <div className="rounded-md border border-border">
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
                  {entry.lines.map((l, i) => (
                    <TableRow key={i}>
                      <TableCell>
                        <span className="font-mono text-xs text-muted-foreground">
                          {l.accountCode}
                        </span>{' '}
                        {l.accountName}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {l.memo ?? ''}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatDrCr(l.debit)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatDrCr(l.credit)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </TableCell>
        </TableRow>
      ) : null}
    </>
  );
}

function formatDate(d: Date): string {
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
  });
}

function formatDrCr(value: string): string {
  // Render zero values as a dim em dash to keep the column readable;
  // non-zero values render with formatCurrency.
  const n = new Prisma.Decimal(value || '0');
  if (n.equals(0)) return '—';
  return formatCurrency(n);
}
