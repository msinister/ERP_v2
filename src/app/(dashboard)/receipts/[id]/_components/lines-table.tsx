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

export type ReceiptLineRow = {
  id: string;
  sku: string;
  productName: string;
  variantName: string | null;
  warehouseCode: string;
  qtyReceived: Prisma.Decimal;
  unitCost: Prisma.Decimal;
  purchaseOrder: {
    id: string;
    number: string;
  } | null;
  notes: string | null;
};

export function ReceiptLinesTable({ lines }: { lines: ReceiptLineRow[] }) {
  if (lines.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border p-12 text-center text-sm text-muted-foreground">
        No lines on this receipt.
      </div>
    );
  }

  return (
    <>
      {/* Mobile card stack. */}
      <div className="space-y-3 md:hidden">
        {lines.map((l) => (
          <div
            key={l.id}
            className="space-y-3 rounded-lg border border-border bg-card p-3"
          >
            <div>
              <div className="font-mono text-xs text-muted-foreground">
                {l.sku}
              </div>
              <div className="font-medium">{l.productName}</div>
              {l.variantName ? (
                <div className="text-xs text-muted-foreground">
                  {l.variantName}
                </div>
              ) : null}
            </div>
            <div className="grid grid-cols-3 gap-3 text-sm">
              <Stat label="Qty">
                <div className="tabular-nums">{formatQty(l.qtyReceived)}</div>
              </Stat>
              <Stat label="Unit cost">
                <div className="tabular-nums">
                  {formatCurrency(l.unitCost)}
                </div>
              </Stat>
              <Stat label="Ext.">
                <div className="tabular-nums font-medium">
                  {formatCurrency(l.qtyReceived.times(l.unitCost))}
                </div>
              </Stat>
            </div>
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs">
              <div className="flex items-baseline gap-2">
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  Warehouse
                </span>
                <span className="font-mono text-muted-foreground">
                  {l.warehouseCode}
                </span>
              </div>
              <div className="flex items-baseline gap-2">
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  From PO
                </span>
                {l.purchaseOrder ? (
                  <Link
                    href={`/purchase-orders/${l.purchaseOrder.id}`}
                    className="font-mono text-foreground underline-offset-2 hover:underline"
                  >
                    {l.purchaseOrder.number}
                  </Link>
                ) : (
                  <span className="font-mono text-muted-foreground">—</span>
                )}
              </div>
            </div>
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
              <TableHead>SKU</TableHead>
              <TableHead>Description</TableHead>
              <TableHead>From PO</TableHead>
              <TableHead>Warehouse</TableHead>
              <TableHead className="text-right">Qty</TableHead>
              <TableHead className="text-right">Unit cost</TableHead>
              <TableHead className="text-right">Ext.</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {lines.map((l) => (
              <TableRow key={l.id}>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  {l.sku}
                </TableCell>
                <TableCell>
                  <div className="font-medium">{l.productName}</div>
                  {l.variantName ? (
                    <div className="text-xs text-muted-foreground">
                      {l.variantName}
                    </div>
                  ) : null}
                  {l.notes ? (
                    <div className="mt-1 text-xs italic text-muted-foreground">
                      “{l.notes}”
                    </div>
                  ) : null}
                </TableCell>
                <TableCell className="font-mono text-xs">
                  {l.purchaseOrder ? (
                    <Link
                      href={`/purchase-orders/${l.purchaseOrder.id}`}
                      className="text-foreground underline-offset-2 hover:underline"
                    >
                      {l.purchaseOrder.number}
                    </Link>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  {l.warehouseCode}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatQty(l.qtyReceived)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatCurrency(l.unitCost)}
                </TableCell>
                <TableCell className="text-right tabular-nums font-medium">
                  {formatCurrency(l.qtyReceived.times(l.unitCost))}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </>
  );
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

function formatQty(qty: Prisma.Decimal): string {
  const s = qty.toString();
  if (!s.includes('.')) return s;
  return s.replace(/\.?0+$/, '');
}
