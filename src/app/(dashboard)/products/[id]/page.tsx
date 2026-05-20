import { notFound } from 'next/navigation';
import { Prisma } from '@/generated/tenant';
import { db } from '@/lib/db';
import { computeWac, getLastPurchaseCost } from '@/server/services/wac';
import { listTagsForProduct } from '@/server/services/productTags';
import { listVendors } from '@/server/services/vendors';
import { listPaymentTerms } from '@/server/services/paymentTerms';
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs';
import { ProductHeader } from './_components/header';
import { OverviewTab } from './_components/overview-tab';
import { VariantsTab, type VariantRow } from './_components/variants-tab';
import {
  InventoryTab,
  type InventoryRow,
} from './_components/inventory-tab';
import {
  MovementsTab,
  type MovementRow,
} from './_components/movements-tab';
import {
  ImagesTab,
  type ProductImageRow,
  type VariantImageRow,
} from './_components/images-tab';
import {
  BomTab,
  type BomComponentOption,
  type BomTabExistingLine,
} from './_components/bom-tab';

// Always live — inventory + movements change with every PO receive,
// SO close, and manual adjustment. revalidate=0 matches the other
// detail pages.
export const revalidate = 0;

export default async function ProductDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const product = await db.product.findUnique({
    where: { id },
    include: {
      images: {
        where: { deletedAt: null },
        orderBy: [
          { isPrimary: 'desc' },
          { sortOrder: 'asc' },
          { createdAt: 'asc' },
        ],
      },
    },
  });
  // We allow archived products to render so operators can audit them
  // — the header surfaces the Archived badge and hides Edit/Archive.
  if (!product) notFound();

  // Variants + their per-bin inventory rows in one round-trip. Inactive
  // variants are included so historical/archived SKUs are visible.
  const variants = await db.productVariant.findMany({
    where: { productId: product.id },
    include: {
      inventory: {
        include: { warehouse: { select: { code: true, name: true } } },
      },
    },
    orderBy: [{ active: 'desc' }, { sku: 'asc' }],
  });

  const variantRows: VariantRow[] = variants
    .filter((v) => v.deletedAt == null)
    .map((v) => ({
      id: v.id,
      sku: v.sku,
      name: v.name,
      variantGroup: v.variantGroup,
      color: v.color,
      flavor: v.flavor,
      size: v.size,
      active: v.active,
    }));

  const productImageRows: ProductImageRow[] = product.images.map((img) => ({
    id: img.id,
    url: img.url,
    altText: img.altText,
    isPrimary: img.isPrimary,
    sortOrder: img.sortOrder,
  }));

  const variantImageRows: VariantImageRow[] = variants
    .filter((v) => v.deletedAt == null)
    .map((v) => ({
      id: v.id,
      sku: v.sku,
      name: v.name,
      imageUrl: v.imageUrl,
    }));

  // Flatten (variant, warehouse) pairs that have InventoryItem rows.
  // Pairs with no row are zero everywhere — there's no point rendering
  // them in the table (the SO entry path uses a different per-bin
  // lookup that gracefully handles missing rows).
  type Pair = {
    inventoryItemId: string;
    variantId: string;
    variantSku: string;
    variantName: string | null;
    warehouseId: string;
    warehouseCode: string;
    warehouseName: string;
    binLocation: string | null;
    onHand: Prisma.Decimal;
    reserved: Prisma.Decimal;
  };
  const pairs: Pair[] = [];
  for (const v of variants) {
    for (const inv of v.inventory) {
      pairs.push({
        inventoryItemId: inv.id,
        variantId: v.id,
        variantSku: v.sku,
        variantName: v.name,
        warehouseId: inv.warehouseId,
        warehouseCode: inv.warehouse.code,
        warehouseName: inv.warehouse.name,
        binLocation: inv.binLocation,
        onHand: inv.onHand,
        reserved: inv.reserved,
      });
    }
  }

  // WAC + last cost run in parallel — typically <10 pairs for pilot.
  const wacAndLast = await Promise.all(
    pairs.map((p) =>
      Promise.all([
        computeWac(db, p.variantId, p.warehouseId),
        getLastPurchaseCost(db, p.variantId, p.warehouseId),
      ]),
    ),
  );

  const zero = new Prisma.Decimal(0);
  const inventoryRows: InventoryRow[] = pairs.map((p, i) => {
    const rawAvail = p.onHand.minus(p.reserved);
    return {
      inventoryItemId: p.inventoryItemId,
      variantSku: p.variantSku,
      variantName: p.variantName,
      warehouseCode: p.warehouseCode,
      warehouseName: p.warehouseName,
      binLocation: p.binLocation,
      onHand: p.onHand,
      reserved: p.reserved,
      available: rawAvail.lessThan(0) ? zero : rawAvail,
      wac: wacAndLast[i][0],
      lastCost: wacAndLast[i][1],
    };
  });

  // Sort: variant SKU first, then warehouse code.
  inventoryRows.sort((a, b) => {
    if (a.variantSku !== b.variantSku)
      return a.variantSku < b.variantSku ? -1 : 1;
    return a.warehouseCode < b.warehouseCode ? -1 : 1;
  });

  const variantIds = variants.map((v) => v.id);
  const movements =
    variantIds.length > 0
      ? await db.inventoryMovement.findMany({
          where: { variantId: { in: variantIds } },
          include: {
            variant: { select: { sku: true } },
            warehouse: { select: { code: true } },
          },
          orderBy: { createdAt: 'desc' },
          take: 50,
        })
      : [];

  const movementRows: MovementRow[] = movements.map((m) => ({
    id: m.id,
    createdAt: m.createdAt,
    type: m.type,
    variantSku: m.variant.sku,
    warehouseCode: m.warehouse.code,
    qty: m.qty,
    unitCost: m.unitCost,
    reference: m.reference,
    notes: m.notes,
    negativeAllocation: m.negativeAllocation,
  }));

  // BOM data only loaded when the tab is shown (SIMPLE + ASSEMBLED +
  // BUNDLE). For other types (DROP_SHIP / SERVICE) the tab is hidden
  // entirely. BUNDLE products use the same BOM table for the bundle
  // composition; the tab label adapts based on the product type.
  const bomEligible =
    product.type === 'SIMPLE' ||
    product.type === 'ASSEMBLED' ||
    product.type === 'BUNDLE';

  // BOM lines for the read view: pre-joined component variant + parent
  // product names so the table renders without a second lookup.
  const bomLineRows: BomTabExistingLine[] = bomEligible
    ? (
        await db.bomLine.findMany({
          where: { parentProductId: product.id, deletedAt: null },
          include: {
            componentVariant: {
              select: {
                sku: true,
                name: true,
                product: { select: { name: true } },
              },
            },
          },
          orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        })
      ).map((l) => ({
        id: l.id,
        componentVariantId: l.componentVariantId,
        qtyRequired: l.qtyRequired.toString(),
        sortOrder: l.sortOrder,
        notes: l.notes,
        componentVariantSku: l.componentVariant.sku,
        componentVariantName: l.componentVariant.name,
        componentProductName: l.componentVariant.product.name,
      }))
    : [];

  // Component picker options for the BOM editor — every active variant
  // EXCEPT the parent product's own variants (the service rejects
  // self-reference and the UI shouldn't surface the option).
  const bomComponentOptions: BomComponentOption[] = bomEligible
    ? (
        await db.productVariant.findMany({
          where: {
            active: true,
            deletedAt: null,
            productId: { not: product.id },
            product: { active: true, deletedAt: null },
          },
          select: {
            id: true,
            sku: true,
            name: true,
            product: { select: { name: true, sku: true } },
          },
          orderBy: { sku: 'asc' },
          take: 1000,
        })
      ).map((v) => ({
        variantId: v.id,
        variantSku: v.sku,
        variantName: v.name,
        productName: v.product.name,
        productSku: v.product.sku,
      }))
    : [];

  // Tags + primary vendor for the Overview tab. Primary vendor is the
  // VendorProduct flagged isPrimary on any of this product's variants
  // (typically the default variant); first by creation order wins.
  const productTags = await listTagsForProduct(db, product.id);
  const primaryVendorLink = await db.vendorProduct.findFirst({
    where: {
      variant: { productId: product.id },
      isPrimary: true,
      deletedAt: null,
    },
    include: { vendor: { select: { id: true, name: true } } },
    orderBy: { createdAt: 'asc' },
  });

  // Selectable vendors for the inline picker — active, non-SERVICE
  // (catalog rows are blocked for SERVICE vendors at the service layer).
  const vendorOptions = (await listVendors(db, { active: true, take: 1000 }))
    .filter((v) => v.type !== 'SERVICE')
    .map((v) => ({ id: v.id, code: v.code, name: v.name }));

  // Payment terms for the inline "create vendor" dialog (required field).
  const paymentTermOptions = (
    await listPaymentTerms(db, { active: true })
  ).map((t) => ({
    id: t.id,
    label: t.netDays === null ? t.label : `${t.label} (net ${t.netDays})`,
  }));

  return (
    <div className="space-y-6">
      <ProductHeader product={product} hasBom={bomLineRows.length > 0} />

      <Tabs defaultValue="overview">
        <TabsList variant="line" className="overflow-x-auto">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="images">
            Images
            {productImageRows.length > 0 ? (
              <span className="ml-1 text-xs text-muted-foreground">
                ({productImageRows.length})
              </span>
            ) : null}
          </TabsTrigger>
          <TabsTrigger value="variants">
            Variants
            {variantRows.length > 0 ? (
              <span className="ml-1 text-xs text-muted-foreground">
                ({variantRows.length})
              </span>
            ) : null}
          </TabsTrigger>
          <TabsTrigger value="inventory">Inventory</TabsTrigger>
          {bomEligible ? (
            <TabsTrigger value="bom">
              BOM
              {bomLineRows.length > 0 ? (
                <span className="ml-1 text-xs text-muted-foreground">
                  ({bomLineRows.length})
                </span>
              ) : null}
            </TabsTrigger>
          ) : null}
          <TabsTrigger value="movements">
            Movements
            {movementRows.length > 0 ? (
              <span className="ml-1 text-xs text-muted-foreground">
                ({movementRows.length})
              </span>
            ) : null}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
          <OverviewTab
            product={product}
            tags={productTags.map((t) => ({ id: t.id, name: t.name }))}
            vendor={
              primaryVendorLink
                ? {
                    id: primaryVendorLink.vendor.id,
                    name: primaryVendorLink.vendor.name,
                  }
                : null
            }
            vendors={vendorOptions}
            paymentTerms={paymentTermOptions}
          />
        </TabsContent>
        <TabsContent value="images">
          <ImagesTab
            productId={product.id}
            productImages={productImageRows}
            variants={variantImageRows}
          />
        </TabsContent>
        <TabsContent value="variants">
          <VariantsTab
            productId={product.id}
            productSku={product.sku}
            variants={variantRows}
          />
        </TabsContent>
        <TabsContent value="inventory">
          <InventoryTab rows={inventoryRows} />
        </TabsContent>
        {bomEligible ? (
          <TabsContent value="bom">
            <BomTab
              productId={product.id}
              productType={product.type}
              laborCost={product.bomLaborCost?.toString() ?? null}
              existingLines={bomLineRows}
              componentOptions={bomComponentOptions}
            />
          </TabsContent>
        ) : null}
        <TabsContent value="movements">
          <MovementsTab rows={movementRows} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
