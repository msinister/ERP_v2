import Link from 'next/link';
import type { Prisma } from '@/generated/tenant';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatCurrency } from '@/lib/format';
import { ProductThumbnail } from '@/components/shared/product-thumbnail';
import { ProductImageToggle } from '@/components/shared/product-image-toggle';

export type CmLineRow = {
  id: string;
  description: string;
  qty: Prisma.Decimal;
  unitPrice: Prisma.Decimal;
  lineTotal: Prisma.Decimal;
  variant: {
    id: string;
    sku: string;
    name: string | null;
    productName: string;
  };
  invoiceLine: {
    id: string;
    invoice: { id: string; number: string };
  } | null;
  imageUrl: string | null;
  // Aggregated across warehouses. Pilot is single-warehouse; multi-
  // warehouse arrives later.
  stock: { onHand: number; available: number };
};

export function CreditMemoLinesTable({ lines }: { lines: CmLineRow[] }) {
  if (lines.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border p-12 text-center text-sm text-muted-foreground">
        No lines on this credit memo.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <ProductImageToggle />
      </div>

      {/* Mobile card stack. */}
      <div className="space-y-3 md:hidden">
        {lines.map((l) => (
          <div
            key={l.id}
            className="space-y-3 rounded-lg border border-border bg-card p-3"
          >
            <div className="flex items-start gap-3">
              <div className="[.hide-product-images_&]:hidden">
                <ProductThumbnail
                  src={l.imageUrl}
                  productName={l.variant.productName}
                />
              </div>
              <div className="min-w-0 flex-1">
                <div className="font-mono text-xs text-muted-foreground">
                  {l.variant.sku}
                </div>
                <div className="font-medium">{l.description}</div>
                <div className="text-xs text-muted-foreground">
                  {l.variant.productName}
                  {l.variant.name ? ` · ${l.variant.name}` : ''}
                </div>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3 text-sm">
              <Stat label="Qty">
                <div className="tabular-nums">{formatQty(l.qty)}</div>
              </Stat>
              <Stat label="Unit price">
                <div className="tabular-nums">
                  {formatCurrency(l.unitPrice)}
                </div>
              </Stat>
              <Stat label="Ext.">
                <div className="tabular-nums font-medium">
                  {formatCurrency(l.lineTotal)}
                </div>
              </Stat>
            </div>
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="text-muted-foreground">
                In stock: {formatStockNumber(l.stock.onHand)} (avail{' '}
                {formatStockNumber(l.stock.available)})
              </span>
              {l.invoiceLine ? (
                <span className="text-muted-foreground">
                  From{' '}
                  <Link
                    href={`/invoices/${l.invoiceLine.invoice.id}`}
                    className="font-mono text-foreground underline-offset-2 hover:underline"
                  >
                    {l.invoiceLine.invoice.number}
                  </Link>
                </span>
              ) : null}
            </div>
          </div>
        ))}
      </div>

      {/* Desktop table. */}
      <div className="hidden overflow-hidden rounded-lg border border-border md:block">
        <Table containerClassName="max-h-[60vh] overflow-y-auto">
          <TableHeader className="sticky top-0 z-10 bg-background">
            <TableRow className="bg-muted/30 hover:bg-muted/30">
              <TableHead className="w-[60px] [.hide-product-images_&]:hidden">
                <span className="sr-only">Image</span>
              </TableHead>
              <TableHead>SKU</TableHead>
              <TableHead>Description</TableHead>
              <TableHead>From invoice line</TableHead>
              <TableHead className="text-right">Qty</TableHead>
              <TableHead className="text-right">In stock</TableHead>
              <TableHead className="text-right">Unit price</TableHead>
              <TableHead className="text-right">Ext.</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {lines.map((l) => (
              <TableRow key={l.id}>
                <TableCell className="[.hide-product-images_&]:hidden">
                  <ProductThumbnail
                    src={l.imageUrl}
                    productName={l.variant.productName}
                  />
                </TableCell>
                <TableCell className="font-mono text-xs">
                  {l.variant.sku}
                </TableCell>
                <TableCell>
                  <div className="font-medium">{l.description}</div>
                  <div className="text-xs text-muted-foreground">
                    {l.variant.productName}
                    {l.variant.name ? ` · ${l.variant.name}` : ''}
                  </div>
                </TableCell>
                <TableCell className="font-mono text-xs">
                  {l.invoiceLine ? (
                    <Link
                      href={`/invoices/${l.invoiceLine.invoice.id}`}
                      className="text-foreground underline-offset-2 hover:underline"
                    >
                      {l.invoiceLine.invoice.number}
                    </Link>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatQty(l.qty)}
                </TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">
                  {formatStockNumber(l.stock.onHand)}
                  {l.stock.available !== l.stock.onHand ? (
                    <span className="ml-1 text-[10px]">
                      ({formatStockNumber(l.stock.available)} avail)
                    </span>
                  ) : null}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatCurrency(l.unitPrice)}
                </TableCell>
                <TableCell className="text-right tabular-nums font-medium">
                  {formatCurrency(l.lineTotal)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function formatQty(qty: Prisma.Decimal): string {
  const s = qty.toString();
  if (!s.includes('.')) return s;
  return s.replace(/\.?0+$/, '');
}

function formatStockNumber(n: number): string {
  if (!Number.isFinite(n)) return '0';
  return n.toFixed(5).replace(/\.?0+$/, '');
}

function Stat({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
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
