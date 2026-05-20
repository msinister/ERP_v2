import Link from 'next/link';
import { db } from '@/lib/db';
import { lowStockWidget } from '@/server/services/reports/dashboard';
import { formatCount } from '@/lib/format';
import { WidgetCard } from './widget-card';

// Pilot uses Available ≤ 0 as the low-stock trigger (no reorder-point
// field in schema yet — deferred per docs/11). "View all" routes to
// the Inventory Valuation report, which is the closest hub for
// stock-on-hand drill-down.

export async function LowStockWidget() {
  const data = await lowStockWidget(db);
  const overflow = data.totalLow - data.rows.length;
  return (
    <WidgetCard
      title="Low Stock Alerts"
      subtitle="Available ≤ 0 across all warehouses"
    >
      {data.rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing is currently below threshold.
        </p>
      ) : (
        <>
          <div className="overflow-hidden rounded-md border border-border">
            <table className="w-full text-xs">
              <thead className="bg-muted/30 text-muted-foreground">
                <tr>
                  <th className="px-2 py-1.5 text-left font-medium">SKU</th>
                  <th className="px-2 py-1.5 text-left font-medium">Name</th>
                  <th className="px-2 py-1.5 text-right font-medium">QOH</th>
                  <th className="px-2 py-1.5 text-right font-medium">Avail</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row) => {
                  const negative = row.available.lt(0);
                  return (
                    <tr
                      key={row.variantId}
                      className="border-t border-border hover:bg-muted/40"
                    >
                      <td className="px-2 py-1.5 font-mono text-[11px] text-muted-foreground">
                        <Link
                          href={`/products/${row.productId}`}
                          className="hover:underline"
                        >
                          {row.sku}
                        </Link>
                      </td>
                      <td className="max-w-[18ch] truncate px-2 py-1.5">
                        {row.name}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums">
                        {row.qoh.toFixed(0)}
                      </td>
                      <td
                        className={
                          'px-2 py-1.5 text-right tabular-nums ' +
                          (negative ? 'text-destructive' : 'text-foreground')
                        }
                      >
                        {row.available.toFixed(0)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
            <span>
              {overflow > 0
                ? `Showing top 10 of ${formatCount(data.totalLow)}`
                : `${formatCount(data.totalLow)} item${data.totalLow === 1 ? '' : 's'}`}
            </span>
            <Link
              href="/reports/inventory/valuation"
              className="font-medium text-foreground hover:underline"
            >
              View all →
            </Link>
          </div>
        </>
      )}
    </WidgetCard>
  );
}
