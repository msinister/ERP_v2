import Link from 'next/link';
import { ChevronLeft, Inbox } from 'lucide-react';
import { db } from '@/lib/db';
import { requirePagePermission } from '@/lib/permissions/requirePagePermission';
import {
  getReviewWithEnrichment,
  listPendingReviews,
} from '@/server/services/pendingOrderReviews';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { ReviewCard } from './_components/review-card';
import { StatusTabs } from './_components/status-tabs';

export const revalidate = 0;

const STATUS_VALUES = [
  'PENDING',
  'RESOLVED_EXISTING',
  'RESOLVED_NEW',
  'DISMISSED',
] as const;
type Status = (typeof STATUS_VALUES)[number];

function isStatus(v: string | undefined): v is Status {
  return v != null && (STATUS_VALUES as readonly string[]).includes(v);
}

export default async function PendingOrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  // Pending order reviews are a sales-orders workflow surface even
  // though they live under /admin — gate on view_all OR view_own so
  // any sales rep with order visibility can triage.
  await requirePagePermission(['sales_orders.view_all', 'sales_orders.view_own']);

  const sp = await searchParams;
  const status: Status = isStatus(sp.status) ? sp.status : 'PENDING';

  const summary = await listPendingReviews(db, { status, limit: 100 });

  // For PENDING + RESOLVED rows we fetch the per-row enrichment in
  // parallel — pilot volume keeps this cheap (one count + a couple of
  // aggregates per matched customer). DISMISSED rows skip enrichment.
  const enriched = await Promise.all(
    summary.map(async (row) => {
      if (status === 'DISMISSED') {
        return { ...row, matchedCustomerEnrichment: null };
      }
      const full = await getReviewWithEnrichment(db, row.id);
      return full ?? { ...row, matchedCustomerEnrichment: null };
    }),
  );

  const counts = await db.pendingOrderReview.groupBy({
    by: ['status'],
    _count: { _all: true },
  });
  const countsByStatus = Object.fromEntries(
    counts.map((c) => [c.status, c._count._all]),
  ) as Partial<Record<Status, number>>;

  return (
    <div className="space-y-6">
      <Link
        href="/admin"
        className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-3.5" />
        Admin
      </Link>

      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">
          Pending order reviews
        </h1>
        <p className="text-sm text-muted-foreground">
          Shopify orders that couldn&apos;t be imported automatically —
          most often because a customer match is ambiguous, or a
          line_item.sku isn&apos;t in the ERP. Resolve each one to import
          the order.
        </p>
      </div>

      <StatusTabs current={status} counts={countsByStatus} />

      {enriched.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-12 text-sm text-muted-foreground">
            <Inbox className="size-8 text-muted-foreground/60" />
            <div>No {status.toLowerCase()} reviews.</div>
            {status === 'PENDING' ? (
              <div className="text-xs">
                Shopify order imports auto-park here when something is
                ambiguous. Empty queue is a good sign.
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          {enriched.map((row) => (
            <ReviewCard
              key={row.id}
              review={row}
              readOnly={status !== 'PENDING'}
            />
          ))}
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Showing up to 100 most-recent rows. Use{' '}
        <Badge variant="outline">/admin/audit-log</Badge> to find older
        resolved reviews.
      </p>
    </div>
  );
}
