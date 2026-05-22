import { db } from '@/lib/db';
import { salesByRepWidget } from '@/server/services/reports/dashboard';
import { formatCurrency } from '@/lib/format';
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { WidgetCard } from './widget-card';

// Full-width KPI: gross sales per rep across This Month / Last Month /
// This Quarter / YTD. Manager/admin view only (gated on
// sales_orders.view_all at the dashboard level).
export async function SalesByRepWidget() {
  const data = await salesByRepWidget(db);

  return (
    <WidgetCard title="Sales by Rep" className="md:col-span-2">
      {data.rows.length === 0 ? (
        <div className="text-sm text-muted-foreground">
          No sales recorded in these periods yet.
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Sales Rep</TableHead>
              <TableHead className="text-right">This Month</TableHead>
              <TableHead className="text-right">Last Month</TableHead>
              <TableHead className="text-right">This Quarter</TableHead>
              <TableHead className="text-right">YTD</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.rows.map((r) => (
              <TableRow
                key={r.salesRepId ?? '__unassigned__'}
                className={r.salesRepId === null ? 'text-muted-foreground' : undefined}
              >
                <TableCell className="font-medium">{r.salesRepName}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatCurrency(r.thisMonth)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatCurrency(r.lastMonth)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatCurrency(r.thisQuarter)}
                </TableCell>
                <TableCell className="text-right tabular-nums font-semibold">
                  {formatCurrency(r.ytd)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
          <TableFooter>
            <TableRow>
              <TableCell className="font-medium">Total</TableCell>
              <TableCell className="text-right tabular-nums font-medium">
                {formatCurrency(data.totals.thisMonth)}
              </TableCell>
              <TableCell className="text-right tabular-nums font-medium">
                {formatCurrency(data.totals.lastMonth)}
              </TableCell>
              <TableCell className="text-right tabular-nums font-medium">
                {formatCurrency(data.totals.thisQuarter)}
              </TableCell>
              <TableCell className="text-right tabular-nums font-medium">
                {formatCurrency(data.totals.ytd)}
              </TableCell>
            </TableRow>
          </TableFooter>
        </Table>
      )}
    </WidgetCard>
  );
}
