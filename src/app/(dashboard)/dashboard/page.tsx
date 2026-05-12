import { Suspense } from 'react';
import { OpenSosWidget } from './_widgets/open-sos';
import { OpenPosWidget } from './_widgets/open-pos';
import { TodaysSalesWidget } from './_widgets/todays-sales';
import { CashPositionWidget } from './_widgets/cash-position';
import { ArAgingWidget } from './_widgets/ar-aging';
import { ApAgingWidget } from './_widgets/ap-aging';
import { WidgetSkeleton } from './_widgets/widget-card';

// Dashboard always reflects live data (no caching) — operational
// counters drive ops decisions and stale numbers are worse than
// none. revalidate = 0 forces re-fetch on every request.
export const revalidate = 0;

export default function DashboardPage() {
  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground">
          Live snapshot of operations.
        </p>
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        <Suspense fallback={<WidgetSkeleton title="Open Sales Orders" />}>
          <OpenSosWidget />
        </Suspense>
        <Suspense fallback={<WidgetSkeleton title="Open Purchase Orders" />}>
          <OpenPosWidget />
        </Suspense>
        <Suspense fallback={<WidgetSkeleton title="Today's Sales" />}>
          <TodaysSalesWidget />
        </Suspense>
        <Suspense fallback={<WidgetSkeleton title="Cash Position" />}>
          <CashPositionWidget />
        </Suspense>
        <Suspense
          fallback={<WidgetSkeleton title="AR Aging" bodyClassName="h-20" />}
        >
          <ArAgingWidget />
        </Suspense>
        <Suspense
          fallback={<WidgetSkeleton title="AP Aging" bodyClassName="h-20" />}
        >
          <ApAgingWidget />
        </Suspense>
      </div>
    </div>
  );
}
