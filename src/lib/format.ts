import type { Prisma } from '@/generated/tenant';

// Display-only formatters. The non-negotiable money rule lives in
// CLAUDE.md: round to 2 decimals only at display/total level, never
// during calculation. These helpers operate on already-final values
// and exist so widgets/reports render consistently.

export function formatCurrency(
  d: Prisma.Decimal | number | null | undefined,
): string {
  if (d == null) return '—';
  // Decimal.toFixed(2) handles the half-even rounding correctly at
  // arbitrary precision; only after that do we cross into Number for
  // the locale grouping pass. Number safely represents any realistic
  // dollar total (it has ~15 digits of precision — quadrillions).
  const fixed = typeof d === 'number' ? d.toFixed(2) : d.toFixed(2);
  return (
    '$' +
    Number(fixed).toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  );
}

export function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

const STATUS_OVERRIDES: Record<string, string> = {
  PARTIALLY_RECEIVED: 'Partially received',
};

export function formatStatusLabel(status: string): string {
  if (STATUS_OVERRIDES[status]) return STATUS_OVERRIDES[status];
  return status.charAt(0) + status.slice(1).toLowerCase();
}
