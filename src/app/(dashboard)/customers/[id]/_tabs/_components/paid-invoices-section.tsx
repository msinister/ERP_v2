'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Prisma } from '@/generated/tenant';
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
import { SectionPagination } from './section-pagination';

// Collapsed-by-default section showing PAID invoices for the
// customer. Mirrors the open-invoices column set minus "Days past
// due" (PAID has no aging) and minus the per-row "Pay" button.
export type PaidInvoiceRow = {
  id: string;
  number: string;
  invoiceDate: Date;
  total: Prisma.Decimal;
  amountPaid: Prisma.Decimal;
  amountCredited: Prisma.Decimal;
  salesOrderId: string | null;
};

export function PaidInvoicesSection({
  rows,
  total,
  skip,
  take,
  basePath,
}: {
  rows: PaidInvoiceRow[];
  total: number;
  skip: number;
  take: number;
  basePath: string;
}) {
  // Default closed. The chevron + count cue lets the operator decide
  // whether to expand. State is local — pagination doesn't open it.
  const [open, setOpen] = useState(false);
  // Auto-open when the section is the navigation target (skip > 0)
  // so deep-links / pagination clicks reveal the data.
  const initialOpen = open || skip > 0;

  return (
    <section className="space-y-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'flex w-full items-center justify-between gap-2 rounded-md px-1 py-1',
          'text-left text-sm font-semibold text-muted-foreground',
          'hover:text-foreground',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        )}
        aria-expanded={initialOpen}
      >
        <span className="flex items-center gap-1">
          {initialOpen ? (
            <ChevronDown className="size-4" aria-hidden />
          ) : (
            <ChevronRight className="size-4" aria-hidden />
          )}
          Paid invoices
          <span className="ml-1 text-xs font-normal text-muted-foreground tabular-nums">
            ({total})
          </span>
        </span>
      </button>
      {initialOpen ? (
        rows.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
            No paid invoices yet.
          </div>
        ) : (
          <>
            <div className="rounded-lg border border-border">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/30 hover:bg-muted/30">
                    <TableHead>Invoice</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                    <TableHead className="text-right">Paid</TableHead>
                    <TableHead className="text-right">Credited</TableHead>
                    <TableHead className="text-right">Balance</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => {
                    const balance = r.total
                      .minus(r.amountPaid)
                      .minus(r.amountCredited);
                    return (
                      <TableRow key={r.id}>
                        <TableCell className="font-mono text-xs">
                          {r.salesOrderId ? (
                            <Link
                              href={`/sales-orders/${r.salesOrderId}`}
                              className="text-primary hover:underline"
                            >
                              {r.number}
                            </Link>
                          ) : (
                            <span>{r.number}</span>
                          )}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {formatDate(r.invoiceDate)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatCurrency(r.total)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">
                          {formatCurrency(r.amountPaid)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">
                          {formatCurrency(r.amountCredited)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">
                          {formatCurrency(balance)}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
            <SectionPagination
              total={total}
              skip={skip}
              take={take}
              basePath={basePath}
              paramName="paidInvSkip"
              itemLabel="invoices"
            />
          </>
        )
      ) : null}
    </section>
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
