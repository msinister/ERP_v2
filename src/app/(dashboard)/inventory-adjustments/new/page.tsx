import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { db } from '@/lib/db';
import { listWarehouses } from '@/server/services/warehouse';
import type { VariantPickerOption } from '@/components/shared/variant-picker';
import { BatchAdjustmentForm } from './_components/batch-form';

export const revalidate = 0;

export default async function NewAdjustmentPage() {
  const [warehouses, variants] = await Promise.all([
    listWarehouses(db),
    db.productVariant.findMany({
      where: {
        active: true,
        deletedAt: null,
        product: { active: true, deletedAt: null },
      },
      select: {
        id: true,
        sku: true,
        name: true,
        product: { select: { name: true, shortDescription: true } },
      },
      orderBy: { sku: 'asc' },
      take: 2000,
    }),
  ]);

  const variantOptions: VariantPickerOption[] = variants.map((v) => ({
    id: v.id,
    sku: v.sku,
    productName: v.product.name,
    variantName: v.name,
    shortDescription: v.product.shortDescription,
  }));

  const warehouseOptions = warehouses.map((w) => ({
    id: w.id,
    code: w.code,
    name: w.name,
  }));

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Link
          href="/inventory-adjustments"
          className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="size-3.5" />
          Inventory Adjustments
        </Link>
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            New adjustment
          </h1>
          <p className="text-sm text-muted-foreground">
            Batch multiple variants in one adjustment — useful for cycle
            counts and end-of-period corrections.
          </p>
        </div>
      </div>

      <BatchAdjustmentForm
        warehouses={warehouseOptions}
        variants={variantOptions}
      />
    </div>
  );
}
