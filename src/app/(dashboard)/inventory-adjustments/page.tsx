import Link from 'next/link';
import { Plus } from 'lucide-react';
import {
  AdjustmentCategory,
  AdjustmentStatus,
  Prisma,
} from '@/generated/tenant';
import { db } from '@/lib/db';
import { listAdjustmentsPaged } from '@/server/services/inventoryAdjustments';
import { listWarehouses } from '@/server/services/warehouse';
import { Button } from '@/components/ui/button';
import {
  AdjustmentsFilters,
  type WarehouseOption,
} from './_components/filters';
import {
  AdjustmentsTable,
  type AdjustmentRowData,
} from './_components/table';
import { AdjustmentsPagination } from './_components/pagination';

export const revalidate = 0;

const PAGE_SIZE = 25;

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function pick(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : (v ?? undefined);
}

function isStatus(v: string | undefined): v is AdjustmentStatus {
  return !!v && Object.values(AdjustmentStatus).includes(v as AdjustmentStatus);
}
function isCategory(v: string | undefined): v is AdjustmentCategory {
  return (
    !!v && Object.values(AdjustmentCategory).includes(v as AdjustmentCategory)
  );
}

export default async function InventoryAdjustmentsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const sp = await searchParams;
  const status = isStatus(pick(sp.status)) ? (pick(sp.status) as AdjustmentStatus) : undefined;
  const category = isCategory(pick(sp.category))
    ? (pick(sp.category) as AdjustmentCategory)
    : undefined;
  const warehouseId = pick(sp.warehouseId);
  const fromParam = pick(sp.from);
  const toParam = pick(sp.to);
  const skip = Math.max(0, Number(pick(sp.skip) ?? '0') || 0);

  const [warehouses, page] = await Promise.all([
    listWarehouses(db),
    listAdjustmentsPaged(db, {
      status,
      category,
      warehouseId,
      from: fromParam ? new Date(fromParam) : undefined,
      to: toParam ? new Date(`${toParam}T23:59:59.999Z`) : undefined,
      skip,
      take: PAGE_SIZE,
    }),
  ]);

  // Resolve creator names in one batched query.
  const creatorIds = Array.from(
    new Set(
      page.rows
        .map((r) => r.createdById)
        .filter((id): id is string => id != null),
    ),
  );
  const creators =
    creatorIds.length > 0
      ? await db.user.findMany({
          where: { id: { in: creatorIds } },
          select: { id: true, name: true },
        })
      : [];
  const creatorById = new Map(creators.map((u) => [u.id, u.name]));

  const warehouseOptions: WarehouseOption[] = warehouses.map((w) => ({
    id: w.id,
    code: w.code,
    name: w.name,
  }));

  const rows: AdjustmentRowData[] = page.rows.map((a) => {
    const totalValue = a.lines.reduce(
      (acc, l) => acc.plus(l.qtyChange.abs().times(l.unitCost)),
      new Prisma.Decimal(0),
    );
    return {
      id: a.id,
      number: a.number,
      adjustmentDate: a.adjustmentDate,
      warehouseCode: a.warehouse.code,
      warehouseName: a.warehouse.name,
      lineCount: a.lines.length,
      category: a.category,
      totalValue: totalValue.toString(),
      status: a.status,
      createdByName: a.createdById
        ? (creatorById.get(a.createdById) ?? null)
        : null,
    };
  });

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            Inventory Adjustments
          </h1>
          <p className="text-sm text-muted-foreground">
            Shrink, breakage, theft, cycle counts, and found stock — each
            posts a FIFO-costed movement + GL journal entry.
          </p>
        </div>
        <Button render={<Link href="/inventory-adjustments/new" />}>
          <Plus />
          New adjustment
        </Button>
      </div>

      <AdjustmentsFilters warehouses={warehouseOptions} />

      <AdjustmentsTable rows={rows} />

      <AdjustmentsPagination total={page.total} skip={skip} take={PAGE_SIZE} />
    </div>
  );
}
