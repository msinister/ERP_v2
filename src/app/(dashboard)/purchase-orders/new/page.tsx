import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { db } from '@/lib/db';
import { requirePagePermission } from '@/lib/permissions/requirePagePermission';
import { listVendors } from '@/server/services/vendors';
import { listWarehouses } from '@/server/services/warehouse';
import { listPaymentTerms } from '@/server/services/paymentTerms';
import {
  PoForm,
  type VendorOption,
  type WarehouseOption,
  type VariantOption,
  type CatalogHint,
} from '../_components/po-form';

// Always live — vendor / warehouse / variant lists may have just been
// edited by an admin and a stale dropdown would be confusing.
export const revalidate = 0;

export default async function NewPurchaseOrderPage() {
  await requirePagePermission('vendors.create');
  // Pilot scale: dozens of vendors, dozens of variants, a few hundred
  // catalog rows max. One fetch each — no per-line API search.
  const [vendors, warehouses, variants, catalogRows, paymentTerms] =
    await Promise.all([
    listVendors(db, { active: true, take: 1000 }),
    listWarehouses(db),
    db.productVariant.findMany({
      where: {
        active: true,
        deletedAt: null,
        product: { active: true, deletedAt: null },
      },
      include: {
        product: { select: { name: true, shortDescription: true } },
      },
      orderBy: { sku: 'asc' },
      take: 1000,
    }),
    // All non-deleted catalog rows across all vendors. The form
    // dedupes by (vendorId, variantId) into a Map and looks up on
    // every line (vendor, variant) change to pre-fill SKU + cost.
    db.vendorProduct.findMany({
      where: { deletedAt: null },
      select: {
        vendorId: true,
        variantId: true,
        vendorSku: true,
        latestCost: true,
      },
      take: 5000,
    }),
    listPaymentTerms(db, { active: true }),
  ]);

  const vendorOptions: VendorOption[] = vendors.map((v) => ({
    id: v.id,
    code: v.code,
    name: v.name,
    type: v.type,
    defaultCurrency: v.defaultCurrency,
  }));
  const warehouseOptions: WarehouseOption[] = warehouses.map((w) => ({
    id: w.id,
    code: w.code,
    name: w.name,
  }));
  const variantOptions: VariantOption[] = variants.map((v) => ({
    id: v.id,
    sku: v.sku,
    variantName: v.name,
    productName: v.product.name,
    shortDescription: v.product.shortDescription,
  }));
  const catalogHints: CatalogHint[] = catalogRows.map((r) => ({
    vendorId: r.vendorId,
    variantId: r.variantId,
    vendorSku: r.vendorSku,
    latestCost: r.latestCost?.toString() ?? null,
  }));
  // Payment terms for the inline "create vendor" dialog (required field).
  const paymentTermOptions = paymentTerms.map((t) => ({
    id: t.id,
    label: t.netDays === null ? t.label : `${t.label} (net ${t.netDays})`,
  }));

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Link
          href="/purchase-orders"
          className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="size-3.5" />
          Purchase Orders
        </Link>
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">New PO</h1>
          <p className="text-sm text-muted-foreground">
            Create a draft. Confirm signals the vendor; receiving lands in
            a separate flow.
          </p>
        </div>
      </div>

      <PoForm
        mode={{ kind: 'create' }}
        vendors={vendorOptions}
        paymentTerms={paymentTermOptions}
        warehouses={warehouseOptions}
        variants={variantOptions}
        catalogHints={catalogHints}
      />
    </div>
  );
}
