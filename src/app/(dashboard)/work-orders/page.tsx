import Link from 'next/link';
import { Wrench } from 'lucide-react';
import { WorkOrderStatus } from '@/generated/tenant';
import { db } from '@/lib/db';
import { listWorkOrdersPaged } from '@/server/services/workOrders';
import { listAllOrderTags } from '@/server/services/orderTags';
import { getTableViewPref } from '@/server/services/userPreferences';
import { requirePagePermission } from '@/lib/permissions/requirePagePermission';
import { formatStatusLabel } from '@/lib/format';
import { WorkOrderTagFilter } from './_components/tag-filter';
import { WorkOrderSearchInput } from './_components/search-input';
import {
  WorkOrdersTable,
  type WorkOrderRowData,
} from './_components/table';

export const revalidate = 0;

const DEFAULT_PAGE_SIZE = 50;

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function pickString(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v ?? undefined;
}

function isWorkOrderStatus(v: string | undefined): v is WorkOrderStatus {
  if (!v) return false;
  return Object.values(WorkOrderStatus).includes(v as WorkOrderStatus);
}

export default async function WorkOrdersPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const sp = await searchParams;
  const q = pickString(sp.q);
  const statusRaw = pickString(sp.status);
  const status = isWorkOrderStatus(statusRaw) ? statusRaw : undefined;
  const tagsParam = pickString(sp.tags);
  const tagIds = tagsParam ? tagsParam.split(',').filter(Boolean) : undefined;

  const actor = await requirePagePermission('work_orders.view');

  const [allOrderTags, page, viewPref] = await Promise.all([
    listAllOrderTags(db),
    listWorkOrdersPaged(db, {
      q,
      status,
      tagIds,
      take: DEFAULT_PAGE_SIZE,
    }),
    getTableViewPref(db, actor.id, 'table.workOrders'),
  ]);
  const tagOptions = allOrderTags.map((t) => ({ id: t.id, name: t.name }));

  // Decimals → numbers across the Server→Client boundary.
  const rows: WorkOrderRowData[] = page.rows.map((wo) => ({
    id: wo.id,
    number: wo.number,
    productName: wo.product.name,
    variantSku: wo.variant.sku,
    warehouseCode: wo.warehouse.code,
    qtyToBuild: wo.qtyToBuild.toNumber(),
    qtyCompleted: wo.qtyCompleted.toNumber(),
    status: wo.status,
    createdAt: wo.createdAt,
    tags: wo.tags.map((a) => ({ id: a.tag.id, name: a.tag.name })),
  }));

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            Work Orders
          </h1>
          <p className="text-sm text-muted-foreground">
            Build assembled products from BOM components. Draft → In progress →
            Completed.
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <WorkOrderSearchInput />
        <WorkOrderTagFilter tags={tagOptions} />
      </div>

      <StatusTabs current={status} />

      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-12 text-center text-sm text-muted-foreground">
          <Wrench className="mx-auto mb-2 size-6 opacity-50" />
          No work orders {status ? `in ${formatStatusLabel(status)}` : 'yet'}.
          Open an Assembled product&apos;s detail page and click Build to
          create one.
        </div>
      ) : (
        <WorkOrdersTable rows={rows} initialPrefs={viewPref} />
      )}
    </div>
  );
}

function StatusTabs({ current }: { current: WorkOrderStatus | undefined }) {
  const tabs: Array<{ label: string; value: WorkOrderStatus | undefined }> = [
    { label: 'All', value: undefined },
    { label: 'Draft', value: WorkOrderStatus.DRAFT },
    { label: 'In progress', value: WorkOrderStatus.IN_PROGRESS },
    { label: 'Completed', value: WorkOrderStatus.COMPLETED },
    { label: 'Cancelled', value: WorkOrderStatus.CANCELLED },
  ];
  return (
    <div className="flex flex-wrap gap-1 border-b border-border">
      {tabs.map((t) => {
        const active = current === t.value;
        const href = t.value ? `/work-orders?status=${t.value}` : '/work-orders';
        return (
          <Link
            key={t.label}
            href={href}
            className={
              'border-b-2 px-3 py-1.5 text-sm font-medium transition-colors ' +
              (active
                ? 'border-foreground text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground')
            }
          >
            {t.label}
          </Link>
        );
      })}
    </div>
  );
}
