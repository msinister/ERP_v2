import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Plus } from 'lucide-react';
import { Prisma, SalesOrderStatus } from '@/generated/tenant';
import { db } from '@/lib/db';
import {
  listSalesOrdersPaged,
  type SalesOrderListRow,
} from '@/server/services/salesOrders';
import { listSalesReps } from '@/server/services/salesReps';
import { listAllOrderTags } from '@/server/services/orderTags';
import { getTableViewPref } from '@/server/services/userPreferences';
import { computeSalesOrderDisplayTotal } from '@/lib/ar/openSos';
import {
  computeLineBillableTotal,
  effectiveBillableQty,
} from '@/lib/sales/lineTotals';
import { getActor } from '@/lib/permissions/getActor';
import { hasPermission } from '@/lib/permissions/actor';
import { salesOrderScopeWhere } from '@/lib/permissions/scope';
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

// Gross line subtotal (qty × price, no discounts) for the SO's billable
// basis. Pair with computeLineBillableTotal: diff is the line-level
// discount; add the resolved order-level discount for the column.
function computeDiscountsTotal(
  so: Pick<SalesOrderListRow, 'lines' | 'status' | 'orderDiscountAmount' | 'orderDiscountPercent'>,
): Prisma.Decimal {
  let lineDiscount = new Prisma.Decimal(0);
  let netSubtotal = new Prisma.Decimal(0);
  for (const l of so.lines) {
    if (l.deletedAt) continue;
    const qty = effectiveBillableQty(l, so.status);
    const gross = qty.times(l.unitPrice);
    const net = computeLineBillableTotal(l, so.status);
    lineDiscount = lineDiscount.plus(gross.minus(net));
    netSubtotal = netSubtotal.plus(net);
  }
  const orderDiscount =
    so.orderDiscountAmount ??
    (so.orderDiscountPercent != null
      ? netSubtotal.times(so.orderDiscountPercent).dividedBy(100)
      : new Prisma.Decimal(0));
  return lineDiscount.plus(orderDiscount);
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
  const tagsParam = pickString(sp.tags);
  const tagIds = tagsParam ? tagsParam.split(',').filter(Boolean) : undefined;
  const skip = Math.max(0, Number(pickString(sp.skip) ?? '0') || 0);
  const take = DEFAULT_PAGE_SIZE;

  const actor = await getActor();
  if (!actor) redirect('/login');
  const scope = salesOrderScopeWhere(actor);
  // Gates the Total COGS column + cost data end-to-end: when false, the
  // service nulls invoice.cogsAtClose on every row and the customizer
  // never offers the column. Matches products.view_cost semantics.
  const canViewCost = hasPermission(actor, 'products.view_cost');

  const [salesReps, allOrderTags, page, viewPref] = await Promise.all([
    listSalesReps(db, { active: true }),
    listAllOrderTags(db),
    listSalesOrdersPaged(db, {
      q,
      status,
      salesRepId,
      dateFrom,
      dateTo,
      tagIds,
      scope,
      includeCogs: canViewCost,
      skip,
      take,
    }),
    getTableViewPref(db, actor.id, 'table.salesOrders'),
  ]);

  const repName = new Map(salesReps.map((r) => [r.id, r.name]));
  const repOptions: SalesRepOption[] = salesReps.map((r) => ({
    id: r.id,
    label: r.name,
  }));
  const tagOptions = allOrderTags.map((t) => ({ id: t.id, name: t.name }));

  const tableRows: SalesOrderRowData[] = page.rows.map((so) => {
    const displayTotal = computeSalesOrderDisplayTotal(so);
    const shipping = so.shippingAmount ?? new Prisma.Decimal(0);
    const handling = so.handlingAmount ?? new Prisma.Decimal(0);
    const inv = so.invoice;
    // Invoice-only semantics for paid/credited/balance (confirmed
    // 2026-05-25). Pre-invoice: 0 paid, full order owed.
    const amountPaid = inv ? inv.amountPaid : new Prisma.Decimal(0);
    const amountCredited = inv ? inv.amountCredited : new Prisma.Decimal(0);
    const balanceDue = inv
      ? inv.total.minus(inv.amountPaid).minus(inv.amountCredited)
      : displayTotal;
    const netTotal = displayTotal.minus(shipping).minus(handling);
    const discounts = computeDiscountsTotal(so);
    return {
      id: so.id,
      number: so.number,
      customerId: so.customer.id,
      customerName: so.customer.name,
      orderDate: so.orderDate,
      status: so.status,
      // Effective rep: per-order override when set, else the customer's rep.
      salesRepName: repName.get(so.salesRepId ?? so.customer.salesRepId) ?? '—',
      total: displayTotal.toString(),
      amountPaid: amountPaid.toString(),
      balanceDue: balanceDue.toString(),
      credits: amountCredited.toString(),
      shippingFee: shipping.toString(),
      discounts: discounts.toString(),
      netTotal: netTotal.toString(),
      // cogsAtClose is already null when !canViewCost (service-side gate).
      totalCogs:
        canViewCost && inv?.cogsAtClose != null ? inv.cogsAtClose.toString() : null,
      tags: so.tags.map((a) => ({ id: a.tag.id, name: a.tag.name })),
    };
  });

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

      <SalesOrdersFilters salesReps={repOptions} tags={tagOptions} />

      <SalesOrdersTable
        rows={tableRows}
        canViewCost={canViewCost}
        initialPrefs={viewPref}
      />

      <SalesOrdersPagination total={page.total} skip={skip} take={take} />
    </div>
  );
}
