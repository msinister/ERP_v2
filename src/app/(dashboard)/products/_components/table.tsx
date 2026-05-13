import Link from 'next/link';
import type { Prisma } from '@/generated/tenant';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { formatCurrency } from '@/lib/format';

export type ProductRowData = {
  id: string;
  sku: string;
  name: string;
  brand: string | null;
  category: string | null;
  basePrice: Prisma.Decimal | null;
  onHand: Prisma.Decimal;
  available: Prisma.Decimal;
  status: 'active' | 'inactive' | 'archived';
  variantCount: number;
};

export function ProductsTable({ rows }: { rows: ProductRowData[] }) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border p-12 text-center text-sm text-muted-foreground">
        No products match these filters.
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/30 hover:bg-muted/30">
            <TableHead>SKU</TableHead>
            <TableHead>Name</TableHead>
            <TableHead>Brand</TableHead>
            <TableHead>Category</TableHead>
            <TableHead className="text-right">On hand</TableHead>
            <TableHead className="text-right">Available</TableHead>
            <TableHead className="text-right">Base price</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow
              key={row.id}
              className="relative cursor-pointer hover:bg-muted/50"
            >
              <TableCell className="font-mono text-xs text-muted-foreground">
                {/* Stretched-link overlay — whole row clickable. */}
                <Link
                  href={`/products/${row.id}`}
                  className="absolute inset-0 rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  <span className="sr-only">View {row.name}</span>
                </Link>
                {row.sku}
              </TableCell>
              <TableCell className="font-medium">
                {row.name}
                {row.variantCount > 1 ? (
                  <span className="ml-1.5 text-xs text-muted-foreground">
                    ({row.variantCount} variants)
                  </span>
                ) : null}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {row.brand ?? '—'}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {row.category ?? '—'}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatQty(row.onHand)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatQty(row.available)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {row.basePrice != null ? formatCurrency(row.basePrice) : '—'}
              </TableCell>
              <TableCell>
                <StatusBadge status={row.status} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function StatusBadge({
  status,
}: {
  status: 'active' | 'inactive' | 'archived';
}) {
  switch (status) {
    case 'active':
      return <Badge variant="secondary">Active</Badge>;
    case 'inactive':
      return (
        <Badge variant="outline" className="text-muted-foreground">
          Inactive
        </Badge>
      );
    case 'archived':
      return (
        <Badge variant="outline" className="text-muted-foreground">
          Archived
        </Badge>
      );
  }
}

function formatQty(qty: Prisma.Decimal): string {
  // Strip trailing zeros: 5.00000 → "5", 1.50000 → "1.5".
  const s = qty.toString();
  if (!s.includes('.')) return s;
  return s.replace(/\.?0+$/, '');
}
