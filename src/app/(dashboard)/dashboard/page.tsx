import { Suspense, type ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { getActor } from '@/lib/permissions/getActor';
import { hasPermission } from '@/lib/permissions/actor';
import { dashboardScopeSalesRepId } from '@/lib/permissions/scope';
import { SCOPE_PAIRS, type PermissionKey } from '@/lib/permissions/constants';
import { db } from '@/lib/db';
import { getUserPreference } from '@/server/services/userPreferences';
import { dashboardWidgetsPrefSchema } from '@/lib/validation/preferences';
import {
  WIDGET_REGISTRY,
  WIDGET_REGISTRY_MAP,
  DEFAULT_ORDER,
} from './_lib/widget-registry';
import { DashboardGrid } from './_components/dashboard-grid';
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
import { PendingOrderReviewsWidget } from './_widgets/pending-order-reviews';
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

  // Read saved widget prefs
  const rawPref = await getUserPreference(db, actor.id, 'dashboard.widgets');
  const parsedPref = dashboardWidgetsPrefSchema.safeParse(rawPref);
  const savedOrder = parsedPref.success ? (parsedPref.data.order ?? []) : [];
  const savedHidden = parsedPref.success ? (parsedPref.data.hidden ?? []) : [];

  // Permitted widget IDs (hard gate — never shown to users without access)
  const permittedIds = new Set(
    WIDGET_REGISTRY.filter((w) => w.permCheck(can, actor)).map((w) => w.id),
  );

  // Reconcile saved order: keep known IDs, append any new registry widgets
  const registryIds = new Set(WIDGET_REGISTRY.map((w) => w.id));
  const baseOrder = savedOrder.filter((id) => registryIds.has(id));
  const newIds = WIDGET_REGISTRY.filter((w) => !baseOrder.includes(w.id)).map(
    (w) => w.id,
  );
  const reconciledOrder = [...baseOrder, ...newIds];

  // Final order: only permitted widgets
  const finalOrder = reconciledOrder.filter((id) => permittedIds.has(id));
  const hiddenArr = savedHidden.filter((id) => permittedIds.has(id));

  // Permitted widget metadata (for customize panel + grid class lookup)
  const permittedWidgets = finalOrder
    .map((id) => WIDGET_REGISTRY_MAP.get(id))
    .filter((w): w is NonNullable<typeof w> => w != null)
    .map((w) => ({ id: w.id, label: w.label, colSpan: w.colSpan }));

  // Permitted default order (for reset-to-defaults)
  const permittedDefaultOrder = DEFAULT_ORDER.filter((id) =>
    permittedIds.has(id),
  );

  // Build Suspense-wrapped widget nodes for all permitted widgets
  const canSO = can('sales_orders.view_all', 'sales_orders.view_own');
  const canViewAllSO = can('sales_orders.view_all');
  const canBills = can('bills.view');
  const canVendors = can('vendors.view');
  const canInventory = can('inventory.view');
  const canPayments = can('payments.view_all', 'payments.view_own');
  const canAudit = can('admin.view_audit_log');
  const canGl = can('gl.view');

  const widgetNodes: Record<string, ReactNode> = {
    'todays-sales': canSO ? (
      <Suspense fallback={<WidgetSkeleton title="Today's Sales" />}>
        <TodaysSalesWidget customerSalesRepId={repScope} />
      </Suspense>
    ) : null,
    'sales-by-rep': canViewAllSO ? (
      <Suspense
        fallback={
          <WidgetSkeleton
            title="Sales by Rep"
            bodyClassName="h-40"
          />
        }
      >
        <SalesByRepWidget />
      </Suspense>
    ) : null,
    'ar-aging': canSO ? (
      <Suspense
        fallback={<WidgetSkeleton title="AR Aging" bodyClassName="h-20" />}
      >
        <ArAgingWidget customerSalesRepId={repScope} />
      </Suspense>
    ) : null,
    'ap-aging': canBills ? (
      <Suspense
        fallback={<WidgetSkeleton title="AP Aging" bodyClassName="h-20" />}
      >
        <ApAgingWidget />
      </Suspense>
    ) : null,
    'open-sos': canSO ? (
      <Suspense fallback={<WidgetSkeleton title="Open Sales Orders" />}>
        <OpenSosWidget customerSalesRepId={repScope} />
      </Suspense>
    ) : null,
    'open-pos': canVendors ? (
      <Suspense fallback={<WidgetSkeleton title="Open Purchase Orders" />}>
        <OpenPosWidget />
      </Suspense>
    ) : null,
    'low-stock': canInventory ? (
      <Suspense
        fallback={
          <WidgetSkeleton title="Low Stock Alerts" bodyClassName="h-40" />
        }
      >
        <LowStockWidget />
      </Suspense>
    ) : null,
    'unapplied-payments': canPayments ? (
      <Suspense fallback={<WidgetSkeleton title="Unapplied Payments" />}>
        <UnappliedPaymentsWidget customerSalesRepId={paymentScope} />
      </Suspense>
    ) : null,
    'recent-activity': canAudit ? (
      <Suspense
        fallback={
          <WidgetSkeleton title="Recent Activity" bodyClassName="h-40" />
        }
      >
        <RecentActivityWidget />
      </Suspense>
    ) : null,
    'cash-position': canGl ? (
      <Suspense fallback={<WidgetSkeleton title="Cash Position" />}>
        <CashPositionWidget />
      </Suspense>
    ) : null,
    'pending-reviews': actor.isSuperAdmin ? (
      <Suspense fallback={<WidgetSkeleton title="Pending Order Reviews" />}>
        <PendingOrderReviewsWidget />
      </Suspense>
    ) : null,
  };

  return (
    <DashboardGrid
      widgets={permittedWidgets}
      initialOrder={finalOrder}
      initialHidden={hiddenArr}
      defaultOrder={permittedDefaultOrder}
    >
      {finalOrder
        .filter((id) => widgetNodes[id] != null)
        .map((id) => (
          <div key={id} data-widget-id={id}>
            {widgetNodes[id]}
          </div>
        ))}
    </DashboardGrid>
  );
}
