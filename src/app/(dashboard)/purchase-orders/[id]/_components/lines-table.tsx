import type { ReactNode } from 'react';
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
import { ProductThumbnail } from '@/components/shared/product-thumbnail';
import { ProductImageToggle } from '@/components/shared/product-image-toggle';

export type PurchaseOrderLineRow = {
  id: string;
  sku: string;
  productName: string;
  variantName: string | null;
  warehouseCode: string;
  qtyOrdered: Prisma.Decimal;
  qtyReceived: Prisma.Decimal;
  unitCost: Prisma.Decimal;
  vendorSku: string | null;
  manufacturerPartNumber: string | null;
  notes: string | null;
  imageUrl: string | null;
};

export function PurchaseOrderLinesTable({
  lines,
}: {
  lines: PurchaseOrderLineRow[];
}) {
  if (lines.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border p-12 text-center text-sm text-muted-foreground">
        No lines on this PO.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <ProductImageToggle />
      </div>

      {/* Mobile card stack — visible below md. Drops the horizontal
          scroll the table would otherwise force. */}
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
                  productName={l.productName}
                />
              </div>
              <div className="min-w-0 flex-1">
                <div className="font-mono text-xs text-muted-foreground">
                  {l.sku}
                  {l.vendorSku ? (
                    <span className="ml-2 text-[10px] uppercase tracking-wide">
                      vendor: {l.vendorSku}
                    </span>
                  ) : null}
                  {l.manufacturerPartNumber ? (
                    <span className="ml-2 text-[10px] uppercase tracking-wide">
                      mpn: {l.manufacturerPartNumber}
                    </span>
                  ) : null}
                </div>
                <div className="font-medium">{l.productName}</div>
                {l.variantName ? (
                  <div className="text-xs text-muted-foreground">
                    {l.variantName}
                  </div>
                ) : null}
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3 text-sm">
              <Stat label="Qty">
                <div className="tabular-nums">{formatQty(l.qtyOrdered)}</div>
                <ReceivedHint
                  ordered={l.qtyOrdered}
                  received={l.qtyReceived}
                />
              </Stat>
              <Stat label="Unit cost">
                <div className="tabular-nums">
                  {formatCurrency(l.unitCost)}
                </div>
              </Stat>
              <Stat label="Ext.">
                <div className="tabular-nums font-medium">
                  {formatCurrency(l.qtyOrdered.times(l.unitCost))}
                </div>
              </Stat>
            </div>
            <div className="flex items-baseline gap-2 text-xs">
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Warehouse
              </span>
              <span className="font-mono text-muted-foreground">
                {l.warehouseCode}
              </span>
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
              <TableHead className="w-[60px] [.hide-product-images_&]:hidden">
                <span className="sr-only">Image</span>
              </TableHead>
              <TableHead>SKU</TableHead>
              <TableHead>Description</TableHead>
              <TableHead>Warehouse</TableHead>
              <TableHead className="text-right">Qty</TableHead>
              <TableHead className="text-right">Unit cost</TableHead>
              <TableHead className="text-right">Ext.</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {lines.map((l) => (
              <TableRow key={l.id}>
                <TableCell className="[.hide-product-images_&]:hidden">
                  <ProductThumbnail
                    src={l.imageUrl}
                    productName={l.productName}
                  />
                </TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  {l.sku}
                  {l.vendorSku ? (
                    <div className="mt-0.5 text-[10px] uppercase tracking-wide">
                      vendor: {l.vendorSku}
                    </div>
                  ) : null}
                  {l.manufacturerPartNumber ? (
                    <div className="text-[10px] uppercase tracking-wide">
                      mpn: {l.manufacturerPartNumber}
                    </div>
                  ) : null}
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
                <TableCell className="font-mono text-xs text-muted-foreground">
                  {l.warehouseCode}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  <div>{formatQty(l.qtyOrdered)}</div>
                  <ReceivedHint
                    ordered={l.qtyOrdered}
                    received={l.qtyReceived}
                  />
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatCurrency(l.unitCost)}
                </TableCell>
                <TableCell className="text-right tabular-nums font-medium">
                  {formatCurrency(l.qtyOrdered.times(l.unitCost))}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
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

function ReceivedHint({
  ordered,
  received,
}: {
  ordered: Prisma.Decimal;
  received: Prisma.Decimal;
}) {
  if (received.lessThanOrEqualTo(0)) return null;
  // Over-receive is allowed-with-warning per spec — flag it visually
  // so the operator sees it on the PO without digging into receipts.
  const overReceived = received.greaterThan(ordered);
  const label = overReceived
    ? `over-recv ${formatQty(received)}`
    : `recv ${formatQty(received)}`;
  return (
    <div
      className={
        'text-[10px] uppercase tracking-wide ' +
        (overReceived
          ? 'text-destructive'
          : received.greaterThanOrEqualTo(ordered)
            ? 'text-foreground/80'
            : 'text-muted-foreground')
      }
    >
      {label}
    </div>
  );
}
