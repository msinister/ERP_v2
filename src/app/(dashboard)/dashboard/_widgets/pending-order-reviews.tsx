import Link from 'next/link';
import { ArrowRight, Inbox } from 'lucide-react';
import { db } from '@/lib/db';
import { pendingReviewCount } from '@/server/services/pendingOrderReviews';
import { formatCount } from '@/lib/format';
import { WidgetCard } from './widget-card';

// Single-number widget that surfaces orders parked on the pending-
// review queue. Linked to /admin/pending-orders. Super-admin gates
// the page itself, so this widget is only rendered on the dashboard
// for super-admins (see dashboard/page.tsx).

export async function PendingOrderReviewsWidget() {
  const count = await pendingReviewCount(db);
  return (
    <WidgetCard
      title="Pending Order Reviews"
      subtitle="Shopify imports stuck on customer match or unknown SKU"
    >
      <div className="flex items-end justify-between gap-3">
        <div
          className={
            count > 0
              ? 'text-3xl font-semibold tabular-nums text-destructive'
              : 'text-3xl font-semibold tabular-nums text-muted-foreground'
          }
        >
          {formatCount(count)}
        </div>
        {count > 0 ? (
          <Link
            href="/admin/pending-orders"
            className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            Review
            <ArrowRight className="size-3" />
          </Link>
        ) : (
          <Inbox className="size-5 text-muted-foreground/60" />
        )}
      </div>
      <div className="mt-3 text-xs text-muted-foreground">
        {count === 0
          ? 'Queue is clear — every Shopify order is importing cleanly.'
          : count === 1
            ? '1 order needs your attention'
            : `${count} orders need your attention`}
      </div>
    </WidgetCard>
  );
}
