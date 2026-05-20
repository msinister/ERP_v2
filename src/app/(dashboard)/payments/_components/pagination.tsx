'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { formatCount } from '@/lib/format';

const MAX_PAGE_BUTTONS = 7;

export function PaymentsPagination({
  total,
  skip,
  take,
}: {
  total: number;
  skip: number;
  take: number;
}) {
  const router = useRouter();
  const params = useSearchParams();

  if (total <= take && skip === 0) {
    return (
      <div className="flex items-center justify-end text-sm text-muted-foreground">
        {countLabel(total, total > 0 ? 1 : 0, total)}
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
    if (newSkip === 0) next.delete('skip');
    else next.set('skip', String(newSkip));
    router.push(`/payments?${next.toString()}`);
  }

  const pageNumbers = computePageWindow(currentPage, pageCount);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="text-sm text-muted-foreground">
        {countLabel(fromRow, toRow, total)}
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

function countLabel(from: number, to: number, total: number): string {
  if (total === 0) return 'No payments';
  if (from === to) return `${formatCount(from)} of ${formatCount(total)}`;
  return `${formatCount(from)}–${formatCount(to)} of ${formatCount(total)}`;
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
