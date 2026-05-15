import type { ReactNode } from 'react';
import Link from 'next/link';
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

export type BillLineRow = {
  id: string;
  description: string;
  qty: Prisma.Decimal;
  unitCost: Prisma.Decimal;
  lineTotal: Prisma.Decimal;
  notes: string | null;
  // PRODUCT discriminator — set when source = PRODUCT
  variant: {
    id: string;
    sku: string;
    name: string | null;
    productName: string;
  } | null;
  receiptLine: {
    id: string;
    receipt: { id: string; number: string };
  } | null;
  // EXPENSE discriminator — set when source = EXPENSE
  expenseAccount: {
    id: string;
    code: string;
    name: string;
  } | null;
};

export function BillLinesTable({
  lines,
  source,
}: {
  lines: BillLineRow[];
  source: string;
}) {
  if (lines.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border p-12 text-center text-sm text-muted-foreground">
        No lines on this bill.
      </div>
    );
  }

  const isProduct = source === 'PRODUCT';

  return (
    <>
      {/* Mobile card stack. The SKU/Account discriminator is folded
          into the card header; "From receipt" rides as an inline
          chip when present (PRODUCT only). */}
      <div className="space-y-3 md:hidden">
        {lines.map((l) => (
          <div
            key={l.id}
            className="space-y-3 rounded-lg border border-border bg-card p-3"
          >
            <div>
              <div className="font-mono text-xs text-muted-foreground">
                {isProduct ? (
                  (l.variant?.sku ?? '—')
                ) : (
                  <>
                    {l.expenseAccount?.code ?? '—'}
                    {l.expenseAccount?.name ? (
                      <span className="ml-2 font-sans text-[10px] uppercase tracking-wide">
                        {l.expenseAccount.name}
                      </span>
                    ) : null}
                  </>
                )}
              </div>
              <div className="font-medium">{l.description}</div>
              {isProduct && l.variant?.productName ? (
                <div className="text-xs text-muted-foreground">
                  {l.variant.productName}
                  {l.variant.name ? ` · ${l.variant.name}` : ''}
                </div>
              ) : null}
            </div>
            <div className="grid grid-cols-3 gap-3 text-sm">
              <Stat label="Qty">
                <div className="tabular-nums">{formatQty(l.qty)}</div>
              </Stat>
              <Stat label="Unit cost">
                <div className="tabular-nums">
                  {formatCurrency(l.unitCost)}
                </div>
              </Stat>
              <Stat label="Ext.">
                <div className="tabular-nums font-medium">
                  {formatCurrency(l.lineTotal)}
                </div>
              </Stat>
            </div>
            {isProduct && l.receiptLine?.receipt ? (
              <div className="flex items-baseline gap-2 text-xs">
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  From receipt
                </span>
                <Link
                  href={`/receipts/${l.receiptLine.receipt.id}`}
                  className="font-mono text-foreground underline-offset-2 hover:underline"
                >
                  {l.receiptLine.receipt.number}
                </Link>
              </div>
            ) : null}
            {l.notes ? (
              <div className="text-xs italic text-muted-foreground">
                “{l.notes}”
              </div>
            ) : null}
          </div>
        ))}
      </div>

      {/* Desktop table. */}
      <div className="hidden overflow-hidden rounded-lg border border-border md:block">
        <Table containerClassName="max-h-[60vh] overflow-y-auto">
        <TableHeader className="sticky top-0 z-10 bg-background">
          <TableRow className="bg-muted/30 hover:bg-muted/30">
            <TableHead>{isProduct ? 'SKU' : 'Account'}</TableHead>
            <TableHead>Description</TableHead>
            {isProduct ? <TableHead>From receipt</TableHead> : null}
            <TableHead className="text-right">Qty</TableHead>
            <TableHead className="text-right">Unit cost</TableHead>
            <TableHead className="text-right">Ext.</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {lines.map((l) => (
            <TableRow key={l.id}>
              <TableCell className="font-mono text-xs">
                {isProduct
                  ? (l.variant?.sku ?? <span className="text-muted-foreground">—</span>)
                  : (
                      <div className="flex flex-col leading-tight">
                        <span>{l.expenseAccount?.code ?? '—'}</span>
                        {l.expenseAccount?.name ? (
                          <span className="font-sans text-[10px] text-muted-foreground">
                            {l.expenseAccount.name}
                          </span>
                        ) : null}
                      </div>
                    )}
              </TableCell>
              <TableCell>
                <div className="font-medium">{l.description}</div>
                {isProduct && l.variant?.productName ? (
                  <div className="text-xs text-muted-foreground">
                    {l.variant.productName}
                    {l.variant.name ? ` · ${l.variant.name}` : ''}
                  </div>
                ) : null}
                {l.notes ? (
                  <div className="mt-1 text-xs italic text-muted-foreground">
                    “{l.notes}”
                  </div>
                ) : null}
              </TableCell>
              {isProduct ? (
                <TableCell className="font-mono text-xs">
                  {l.receiptLine?.receipt ? (
                    <Link
                      href={`/receipts/${l.receiptLine.receipt.id}`}
                      className="text-foreground underline-offset-2 hover:underline"
                    >
                      {l.receiptLine.receipt.number}
                    </Link>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
              ) : null}
              <TableCell className="text-right tabular-nums">
                {formatQty(l.qty)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatCurrency(l.unitCost)}
              </TableCell>
              <TableCell className="text-right tabular-nums font-medium">
                {formatCurrency(l.lineTotal)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      </div>
    </>
  );
}

function formatQty(qty: Prisma.Decimal): string {
  const s = qty.toString();
  if (!s.includes('.')) return s;
  return s.replace(/\.?0+$/, '');
}

function Stat({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      {children}
    </div>
  );
}
