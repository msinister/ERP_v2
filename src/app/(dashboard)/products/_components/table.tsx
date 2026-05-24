'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
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
import { ProductThumbnail } from '@/components/shared/product-thumbnail';
import { TableCustomizer } from '@/components/shared/table-customizer';
import {
  useTablePreferences,
  type CustomizableColumn,
  type TableViewPrefValue,
} from '@/components/shared/use-table-preferences';

// Money/qty arrive as decimal strings (Decimal.toString()) so nothing
// non-serializable crosses the server → client boundary. createdAt stays a
// Date (serializes fine) and is formatted UTC. wac is present only when the
// caller had products.view_cost; otherwise it's null and the column option
// is absent from the customizer.
export type ProductRowData = {
  id: string;
  sku: string;
  name: string;
  brand: string | null;
  vendorName: string | null;
  category: string | null;
  manufacturerPartNumber: string | null;
  tags: Array<{ id: string; name: string }>;
  binLocation: string | null;
  basePrice: string | null;
  onHand: string;
  available: string;
  status: 'active' | 'inactive' | 'archived';
  variantCount: number;
  imageUrl: string | null;
  createdAt: Date;
  qtyOnPo: string;
  wac: string | null;
};

const PREF_KEY = 'table.products';
const MAX_VISIBLE_TAGS = 3;

type ProductColumn = CustomizableColumn & {
  requiresCost?: boolean;
  headClass?: string;
  cellClass?: string;
  render: (row: ProductRowData) => ReactNode;
};

// Single source of truth for the products table's columns: order, labels,
// default visibility, locking, permission gating, and cell rendering.
const PRODUCT_COLUMNS: ProductColumn[] = [
  {
    id: 'sku',
    label: 'SKU',
    defaultVisible: true,
    locked: true,
    cellClass: 'font-mono text-xs font-semibold',
    render: (row) => (
      <>
        {/* Stretched-link overlay — whole row clickable. Lives in the
            always-visible SKU cell so the row is always navigable. */}
        <Link
          href={`/products/${row.id}`}
          className="absolute inset-0 rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <span className="sr-only">View {row.name}</span>
        </Link>
        {row.sku}
      </>
    ),
  },
  {
    id: 'name',
    label: 'Name',
    defaultVisible: true,
    render: (row) => (
      <>
        {row.name}
        {row.variantCount > 1 ? (
          <span className="ml-1.5 text-xs text-muted-foreground">
            ({row.variantCount} variants)
          </span>
        ) : null}
      </>
    ),
  },
  {
    id: 'brand',
    label: 'Brand',
    defaultVisible: true,
    cellClass: 'text-muted-foreground',
    render: (row) => row.brand ?? '—',
  },
  {
    id: 'vendor',
    label: 'Vendor',
    defaultVisible: true,
    cellClass: 'text-muted-foreground',
    render: (row) => row.vendorName ?? '—',
  },
  {
    id: 'category',
    label: 'Category',
    defaultVisible: true,
    cellClass: 'text-muted-foreground',
    render: (row) => row.category ?? '—',
  },
  {
    id: 'tags',
    label: 'Tags',
    defaultVisible: true,
    cellClass: 'relative z-10',
    render: (row) => <TagPills tags={row.tags} />,
  },
  {
    id: 'bin',
    label: 'Bin',
    defaultVisible: true,
    cellClass: 'font-mono text-xs text-muted-foreground',
    render: (row) => row.binLocation ?? '—',
  },
  {
    id: 'onHand',
    label: 'On hand',
    defaultVisible: true,
    headClass: 'text-right',
    cellClass: 'text-right tabular-nums',
    render: (row) => formatQty(row.onHand),
  },
  {
    id: 'available',
    label: 'Available',
    defaultVisible: true,
    headClass: 'text-right',
    cellClass: 'text-right tabular-nums',
    render: (row) => formatQty(row.available),
  },
  {
    id: 'basePrice',
    label: 'Price',
    defaultVisible: true,
    headClass: 'text-right',
    cellClass: 'text-right tabular-nums',
    render: (row) => (row.basePrice != null ? formatCurrency(row.basePrice) : '—'),
  },
  {
    id: 'status',
    label: 'Status',
    defaultVisible: true,
    render: (row) => <StatusBadge status={row.status} />,
  },
  {
    id: 'createdAt',
    label: 'Date created',
    defaultVisible: false,
    cellClass: 'text-muted-foreground whitespace-nowrap',
    render: (row) => formatDate(row.createdAt),
  },
  {
    id: 'mpn',
    label: 'MPN',
    defaultVisible: false,
    cellClass: 'font-mono text-xs text-muted-foreground',
    render: (row) => row.manufacturerPartNumber ?? '—',
  },
  {
    id: 'qtyOnPo',
    label: 'Qty on PO',
    defaultVisible: false,
    headClass: 'text-right',
    cellClass: 'text-right tabular-nums',
    render: (row) => formatQty(row.qtyOnPo),
  },
  {
    id: 'wac',
    label: 'WAC',
    defaultVisible: false,
    requiresCost: true,
    headClass: 'text-right',
    cellClass: 'text-right tabular-nums',
    render: (row) => (row.wac != null ? formatCurrency(row.wac) : '—'),
  },
];

export function ProductsTable({
  rows,
  canViewCost,
  initialPrefs,
}: {
  rows: ProductRowData[];
  // Drives whether the WAC column option + data are available at all.
  canViewCost: boolean;
  initialPrefs: TableViewPrefValue;
}) {
  // Cost columns are absent for users without the permission — not just
  // hidden. They never reach the customizer or the render set.
  const availableColumns = PRODUCT_COLUMNS.filter(
    (c) => !c.requiresCost || canViewCost,
  );
  const customizerColumns: CustomizableColumn[] = availableColumns.map((c) => ({
    id: c.id,
    label: c.label,
    defaultVisible: c.defaultVisible,
    locked: c.locked,
  }));

  const { isVisible, toggleColumn, showImages, setShowImages } =
    useTablePreferences({
      prefKey: PREF_KEY,
      columns: customizerColumns,
      initial: initialPrefs,
    });

  const visibleColumns = availableColumns.filter((c) => isVisible(c.id));

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <TableCustomizer
          columns={customizerColumns}
          isVisible={isVisible}
          onToggleColumn={toggleColumn}
          showImages={showImages}
          onToggleImages={setShowImages}
        />
      </div>

      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-12 text-center text-sm text-muted-foreground">
          No products match these filters.
        </div>
      ) : (
        <div className="rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/30 hover:bg-muted/30">
                {showImages ? (
                  <TableHead className="w-[60px]">
                    <span className="sr-only">Image</span>
                  </TableHead>
                ) : null}
                {visibleColumns.map((c) => (
                  <TableHead key={c.id} className={c.headClass}>
                    {c.label}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow
                  key={row.id}
                  className="relative cursor-pointer hover:bg-muted/50"
                >
                  {showImages ? (
                    // Thumbnail sits above the row's stretched link
                    // (relative z-10) so clicking it opens the preview
                    // rather than navigating.
                    <TableCell className="relative z-10">
                      <ProductThumbnail src={row.imageUrl} productName={row.name} />
                    </TableCell>
                  ) : null}
                  {visibleColumns.map((c) => (
                    <TableCell key={c.id} className={c.cellClass}>
                      {c.render(row)}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

function TagPills({ tags }: { tags: Array<{ id: string; name: string }> }) {
  if (tags.length === 0) {
    return <span className="text-muted-foreground">—</span>;
  }
  const visible = tags.slice(0, MAX_VISIBLE_TAGS);
  const overflow = tags.length - visible.length;
  return (
    <div className="flex flex-wrap items-center gap-1">
      {visible.map((t) => (
        <Badge key={t.id} variant="secondary" className="text-[10px] font-normal">
          {t.name}
        </Badge>
      ))}
      {overflow > 0 ? (
        <span
          className="text-[10px] text-muted-foreground"
          title={tags.map((t) => t.name).join(', ')}
        >
          +{overflow} more
        </span>
      ) : null}
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

function formatQty(qty: string): string {
  // Strip trailing zeros: "5.00000" → "5", "1.50000" → "1.5".
  if (!qty.includes('.')) return qty;
  return qty.replace(/\.?0+$/, '');
}

function formatDate(d: Date): string {
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}
