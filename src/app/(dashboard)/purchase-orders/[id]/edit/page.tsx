import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import { db } from '@/lib/db';
import { getPurchaseOrder } from '@/server/services/purchaseOrders';
import { listVendors } from '@/server/services/vendors';
import { listWarehouses } from '@/server/services/warehouse';
import {
  PoForm,
  type VendorOption,
  type WarehouseOption,
  type VariantOption,
  type CatalogHint,
  type PoFormValues,
} from '../../_components/po-form';

export const revalidate = 0;

export default async function EditPurchaseOrderPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [po, vendors, warehouses, variants, catalogRows] = await Promise.all([
    getPurchaseOrder(db, id),
    listVendors(db, { active: true, take: 1000 }),
    listWarehouses(db),
    db.productVariant.findMany({
      where: {
        active: true,
        deletedAt: null,
        product: { active: true, deletedAt: null },
      },
      include: { product: { select: { name: true } } },
      orderBy: { sku: 'asc' },
      take: 1000,
    }),
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
  ]);
  if (!po) notFound();

  // Edit is only allowed in DRAFT (service-side wholesale-replace
  // semantics). Surface that as a redirect rather than letting the
  // form load and then fail on submit.
  if (po.status !== 'DRAFT') {
    redirect(`/purchase-orders/${po.id}`);
  }

  const vendorOptions: VendorOption[] = vendors.map((v) => ({
    id: v.id,
    code: v.code,
    name: v.name,
    type: v.type,
    defaultCurrency: v.defaultCurrency,
  }));
  // The vendor list is filtered to active vendors, but the PO might
  // reference one that has since been deactivated. Inject it if so
  // (vendor is fixed-on-edit anyway, so this just keeps the label).
  if (!vendorOptions.find((v) => v.id === po.vendorId)) {
    const v = await db.vendor.findUnique({ where: { id: po.vendorId } });
    if (v) {
      vendorOptions.push({
        id: v.id,
        code: v.code,
        name: v.name,
        type: v.type,
        defaultCurrency: v.defaultCurrency,
      });
    }
  }
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
  }));
  const catalogHints: CatalogHint[] = catalogRows.map((r) => ({
    vendorId: r.vendorId,
    variantId: r.variantId,
    vendorSku: r.vendorSku,
    latestCost: r.latestCost?.toString() ?? null,
  }));

  // Every line of a DRAFT PO carries its own warehouseId. Schema
  // supports per-line warehouses; the create form uses a single
  // header warehouse for pilot. On edit, pick the first line's
  // warehouseId as the header default so re-submitting doesn't
  // accidentally collapse a multi-warehouse PO to one warehouse.
  const headerWarehouseId = po.lines[0]?.warehouseId ?? '';

  const defaults: Partial<PoFormValues> = {
    vendorId: po.vendorId,
    warehouseId: headerWarehouseId,
    expectedReceiveDate: po.expectedReceiveDate
      ? po.expectedReceiveDate.toISOString().slice(0, 10)
      : '',
    currency: po.currency ?? '',
    notes: po.notes ?? '',
    lines: po.lines.map((l) => ({
      variantId: l.variantId,
      qtyOrdered: l.qtyOrdered.toString(),
      unitCost: l.unitCost.toString(),
      vendorSku: l.vendorSku ?? '',
      manufacturerPartNumber: l.manufacturerPartNumber ?? '',
      notes: l.notes ?? '',
    })),
  };

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Link
          href={`/purchase-orders/${po.id}`}
          className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="size-3.5" />
          {po.number}
        </Link>
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Edit PO</h1>
          <p className="text-sm text-muted-foreground">
            Only DRAFT POs can be edited. Lines are wholesale-replaced on
            save.
          </p>
        </div>
      </div>

      <PoForm
        mode={{ kind: 'edit', purchaseOrderId: po.id }}
        vendors={vendorOptions}
        warehouses={warehouseOptions}
        variants={variantOptions}
        catalogHints={catalogHints}
        defaultValues={defaults}
      />
    </div>
  );
}
