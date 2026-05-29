import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import { db } from '@/lib/db';
import { requirePagePermission } from '@/lib/permissions/requirePagePermission';
import { getPurchaseOrder } from '@/server/services/purchaseOrders';
import { listVendors } from '@/server/services/vendors';
import { listWarehouses } from '@/server/services/warehouse';
import { listPaymentTerms } from '@/server/services/paymentTerms';
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
  await requirePagePermission('vendors.edit');
  const { id } = await params;
  const [po, vendors, warehouses, variants, catalogRows, paymentTerms] =
    await Promise.all([
    getPurchaseOrder(db, id),
    // Same productVendorsOnly filter as the new-PO page. The vendor is
    // disabled on edit anyway, and the existing-vendor injection below
    // ensures the PO's current vendor still shows up if it doesn't pass
    // the filter (e.g. retroactively retyped to SERVICE).
    listVendors(db, { active: true, productVendorsOnly: true, take: 1000 }),
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
  if (!po) notFound();

  // Edit reachable on DRAFT + CONFIRMED + PARTIALLY_RECEIVED. CLOSED
  // and CANCELLED redirect back to detail. PARTIALLY_RECEIVED locks
  // the lines section read-only (see linesLocked below) — header
  // fields (notes, expected receive, currency) stay editable.
  if (
    po.status !== 'DRAFT' &&
    po.status !== 'CONFIRMED' &&
    po.status !== 'PARTIALLY_RECEIVED'
  ) {
    redirect(`/purchase-orders/${po.id}`);
  }
  const linesLocked = po.status === 'PARTIALLY_RECEIVED';

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
            {linesLocked
              ? 'This PO has received shipments. Header fields are editable; lines are locked. To change lines, reverse the receipts first or cancel-and-recreate the PO.'
              : 'Lines are wholesale-replaced on save.'}
          </p>
        </div>
      </div>

      <PoForm
        mode={{ kind: 'edit', purchaseOrderId: po.id }}
        vendors={vendorOptions}
        paymentTerms={paymentTermOptions}
        warehouses={warehouseOptions}
        variants={variantOptions}
        catalogHints={catalogHints}
        defaultValues={defaults}
        linesLocked={linesLocked}
      />
    </div>
  );
}
