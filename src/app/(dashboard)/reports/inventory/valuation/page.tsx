import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import type { Prisma } from '@/generated/tenant';
import { db } from '@/lib/db';
import { inventoryValuation } from '@/server/services/reports/operational';
import { listWarehouses } from '@/server/services/warehouse';
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { WarehouseFilter } from '../../_components/account-date-filter';
import { formatCount, formatCurrency } from '@/lib/format';

export const revalidate = 0;

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function pick(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

function formatQty(q: Prisma.Decimal): string {
  const s = q.toString();
  if (!s.includes('.')) return s;
  return s.replace(/\.?0+$/, '');
}

export default async function InventoryValuationPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const sp = await searchParams;
  const warehouseIdParam = pick(sp.warehouseId) ?? '';

  const warehouses = await listWarehouses(db);
  const warehouseOptions = warehouses.map((w) => ({
    id: w.id,
    code: w.code,
    name: w.name,
  }));

  // Empty string means "all warehouses." If the user-supplied id isn't
  // in the active list (e.g., archived or hand-edited URL), fall back to
  // "all" rather than throwing.
  const validWarehouseId =
    warehouseIdParam !== '' &&
    warehouses.some((w) => w.id === warehouseIdParam)
      ? warehouseIdParam
      : undefined;

  const report = await inventoryValuation(db, {
    warehouseId: validWarehouseId,
  });

  const selectedWarehouse = validWarehouseId
    ? warehouses.find((w) => w.id === validWarehouseId)
    : null;

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Link
          href="/reports"
          className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="size-3.5" />
          Reports
        </Link>
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            Inventory Valuation
          </h1>
          <p className="text-sm text-muted-foreground">
            Current on-hand value at FIFO cost — sum of qtyRemaining × unitCost
            across non-deleted layers, grouped by (variant, warehouse).
            Historical asOf is not supported in pilot; this is a live snapshot.
          </p>
        </div>
      </div>

      <WarehouseFilter
        warehouseId={warehouseIdParam}
        warehouses={warehouseOptions}
        action="/reports/inventory/valuation"
      />

      <div className="text-xs text-muted-foreground">
        {selectedWarehouse ? (
          <>
            Warehouse:{' '}
            <span className="font-mono text-foreground">
              {selectedWarehouse.code}
            </span>{' '}
            <span className="text-foreground">{selectedWarehouse.name}</span>
          </>
        ) : (
          'All warehouses'
        )}{' '}
        · {formatCount(report.rows.length)}{' '}
        {report.rows.length === 1 ? 'row' : 'rows'}
      </div>

      {report.rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
          No on-hand inventory.
        </div>
      ) : (
        <div className="rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/30 hover:bg-muted/30">
                <TableHead>SKU</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Warehouse</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead className="text-right">Value</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {report.rows.map((r) => (
                <TableRow key={`${r.variantId}::${r.warehouseId}`}>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {r.sku}
                  </TableCell>
                  <TableCell>{r.name ?? '—'}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {r.warehouseCode}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatQty(r.qty)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums font-medium">
                    {formatCurrency(r.value)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell colSpan={3} className="font-medium">
                  Totals
                </TableCell>
                <TableCell className="text-right tabular-nums font-medium">
                  {formatQty(report.totalQty)}
                </TableCell>
                <TableCell className="text-right tabular-nums font-medium">
                  {formatCurrency(report.totalValue)}
                </TableCell>
              </TableRow>
            </TableFooter>
          </Table>
        </div>
      )}
    </div>
  );
}
