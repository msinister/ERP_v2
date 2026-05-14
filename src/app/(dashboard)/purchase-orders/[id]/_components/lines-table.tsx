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
    <div className="rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/30 hover:bg-muted/30">
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
