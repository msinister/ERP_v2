'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatCount } from '@/lib/format';

// Compact prev/next pager for the entity ledgers. URL-driven via a
// namespaced skip param (default 'ledgerSkip') so it coexists with other
// tabs' pagination on the same detail page. Preserves all other params.
export function LedgerPager({
  basePath,
  total,
  skip,
  take,
  param = 'ledgerSkip',
}: {
  basePath: string;
  total: number;
  skip: number;
  take: number;
  param?: string;
}) {
  const router = useRouter();
  const params = useSearchParams();

  const pageCount = Math.max(1, Math.ceil(total / take));
  const currentPage = Math.min(pageCount, Math.floor(skip / take) + 1);
  const fromRow = total === 0 ? 0 : skip + 1;
  const toRow = Math.min(total, skip + take);

  function goToPage(page: number) {
    const next = new URLSearchParams(params.toString());
    const newSkip = (page - 1) * take;
    if (newSkip <= 0) next.delete(param);
    else next.set(param, String(newSkip));
    router.push(`${basePath}?${next.toString()}`);
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="text-sm text-muted-foreground">
        {total === 0
          ? 'No transactions'
          : fromRow === toRow
            ? `${formatCount(fromRow)} of ${formatCount(total)}`
            : `${formatCount(fromRow)}–${formatCount(toRow)} of ${formatCount(total)}`}
      </div>
      {pageCount > 1 ? (
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
          <span className="px-2 text-sm tabular-nums text-muted-foreground">
            {currentPage} / {pageCount}
          </span>
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
      ) : null}
    </div>
  );
}
