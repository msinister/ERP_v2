import { notFound } from 'next/navigation';
import { Prisma } from '@/generated/tenant';
import { db } from '@/lib/db';
import { computeWac, getLastPurchaseCost } from '@/server/services/wac';
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
  const product = await db.product.findUnique({ where: { id } });
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

  // Flatten (variant, warehouse) pairs that have InventoryItem rows.
  // Pairs with no row are zero everywhere — there's no point rendering
  // them in the table (the SO entry path uses a different per-bin
  // lookup that gracefully handles missing rows).
  type Pair = {
    variantId: string;
    variantSku: string;
    variantName: string | null;
    warehouseId: string;
    warehouseCode: string;
    warehouseName: string;
    onHand: Prisma.Decimal;
    reserved: Prisma.Decimal;
  };
  const pairs: Pair[] = [];
  for (const v of variants) {
    for (const inv of v.inventory) {
      pairs.push({
        variantId: v.id,
        variantSku: v.sku,
        variantName: v.name,
        warehouseId: inv.warehouseId,
        warehouseCode: inv.warehouse.code,
        warehouseName: inv.warehouse.name,
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
      variantSku: p.variantSku,
      variantName: p.variantName,
      warehouseCode: p.warehouseCode,
      warehouseName: p.warehouseName,
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

  return (
    <div className="space-y-6">
      <ProductHeader product={product} />

      <Tabs defaultValue="overview">
        <TabsList variant="line" className="overflow-x-auto">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="variants">
            Variants
            {variantRows.length > 0 ? (
              <span className="ml-1 text-xs text-muted-foreground">
                ({variantRows.length})
              </span>
            ) : null}
          </TabsTrigger>
          <TabsTrigger value="inventory">Inventory</TabsTrigger>
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
          <OverviewTab product={product} />
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
        <TabsContent value="movements">
          <MovementsTab rows={movementRows} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
