import { formatCurrency } from '@/lib/format';

export type TotalsRow = {
  label: string;
  // String (Decimal-as-string), number, or already-formatted text. We
  // let pages format Decimals at the boundary so this component stays
  // print-friendly without dragging Prisma.Decimal into a leaf.
  value: string | number;
  tone?: 'default' | 'muted' | 'emphasis';
};

// Right-aligned totals stack on every document. Pages compose their
// own row list — sales orders show shipping/handling/discount, invoices
// add payments + credits + balance, POs are simpler (lines + grand
// total). Keeps the visual rhythm consistent across docs.

export function TotalsFooter({
  rows,
  prefixCurrency = true,
}: {
  rows: TotalsRow[];
  prefixCurrency?: boolean;
}) {
  return (
    <div className="flex justify-end">
      <dl className="w-full max-w-[280px] space-y-1.5 text-sm">
        {rows.map((row, idx) => (
          <Row
            key={`${row.label}-${idx}`}
            row={row}
            prefixCurrency={prefixCurrency}
          />
        ))}
      </dl>
    </div>
  );
}

function Row({
  row,
  prefixCurrency,
}: {
  row: TotalsRow;
  prefixCurrency: boolean;
}) {
  const formatted =
    typeof row.value === 'number'
      ? prefixCurrency
        ? formatCurrency(row.value)
        : String(row.value)
      : prefixCurrency &&
          /^-?\d+(\.\d+)?$/.test(row.value)
        ? formatCurrency(row.value)
        : row.value;
  const tone = row.tone ?? 'default';
  return (
    <div
      className={
        'flex items-center justify-between gap-3 ' +
        (tone === 'emphasis'
          ? 'border-t border-border pt-2 font-semibold'
          : '')
      }
    >
      <dt
        className={
          tone === 'muted'
            ? 'text-muted-foreground'
            : tone === 'emphasis'
              ? 'text-base'
              : ''
        }
      >
        {row.label}
      </dt>
      <dd
        className={
          tone === 'emphasis'
            ? 'text-base tabular-nums'
            : tone === 'muted'
              ? 'tabular-nums text-muted-foreground'
              : 'tabular-nums'
        }
      >
        {formatted}
      </dd>
    </div>
  );
}
