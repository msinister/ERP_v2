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
import { TabEmpty, TabShell } from './tab-shell';

export type InventoryRow = {
  variantSku: string;
  variantName: string | null;
  warehouseCode: string;
  warehouseName: string;
  onHand: Prisma.Decimal;
  reserved: Prisma.Decimal;
  available: Prisma.Decimal;
  wac: Prisma.Decimal | null;
  lastCost: Prisma.Decimal | null;
};

export function InventoryTab({ rows }: { rows: InventoryRow[] }) {
  if (rows.length === 0) {
    return (
      <TabShell>
        <TabEmpty message="No inventory yet. Receive stock against a PO to populate this view." />
      </TabShell>
    );
  }

  return (
    <TabShell>
      <p className="text-sm text-muted-foreground">
        Available = on-hand − reserved (clamped to ≥ 0). WAC is computed
        live from FIFO layers with remaining quantity.
      </p>
      <div className="rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/30 hover:bg-muted/30">
              <TableHead>SKU</TableHead>
              <TableHead>Warehouse</TableHead>
              <TableHead className="text-right">On hand</TableHead>
              <TableHead className="text-right">Reserved</TableHead>
              <TableHead className="text-right">Available</TableHead>
              <TableHead className="text-right">WAC</TableHead>
              <TableHead className="text-right">Last cost</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row, idx) => (
              <TableRow key={idx}>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  {row.variantSku}
                  {row.variantName ? (
                    <div className="font-sans text-foreground">
                      {row.variantName}
                    </div>
                  ) : null}
                </TableCell>
                <TableCell>
                  <span className="font-mono text-xs text-muted-foreground">
                    {row.warehouseCode}
                  </span>{' '}
                  {row.warehouseName}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatQty(row.onHand)}
                </TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">
                  {formatQty(row.reserved)}
                </TableCell>
                <TableCell className="text-right tabular-nums font-medium">
                  {formatQty(row.available)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {row.wac != null ? formatCurrency(row.wac) : '—'}
                </TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">
                  {row.lastCost != null ? formatCurrency(row.lastCost) : '—'}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </TabShell>
  );
}

function formatQty(qty: Prisma.Decimal): string {
  const s = qty.toString();
  if (!s.includes('.')) return s;
  return s.replace(/\.?0+$/, '');
}
