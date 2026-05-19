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

export type RmaLineRow = {
  id: string;
  invoiceLineId: string;
  qty: Prisma.Decimal;
  reason: string | null;
  // Original invoice line snapshot — qty/qtyReturned shown for context
  // so operators can see what's been returned cumulatively across all
  // RMAs on this invoice (this RMA's qty is included in qtyReturned
  // ONLY after credit issuance).
  invoiceQty: Prisma.Decimal;
  invoiceQtyReturned: Prisma.Decimal;
  unitPrice: Prisma.Decimal;
  lineTotal: Prisma.Decimal;
  description: string;
  variant: {
    id: string;
    sku: string;
    name: string | null;
    productName: string;
  };
  imageUrl: string | null;
};

export function RmaLinesTable({ lines }: { lines: RmaLineRow[] }) {
  if (lines.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border p-12 text-center text-sm text-muted-foreground">
        No lines on this RMA.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium">Lines</h2>
        <ProductImageToggle />
      </div>

      {/* Mobile cards */}
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
            <div className="grid grid-cols-4 gap-2 text-xs">
              <Stat label="RMA qty" value={formatQty(l.qty)} />
              <Stat label="Invoiced" value={formatQty(l.invoiceQty)} />
              <Stat
                label="Already returned"
                value={formatQty(l.invoiceQtyReturned)}
              />
              <Stat label="Unit price" value={formatCurrency(l.unitPrice)} />
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Line total</span>
              <span className="tabular-nums font-medium">
                {formatCurrency(l.lineTotal)}
              </span>
            </div>
            {l.reason ? (
              <div className="text-xs italic text-muted-foreground">
                “{l.reason}”
              </div>
            ) : null}
          </div>
        ))}
      </div>

      {/* Desktop table */}
      <div className="hidden overflow-hidden rounded-lg border border-border md:block">
        <Table containerClassName="max-h-[60vh] overflow-y-auto">
          <TableHeader className="sticky top-0 z-10 bg-background">
            <TableRow className="bg-muted/30 hover:bg-muted/30">
              <TableHead className="w-[60px] [.hide-product-images_&]:hidden">
                <span className="sr-only">Image</span>
              </TableHead>
              <TableHead>SKU</TableHead>
              <TableHead>Description</TableHead>
              <TableHead className="text-right">RMA qty</TableHead>
              <TableHead className="text-right">Invoiced</TableHead>
              <TableHead className="text-right">Returned</TableHead>
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
                  {l.reason ? (
                    <div className="mt-1 text-xs italic text-muted-foreground">
                      “{l.reason}”
                    </div>
                  ) : null}
                </TableCell>
                <TableCell className="text-right tabular-nums font-medium">
                  {formatQty(l.qty)}
                </TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">
                  {formatQty(l.invoiceQty)}
                </TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">
                  {formatQty(l.invoiceQtyReturned)}
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

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="tabular-nums">{value}</div>
    </div>
  );
}

function formatQty(qty: Prisma.Decimal): string {
  const s = qty.toString();
  if (!s.includes('.')) return s;
  return s.replace(/\.?0+$/, '');
}
