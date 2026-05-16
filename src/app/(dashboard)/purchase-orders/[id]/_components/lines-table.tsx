import Link from 'next/link';
import type { ReactNode } from 'react';
import { Prisma } from '@/generated/tenant';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
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
import {
  EditableLineNotesCell,
  EditableMpnCell,
  EditableQtyOrderedCell,
  EditableUnitCostCell,
  EditableVendorSkuCell,
} from './editable-line-cells';

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
  purchaseOrderId,
  status,
  lines,
}: {
  purchaseOrderId: string;
  status: string;
  lines: PurchaseOrderLineRow[];
}) {
  const editable = status === 'CONFIRMED' || status === 'PARTIALLY_RECEIVED';
  // "+ Add lines" button mirrors the status window the service gates
  // against (CONFIRMED + PARTIALLY_RECEIVED). DRAFT uses the full Edit
  // form; CLOSED + CANCELLED don't accept additions.
  const canAddLines = editable;

  const Header = (
    <div className="flex items-center justify-between gap-3">
      <div className="flex-1" />
      <div className="flex items-center gap-2">
        <ProductImageToggle />
        {canAddLines ? (
          <Button
            variant="outline"
            size="sm"
            render={
              <Link href={`/purchase-orders/${purchaseOrderId}/add-lines`} />
            }
          >
            <Plus />
            Add lines
          </Button>
        ) : null}
      </div>
    </div>
  );

  if (lines.length === 0) {
    return (
      <div className="space-y-3">
        {Header}
        <div className="rounded-lg border border-dashed border-border p-12 text-center text-sm text-muted-foreground">
          No lines on this PO.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {Header}

      {/* Mobile card stack — visible below md. */}
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
                  <div>{l.sku}</div>
                  <EditableVendorSkuCell
                    purchaseOrderId={purchaseOrderId}
                    lineId={l.id}
                    vendorSku={l.vendorSku}
                    editable={editable}
                  />
                  <EditableMpnCell
                    purchaseOrderId={purchaseOrderId}
                    lineId={l.id}
                    manufacturerPartNumber={l.manufacturerPartNumber}
                    editable={editable}
                  />
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
                <div className="tabular-nums">
                  <EditableQtyOrderedCell
                    purchaseOrderId={purchaseOrderId}
                    lineId={l.id}
                    qtyOrdered={l.qtyOrdered.toString()}
                    qtyReceived={l.qtyReceived.toString()}
                    editable={editable}
                  />
                </div>
                <ReceivedHint
                  ordered={l.qtyOrdered}
                  received={l.qtyReceived}
                />
              </Stat>
              <Stat label="Unit cost">
                <div className="tabular-nums">
                  <EditableUnitCostCell
                    purchaseOrderId={purchaseOrderId}
                    lineId={l.id}
                    unitCost={l.unitCost.toString()}
                    editable={editable}
                  />
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
            <EditableLineNotesCell
              purchaseOrderId={purchaseOrderId}
              lineId={l.id}
              notes={l.notes}
              editable={editable}
            />
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
                  <div className="mt-0.5 space-y-0.5">
                    <EditableVendorSkuCell
                      purchaseOrderId={purchaseOrderId}
                      lineId={l.id}
                      vendorSku={l.vendorSku}
                      editable={editable}
                    />
                    <EditableMpnCell
                      purchaseOrderId={purchaseOrderId}
                      lineId={l.id}
                      manufacturerPartNumber={l.manufacturerPartNumber}
                      editable={editable}
                    />
                  </div>
                </TableCell>
                <TableCell>
                  <div className="font-medium">{l.productName}</div>
                  {l.variantName ? (
                    <div className="text-xs text-muted-foreground">
                      {l.variantName}
                    </div>
                  ) : null}
                  <div className="mt-1">
                    <EditableLineNotesCell
                      purchaseOrderId={purchaseOrderId}
                      lineId={l.id}
                      notes={l.notes}
                      editable={editable}
                    />
                  </div>
                </TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  {l.warehouseCode}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  <EditableQtyOrderedCell
                    purchaseOrderId={purchaseOrderId}
                    lineId={l.id}
                    qtyOrdered={l.qtyOrdered.toString()}
                    qtyReceived={l.qtyReceived.toString()}
                    editable={editable}
                  />
                  <ReceivedHint
                    ordered={l.qtyOrdered}
                    received={l.qtyReceived}
                  />
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  <EditableUnitCostCell
                    purchaseOrderId={purchaseOrderId}
                    lineId={l.id}
                    unitCost={l.unitCost.toString()}
                    editable={editable}
                  />
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
