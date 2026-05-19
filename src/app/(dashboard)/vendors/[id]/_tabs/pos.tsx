import Link from 'next/link';
import { Prisma } from '@/generated/tenant';
import { db } from '@/lib/db';
import { StatusBadge } from '@/components/shared/status-badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { listPurchaseOrders } from '@/server/services/purchaseOrders';
import { formatCurrency } from '@/lib/format';
import { TabShell, TabEmpty } from './tab-shell';

// Embedded read-only PO table filtered to this vendor. 6E adds the
// top-level /purchase-orders list with filters + paging; this tab is
// the per-vendor quick view.

export async function PosTab({ vendorId }: { vendorId: string }) {
  // Pilot scale: a single vendor's PO history will fit comfortably in
  // one page. Take 100 (service default) is plenty; if a vendor crosses
  // that, the top-level /purchase-orders list with filter is the right
  // place to dig deeper.
  const pos = await listPurchaseOrders(db, { vendorId, take: 100 });

  if (pos.length === 0) {
    return (
      <TabShell>
        <TabEmpty message="No purchase orders for this vendor yet." />
      </TabShell>
    );
  }

  return (
    <TabShell>
      <div className="rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/30 hover:bg-muted/30">
              <TableHead>PO #</TableHead>
              <TableHead>Order date</TableHead>
              <TableHead>Expected</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Lines</TableHead>
              <TableHead className="text-right">Total</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pos.map((po) => {
              // Σ(qtyOrdered × unitCost) over non-deleted lines.
              // listPurchaseOrders already filters lines to deletedAt:null.
              const total = po.lines.reduce(
                (acc, l) => acc.plus(l.qtyOrdered.times(l.unitCost)),
                new Prisma.Decimal(0),
              );
              return (
                <TableRow
                  key={po.id}
                  className="relative cursor-pointer hover:bg-muted/50"
                >
                  <TableCell className="font-mono text-xs">
                    {/* Stretched-link overlay — same pattern as the
                        vendors and customers list tables. Target lands
                        in 6F (PO detail). */}
                    <Link
                      href={`/purchase-orders/${po.id}`}
                      className="absolute inset-0 rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    >
                      <span className="sr-only">View {po.number}</span>
                    </Link>
                    {po.number}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {po.createdAt.toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric',
                      timeZone: 'UTC',
                    })}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {po.expectedReceiveDate
                      ? po.expectedReceiveDate.toLocaleDateString('en-US', {
                          month: 'short',
                          day: 'numeric',
                          year: 'numeric',
                          timeZone: 'UTC',
                        })
                      : '—'}
                  </TableCell>
                  <TableCell>
                    <StatusBadge entityType="PurchaseOrder" status={po.status} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {po.lines.length}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatCurrency(total)}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </TabShell>
  );
}

