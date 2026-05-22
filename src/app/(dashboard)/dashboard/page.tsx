import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { getActor } from '@/lib/permissions/getActor';
import { hasPermission } from '@/lib/permissions/actor';
import { dashboardScopeSalesRepId } from '@/lib/permissions/scope';
import { SCOPE_PAIRS, type PermissionKey } from '@/lib/permissions/constants';
import { TodaysSalesWidget } from './_widgets/todays-sales';
import { SalesByRepWidget } from './_widgets/sales-by-rep';
import { ArAgingWidget } from './_widgets/ar-aging';
import { ApAgingWidget } from './_widgets/ap-aging';
import { OpenSosWidget } from './_widgets/open-sos';
import { OpenPosWidget } from './_widgets/open-pos';
import { LowStockWidget } from './_widgets/low-stock';
import { UnappliedPaymentsWidget } from './_widgets/unapplied-payments';
import { RecentActivityWidget } from './_widgets/recent-activity';
import { CashPositionWidget } from './_widgets/cash-position';
import { WidgetSkeleton } from './_widgets/widget-card';

// Dashboard always reflects live data (no caching) — operational
// counters drive ops decisions and stale numbers are worse than
// none. revalidate = 0 forces re-fetch on every request.
export const revalidate = 0;

export default async function DashboardPage() {
  const actor = await getActor();
  if (!actor) redirect('/login');

  // A "view own" sales rep sees the sales/AR widgets scoped to their own
  // customers; managers/admins (view_all / super) and non-rep roles see
  // the unscoped, company-wide numbers. null = unscoped.
  const repScope = dashboardScopeSalesRepId(actor);
  // Unapplied Payments scopes on the PAYMENTS view pair, not sales orders.
  const paymentScope = dashboardScopeSalesRepId(actor, SCOPE_PAIRS.payments);

  // Per-widget visibility (UX — pages remain the security boundary).
  // hasPermission short-circuits true for Super Admin.
  const can = (...keys: PermissionKey[]) =>
    keys.some((k) => hasPermission(actor, k));
  const canSO = can('sales_orders.view_all', 'sales_orders.view_own');
  // Sales-by-Rep is a cross-rep KPI: managers/admins only. A view_own rep
  // would see just their own row, redundant with Today's Sales.
  const canViewAllSO = can('sales_orders.view_all');
  const canBills = can('bills.view');
  const canVendors = can('vendors.view');
  const canInventory = can('inventory.view');
  const canPayments = can('payments.view_all', 'payments.view_own');
  const canAudit = can('admin.view_audit_log');
  const canGl = can('gl.view');

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground">
          Live snapshot of operations.
        </p>
      </div>
      {/* Widgets the user has no permission for are skipped entirely (no
          empty card); the grid reflows to fill the gaps. */}
      {/* grid-flow-dense lets the full-width Sales-by-Rep card drop to its
          own row right after Today's Sales while a half-width widget
          backfills the gap beside Today's Sales. */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 md:grid-flow-row-dense">
        {canSO ? (
          <Suspense fallback={<WidgetSkeleton title="Today's Sales" />}>
            <TodaysSalesWidget customerSalesRepId={repScope} />
          </Suspense>
        ) : null}
        {canViewAllSO ? (
          <Suspense
            fallback={
              <WidgetSkeleton
                title="Sales by Rep"
                className="md:col-span-2"
                bodyClassName="h-40"
              />
            }
          >
            <SalesByRepWidget />
          </Suspense>
        ) : null}
        {canSO ? (
          <Suspense
            fallback={<WidgetSkeleton title="AR Aging" bodyClassName="h-20" />}
          >
            <ArAgingWidget customerSalesRepId={repScope} />
          </Suspense>
        ) : null}
        {canBills ? (
          <Suspense
            fallback={<WidgetSkeleton title="AP Aging" bodyClassName="h-20" />}
          >
            <ApAgingWidget />
          </Suspense>
        ) : null}
        {canSO ? (
          <Suspense fallback={<WidgetSkeleton title="Open Sales Orders" />}>
            <OpenSosWidget customerSalesRepId={repScope} />
          </Suspense>
        ) : null}
        {canVendors ? (
          <Suspense fallback={<WidgetSkeleton title="Open Purchase Orders" />}>
            <OpenPosWidget />
          </Suspense>
        ) : null}
        {canInventory ? (
          <Suspense
            fallback={
              <WidgetSkeleton title="Low Stock Alerts" bodyClassName="h-40" />
            }
          >
            <LowStockWidget />
          </Suspense>
        ) : null}
        {canPayments ? (
          <Suspense fallback={<WidgetSkeleton title="Unapplied Payments" />}>
            <UnappliedPaymentsWidget customerSalesRepId={paymentScope} />
          </Suspense>
        ) : null}
        {canAudit ? (
          <Suspense
            fallback={
              <WidgetSkeleton title="Recent Activity" bodyClassName="h-40" />
            }
          >
            <RecentActivityWidget />
          </Suspense>
        ) : null}
        {canGl ? (
          <Suspense fallback={<WidgetSkeleton title="Cash Position" />}>
            <CashPositionWidget />
          </Suspense>
        ) : null}
      </div>
    </div>
  );
}
