import Link from 'next/link';
import { Plus } from 'lucide-react';
import { db } from '@/lib/db';
import { SalesOrderStatus } from '@/generated/tenant';
import { listSalesOrdersPaged } from '@/server/services/salesOrders';
import { listSalesReps } from '@/server/services/salesReps';
import { computeSalesOrderTotal } from '@/lib/ar/openSos';
import { Button } from '@/components/ui/button';
import {
  SalesOrdersFilters,
  type SalesRepOption,
} from './_components/filters';
import {
  SalesOrdersTable,
  type SalesOrderRowData,
} from './_components/table';
import { SalesOrdersPagination } from './_components/pagination';

export const revalidate = 0;

const DEFAULT_PAGE_SIZE = 25;

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function pickString(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v ?? undefined;
}

function isSalesOrderStatus(v: string | undefined): v is SalesOrderStatus {
  if (!v) return false;
  return Object.values(SalesOrderStatus).includes(v as SalesOrderStatus);
}

// YYYY-MM-DD from a <input type="date"> → local-tz Date at midnight.
// For dateTo we shift to end-of-day so the inclusive range catches
// every SO booked that day.
function parseDateInput(
  v: string | undefined,
  endOfDay: boolean,
): Date | undefined {
  if (!v) return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return undefined;
  const [, y, mo, d] = m;
  const date = new Date(Number(y), Number(mo) - 1, Number(d));
  if (endOfDay) date.setHours(23, 59, 59, 999);
  return date;
}

export default async function SalesOrdersPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const sp = await searchParams;
  const q = pickString(sp.q);
  const statusRaw = pickString(sp.status);
  const status = isSalesOrderStatus(statusRaw) ? statusRaw : undefined;
  const salesRepId = pickString(sp.salesRepId);
  const dateFrom = parseDateInput(pickString(sp.dateFrom), false);
  const dateTo = parseDateInput(pickString(sp.dateTo), true);
  const skip = Math.max(0, Number(pickString(sp.skip) ?? '0') || 0);
  const take = DEFAULT_PAGE_SIZE;

  const [salesReps, page] = await Promise.all([
    listSalesReps(db, { active: true }),
    listSalesOrdersPaged(db, {
      q,
      status,
      salesRepId,
      dateFrom,
      dateTo,
      skip,
      take,
    }),
  ]);

  // Resolve sales-rep name off the rep list (joined via customer.salesRepId).
  // Inactive reps still need to render against historical orders, so a
  // fall-through label catches the gap.
  const repName = new Map(salesReps.map((r) => [r.id, r.name]));
  const repOptions: SalesRepOption[] = salesReps.map((r) => ({
    id: r.id,
    label: r.name,
  }));

  const tableRows: SalesOrderRowData[] = page.rows.map((so) => ({
    id: so.id,
    number: so.number,
    customerId: so.customer.id,
    customerName: so.customer.name,
    orderDate: so.orderDate,
    status: so.status,
    total: computeSalesOrderTotal(so),
    salesRepName: repName.get(so.customer.salesRepId) ?? '—',
  }));

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            Sales Orders
          </h1>
          <p className="text-sm text-muted-foreground">
            Draft → Confirmed → Dispatched → Closed.
          </p>
        </div>
        <Button render={<Link href="/sales-orders/new" />}>
          <Plus />
          New order
        </Button>
      </div>

      <SalesOrdersFilters salesReps={repOptions} />

      <SalesOrdersTable rows={tableRows} />

      <SalesOrdersPagination total={page.total} skip={skip} take={take} />
    </div>
  );
}
