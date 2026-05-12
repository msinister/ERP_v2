import type { Prisma } from '@/generated/tenant';
import { formatCurrency } from '@/lib/format';

// Shared 5-bucket aging strip used by both the AR and AP widgets.
// Renders Current / 1-30 / 31-60 / 61-90 / 91+ as a row of small
// labelled cells; 91+ gets a destructive tint to draw the eye.

export type AgingBuckets = {
  current: Prisma.Decimal;
  b1to30: Prisma.Decimal;
  b31to60: Prisma.Decimal;
  b61to90: Prisma.Decimal;
  b91plus: Prisma.Decimal;
};

const BUCKETS: Array<{ key: keyof AgingBuckets; label: string; danger?: boolean }> = [
  { key: 'current', label: 'Current' },
  { key: 'b1to30', label: '1–30' },
  { key: 'b31to60', label: '31–60' },
  { key: 'b61to90', label: '61–90' },
  { key: 'b91plus', label: '91+', danger: true },
];

export function AgingStrip({ buckets }: { buckets: AgingBuckets }) {
  return (
    <div className="mt-3 grid grid-cols-5 gap-1">
      {BUCKETS.map((b) => {
        const value = buckets[b.key];
        return (
          <div
            key={b.key}
            className={
              'rounded-md border border-border px-1.5 py-1.5 text-center ' +
              (b.danger ? 'border-destructive/30 bg-destructive/5' : '')
            }
          >
            <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              {b.label}
            </div>
            <div
              className={
                'mt-0.5 truncate text-xs tabular-nums ' +
                (b.danger ? 'text-destructive' : 'text-foreground')
              }
              title={formatCurrency(value)}
            >
              {formatCurrency(value)}
            </div>
          </div>
        );
      })}
    </div>
  );
}
