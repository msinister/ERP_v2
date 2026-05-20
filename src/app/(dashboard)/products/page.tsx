import Link from 'next/link';
import { Plus, Upload } from 'lucide-react';
import { db } from '@/lib/db';
import {
  listProductBrands,
  listProductCategories,
  listProductsPaged,
  type ProductStatusFilter,
} from '@/server/services/products';
import { listAllTags } from '@/server/services/productTags';
import { Button } from '@/components/ui/button';
import { ProductsFilters } from './_components/filters';
import { ProductsTable, type ProductRowData } from './_components/table';
import { ProductsPagination } from './_components/pagination';
import { ExportButton } from './_components/export-button';

export const revalidate = 0;

const DEFAULT_PAGE_SIZE = 25;

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function pickString(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v ?? undefined;
}

function isStatus(v: string | undefined): v is ProductStatusFilter {
  return v === 'active' || v === 'all' || v === 'archived';
}

export default async function ProductsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const sp = await searchParams;
  const q = pickString(sp.q);
  const statusRaw = pickString(sp.status);
  const status: ProductStatusFilter = isStatus(statusRaw) ? statusRaw : 'active';
  const brand = pickString(sp.brand);
  const category = pickString(sp.category);
  const tagsParam = pickString(sp.tags);
  const tagIds = tagsParam ? tagsParam.split(',').filter(Boolean) : undefined;
  const skip = Math.max(0, Number(pickString(sp.skip) ?? '0') || 0);
  const take = DEFAULT_PAGE_SIZE;

  const [brands, categories, allTags, page] = await Promise.all([
    listProductBrands(db),
    listProductCategories(db),
    listAllTags(db),
    listProductsPaged(db, { q, status, brand, category, tagIds, skip, take }),
  ]);

  const tagOptions = allTags.map((t) => ({ id: t.id, name: t.name }));

  const tableRows: ProductRowData[] = page.rows.map((p) => ({
    id: p.id,
    sku: p.sku,
    name: p.name,
    brand: p.brand,
    vendorName: p.vendorName,
    category: p.category,
    tags: p.tags,
    binLocation: p.binLocation,
    basePrice: p.basePrice,
    onHand: p.inventoryAgg.onHand,
    available: p.inventoryAgg.available,
    status:
      p.deletedAt != null
        ? 'archived'
        : p.active
          ? 'active'
          : 'inactive',
    variantCount: p.variantCount,
    imageUrl: p.primaryImageUrl,
  }));

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Products</h1>
          <p className="text-sm text-muted-foreground">
            Catalog, variants, inventory, and FIFO/WAC costing.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ExportButton />
          <Button variant="outline" render={<Link href="/products/import" />}>
            <Upload />
            Import
          </Button>
          <Button render={<Link href="/products/new" />}>
            <Plus />
            New product
          </Button>
        </div>
      </div>

      <ProductsFilters
        brands={brands}
        categories={categories}
        tags={tagOptions}
      />

      <ProductsTable rows={tableRows} />

      <ProductsPagination total={page.total} skip={skip} take={take} />
    </div>
  );
}
