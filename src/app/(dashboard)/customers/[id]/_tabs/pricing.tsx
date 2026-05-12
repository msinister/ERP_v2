import { db } from '@/lib/db';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatCurrency } from '@/lib/format';
import { TabShell, TabEmpty } from './tab-shell';

export async function PricingTab({ customerId }: { customerId: string }) {
  // listOverridesForCustomer returns bare overrides; we need the
  // variant SKU + product name to make the table meaningful, so query
  // directly with the include rather than wrapping the service.
  const overrides = await db.customerPriceOverride.findMany({
    where: { customerId, deletedAt: null },
    include: {
      variant: {
        select: {
          sku: true,
          name: true,
          product: { select: { name: true } },
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  });

  if (overrides.length === 0) {
    return (
      <TabShell>
        <TabEmpty message="No customer-specific price overrides. Falls back to tier pricing." />
      </TabShell>
    );
  }

  return (
    <TabShell>
      <div className="rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/30 hover:bg-muted/30">
              <TableHead>SKU</TableHead>
              <TableHead>Product</TableHead>
              <TableHead className="text-right">Override price</TableHead>
              <TableHead>Currency</TableHead>
              <TableHead>Notes</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {overrides.map((o) => (
              <TableRow key={o.id}>
                <TableCell className="font-mono text-xs">
                  {o.variant.sku}
                </TableCell>
                <TableCell className="font-medium">
                  {o.variant.product.name}
                  {o.variant.name ? (
                    <span className="text-muted-foreground">
                      {' '}
                      — {o.variant.name}
                    </span>
                  ) : null}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatCurrency(o.unitPrice)}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {o.currency ?? 'USD'}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {o.notes ?? '—'}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </TabShell>
  );
}
