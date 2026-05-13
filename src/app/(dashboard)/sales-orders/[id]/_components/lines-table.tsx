import { Prisma } from '@/generated/tenant';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { formatCurrency } from '@/lib/format';

export type SalesOrderLineRow = {
  id: string;
  sku: string;
  productName: string;
  variantName: string | null;
  warehouseCode: string;
  qtyOrdered: Prisma.Decimal;
  qtyReserved: Prisma.Decimal;
  qtyShipped: Prisma.Decimal;
  unitPrice: Prisma.Decimal;
  priceRule: string;
  discountPercent: Prisma.Decimal | null;
  discountAmount: Prisma.Decimal | null;
  customerNote: string | null;
  internalNote: string | null;
};

export function SalesOrderLinesTable({ lines }: { lines: SalesOrderLineRow[] }) {
  if (lines.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border p-12 text-center text-sm text-muted-foreground">
        No lines on this order.
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/30 hover:bg-muted/30">
            <TableHead>SKU</TableHead>
            <TableHead>Description</TableHead>
            <TableHead className="text-right">Qty</TableHead>
            <TableHead className="text-right">Unit price</TableHead>
            <TableHead className="text-right">Discount</TableHead>
            <TableHead className="text-right">Line total</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {lines.map((l) => (
            <TableRow key={l.id}>
              <TableCell className="font-mono text-xs text-muted-foreground">
                {l.sku}
              </TableCell>
              <TableCell>
                <div className="font-medium">{l.productName}</div>
                {l.variantName ? (
                  <div className="text-xs text-muted-foreground">
                    {l.variantName}
                  </div>
                ) : null}
                {l.customerNote ? (
                  <div className="mt-1 text-xs italic text-muted-foreground">
                    “{l.customerNote}”
                  </div>
                ) : null}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                <div>{formatQty(l.qtyOrdered)}</div>
                <ReservationHint
                  reserved={l.qtyReserved}
                  shipped={l.qtyShipped}
                />
              </TableCell>
              <TableCell className="text-right tabular-nums">
                <div>{formatCurrency(l.unitPrice)}</div>
                <PriceRuleBadge rule={l.priceRule} />
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatDiscount(l.discountPercent, l.discountAmount)}
              </TableCell>
              <TableCell className="text-right tabular-nums font-medium">
                {formatCurrency(computeLineTotal(l))}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function formatQty(qty: Prisma.Decimal): string {
  // Strip trailing zeros for clean display (5.00000 → "5", 1.50000 → "1.5").
  const s = qty.toString();
  if (!s.includes('.')) return s;
  return s.replace(/\.?0+$/, '');
}

function formatDiscount(
  pct: Prisma.Decimal | null,
  amt: Prisma.Decimal | null,
): string {
  if (amt != null) return `−${formatCurrency(amt)}`;
  if (pct != null) {
    const n = Number(pct.toString());
    return `−${n}%`;
  }
  return '—';
}

function computeLineTotal(l: SalesOrderLineRow): Prisma.Decimal {
  let lineTotal = l.qtyOrdered.times(l.unitPrice);
  if (l.discountAmount != null) {
    lineTotal = lineTotal.minus(l.discountAmount);
  } else if (l.discountPercent != null) {
    lineTotal = lineTotal.minus(
      lineTotal.times(l.discountPercent).dividedBy(100),
    );
  }
  if (lineTotal.lessThan(0)) lineTotal = new Prisma.Decimal(0);
  return lineTotal;
}

function ReservationHint({
  reserved,
  shipped,
}: {
  reserved: Prisma.Decimal;
  shipped: Prisma.Decimal;
}) {
  if (shipped.greaterThan(0)) {
    return (
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
        shipped {formatQty(shipped)}
      </div>
    );
  }
  if (reserved.greaterThan(0)) {
    return (
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
        reserved {formatQty(reserved)}
      </div>
    );
  }
  return null;
}

function PriceRuleBadge({ rule }: { rule: string }) {
  // Hide the "BASE_PRICE" tag — it's the unremarkable default and
  // clutters the column. Other rules are interesting and worth flagging.
  if (rule === 'BASE_PRICE') return null;
  const label = priceRuleLabel(rule);
  const tone =
    rule === 'MANUAL_OVERRIDE' ? 'outline' : ('secondary' as const);
  return (
    <Badge variant={tone} className="mt-0.5 text-[10px]">
      {label}
    </Badge>
  );
}

function priceRuleLabel(rule: string): string {
  switch (rule) {
    case 'MANUAL_OVERRIDE':
      return 'manual';
    case 'CUSTOMER_SPECIFIC':
      return 'customer price';
    case 'TIER_DISCOUNT':
      return 'tier';
    case 'QTY_BREAK':
      return 'qty break';
    case 'PROMO':
      return 'promo';
    case 'COST_PLUS':
      return 'cost+';
    default:
      return rule.toLowerCase();
  }
}
