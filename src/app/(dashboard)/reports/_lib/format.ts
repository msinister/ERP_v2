import type { Prisma } from '@/generated/tenant';
import { formatCurrency } from '@/lib/format';

// In standard financial-statement display, negatives are wrapped in
// parentheses instead of leading with a minus sign. Numbers stay
// right-aligned and tabular so the columns line up.
export function formatAccountingAmount(
  d: Prisma.Decimal | string | number | null | undefined,
): string {
  if (d == null) return '—';
  const isNeg =
    typeof d === 'number'
      ? d < 0
      : typeof d === 'string'
        ? d.startsWith('-')
        : d.isNegative();
  if (!isNeg) return formatCurrency(d);
  // formatCurrency emits "$-1,234.56" for negatives; swap to
  // "($1,234.56)" — the accounting convention used on TB/BS/IS.
  const raw = formatCurrency(d);
  return '(' + raw.replace('-', '') + ')';
}

// Variant for plain debit/credit cells that should print blank when
// the value is exactly zero (every TB row has exactly one non-zero
// side; printing $0.00 in the other side clutters the columns).
export function formatDrCrCell(
  d: Prisma.Decimal | string | number | null | undefined,
): string {
  if (d == null) return '';
  const isZero =
    typeof d === 'number'
      ? d === 0
      : typeof d === 'string'
        ? /^-?0+(\.0+)?$/.test(d)
        : (d as Prisma.Decimal).equals(0);
  if (isZero) return '';
  return formatCurrency(d);
}
