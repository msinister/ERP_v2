'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { formatCount } from '@/lib/format';

// Per-section URL-driven pagination. Same shape as the customer-list
// CustomersPagination component, but parameterized on the param
// name so multiple paginated sections can coexist on one page
// (Payment history uses `payHistorySkip`, Paid invoices uses
// `paidInvSkip`). All other params are preserved verbatim — so
// the tab state, other section's pagination, etc. stay intact when
// the operator pages through.
//
// The host (server) component computes total + slice and passes
// them in. Hidden when total ≤ take so we don't render a "1 of 1"
// row unnecessarily.

const MAX_PAGE_BUTTONS = 7;

export function SectionPagination({
  total,
  skip,
  take,
  basePath,
  paramName,
  itemLabel = 'rows',
}: {
  total: number;
  skip: number;
  take: number;
  /** Full base path of the host page, e.g. /customers/abc123. */
  basePath: string;
  /** Search param this pager owns, e.g. "payHistorySkip". */
  paramName: string;
  /** Singular/plural-agnostic label used in the count cell —
   * "payments", "invoices", etc. */
  itemLabel?: string;
}) {
  const router = useRouter();
  const params = useSearchParams();

  if (total <= take && skip === 0) {
    return (
      <div className="flex items-center justify-end text-xs text-muted-foreground">
        {countLabel(total, total > 0 ? 1 : 0, total, itemLabel)}
      </div>
    );
  }

  const pageCount = Math.max(1, Math.ceil(total / take));
  const currentPage = Math.min(pageCount, Math.floor(skip / take) + 1);
  const fromRow = total === 0 ? 0 : skip + 1;
  const toRow = Math.min(total, skip + take);

  function goToPage(page: number) {
    const next = new URLSearchParams(params.toString());
    const newSkip = (page - 1) * take;
    if (newSkip === 0) next.delete(paramName);
    else next.set(paramName, String(newSkip));
    // Force the AR tab to stay active when the user pages, since
    // the parent Tabs component uses defaultValue (not URL-driven
    // tab state). The `tab=ar` param is harmless when not present.
    if (!next.has('tab')) next.set('tab', 'ar');
    router.push(`${basePath}?${next.toString()}`);
  }

  const pageNumbers = computePageWindow(currentPage, pageCount);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="text-xs text-muted-foreground">
        {countLabel(fromRow, toRow, total, itemLabel)}
      </div>
      <div className="flex items-center gap-1">
        <Button
          variant="outline"
          size="icon-sm"
          aria-label="Previous page"
          disabled={currentPage === 1}
          onClick={() => goToPage(currentPage - 1)}
        >
          <ChevronLeft />
        </Button>
        {pageNumbers.map((p, idx) =>
          p === 'ellipsis' ? (
            <span
              key={`ellipsis-${idx}`}
              className="px-1 text-sm text-muted-foreground"
            >
              …
            </span>
          ) : (
            <Button
              key={p}
              variant={p === currentPage ? 'default' : 'outline'}
              size="sm"
              className={cn(
                'min-w-8 px-2 tabular-nums',
                p === currentPage && 'pointer-events-none',
              )}
              onClick={() => goToPage(p)}
              aria-current={p === currentPage ? 'page' : undefined}
            >
              {p}
            </Button>
          ),
        )}
        <Button
          variant="outline"
          size="icon-sm"
          aria-label="Next page"
          disabled={currentPage === pageCount}
          onClick={() => goToPage(currentPage + 1)}
        >
          <ChevronRight />
        </Button>
      </div>
    </div>
  );
}

function countLabel(
  from: number,
  to: number,
  total: number,
  itemLabel: string,
): string {
  if (total === 0) return `No ${itemLabel}`;
  if (from === to)
    return `${formatCount(from)} of ${formatCount(total)} ${itemLabel}`;
  return `${formatCount(from)}–${formatCount(to)} of ${formatCount(total)} ${itemLabel}`;
}

function computePageWindow(
  currentPage: number,
  pageCount: number,
): Array<number | 'ellipsis'> {
  if (pageCount <= MAX_PAGE_BUTTONS) {
    return Array.from({ length: pageCount }, (_, i) => i + 1);
  }
  const result: Array<number | 'ellipsis'> = [];
  const window = 1;
  const showLeftEllipsis = currentPage - window > 2;
  const showRightEllipsis = currentPage + window < pageCount - 1;

  result.push(1);
  if (showLeftEllipsis) result.push('ellipsis');

  const start = Math.max(2, currentPage - window);
  const end = Math.min(pageCount - 1, currentPage + window);
  for (let p = start; p <= end; p++) result.push(p);

  if (showRightEllipsis) result.push('ellipsis');
  result.push(pageCount);
  return result;
}
