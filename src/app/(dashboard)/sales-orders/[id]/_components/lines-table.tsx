import type { ReactNode } from 'react';
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
import { QtyShippedInput } from './qty-shipped-input';

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

export function SalesOrderLinesTable({
  lines,
  status,
  salesOrderId,
}: {
  lines: SalesOrderLineRow[];
  status: string;
  salesOrderId: string;
}) {
  if (lines.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border p-12 text-center text-sm text-muted-foreground">
        No lines on this order.
      </div>
    );
  }

  const isClosed = status === 'CLOSED';
  // CONFIRMED + DISPATCHED are the editable window for qtyShipped —
  // CONFIRMED catches pickup orders that close without ever entering
  // DISPATCHED. See updateSalesOrderLineQtyShipped for the matching
  // server-side gate.
  const isEditable = status === 'CONFIRMED' || status === 'DISPATCHED';

  return (
    <>
      {/* Mobile: one card per line, stacked. Hidden on md+ where the
          full table takes over. The card view drops horizontal
          scrolling entirely — every column wraps into the card. */}
      <div className="space-y-3 md:hidden">
        {lines.map((l) => (
          <SalesOrderLineCard
            key={l.id}
            line={l}
            isClosed={isClosed}
            isEditable={isEditable}
            salesOrderId={salesOrderId}
          />
        ))}
      </div>

      {/* Desktop: existing sticky-header scrollable table.
          overflow-hidden so the inner scroll container respects the
          outer rounded corners; max-h on Table's container creates
          the scroll context that the sticky thead resolves to.
          bg-background on the header keeps it opaque against
          scrolling rows underneath — the existing bg-muted/30 tint
          on the row layers on top. */}
      <div className="hidden overflow-hidden rounded-lg border border-border md:block">
        <Table containerClassName="max-h-[60vh] overflow-y-auto">
          <TableHeader className="sticky top-0 z-10 bg-background">
            <TableRow className="bg-muted/30 hover:bg-muted/30">
              <TableHead>SKU</TableHead>
              <TableHead>Description</TableHead>
              <TableHead className="text-right">Ordered</TableHead>
              <TableHead className="text-right">Shipped</TableHead>
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
                  {!isClosed ? (
                    <ReservationHint
                      reserved={l.qtyReserved}
                      shipped={l.qtyShipped}
                    />
                  ) : null}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  <ShippedCell
                    salesOrderId={salesOrderId}
                    lineId={l.id}
                    qtyOrdered={l.qtyOrdered}
                    qtyShipped={l.qtyShipped}
                    isEditable={isEditable}
                    isClosed={isClosed}
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
                  {formatCurrency(computeLineTotal(l, isClosed))}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </>
  );
}

// Mobile card variant — same data the desktop row shows, restacked
// vertically. The QtyShippedInput renders here too when the SO is in
// the editable window; each subtree manages its own local state, so
// edits made on the mobile card and the (hidden) desktop row stay
// independent until the next router.refresh() re-syncs from the
// server.
function SalesOrderLineCard({
  line: l,
  isClosed,
  isEditable,
  salesOrderId,
}: {
  line: SalesOrderLineRow;
  isClosed: boolean;
  isEditable: boolean;
  salesOrderId: string;
}) {
  const hasDiscount = l.discountPercent != null || l.discountAmount != null;
  return (
    <div className="space-y-3 rounded-lg border border-border bg-card p-3">
      <div>
        <div className="font-mono text-xs text-muted-foreground">{l.sku}</div>
        <div className="font-medium">{l.productName}</div>
        {l.variantName ? (
          <div className="text-xs text-muted-foreground">{l.variantName}</div>
        ) : null}
      </div>
      <div className="grid grid-cols-2 gap-3 text-sm">
        <Stat label="Ordered">
          <div className="tabular-nums">{formatQty(l.qtyOrdered)}</div>
          {!isClosed ? (
            <ReservationHint
              reserved={l.qtyReserved}
              shipped={l.qtyShipped}
            />
          ) : null}
        </Stat>
        <Stat label="Shipped">
          <ShippedCell
            salesOrderId={salesOrderId}
            lineId={l.id}
            qtyOrdered={l.qtyOrdered}
            qtyShipped={l.qtyShipped}
            isEditable={isEditable}
            isClosed={isClosed}
          />
        </Stat>
        <Stat label="Unit price">
          <div className="tabular-nums">{formatCurrency(l.unitPrice)}</div>
          <PriceRuleBadge rule={l.priceRule} />
        </Stat>
        <Stat label="Line total">
          <div className="tabular-nums font-medium">
            {formatCurrency(computeLineTotal(l, isClosed))}
          </div>
        </Stat>
      </div>
      {hasDiscount ? (
        <div className="flex items-baseline gap-2 text-sm">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Discount
          </span>
          <span className="tabular-nums">
            {formatDiscount(l.discountPercent, l.discountAmount)}
          </span>
        </div>
      ) : null}
      {l.customerNote ? (
        <div className="text-xs italic text-muted-foreground">
          “{l.customerNote}”
        </div>
      ) : null}
    </div>
  );
}

function Stat({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      {children}
    </div>
  );
}

// Qty shipped cell — switches between the inline editor (CONFIRMED /
// DISPATCHED), the closed-state read-only display (CLOSED, with a
// "short" hint when shipped < ordered), and a dash for other statuses
// where no shipment is meaningful.
function ShippedCell({
  salesOrderId,
  lineId,
  qtyOrdered,
  qtyShipped,
  isEditable,
  isClosed,
}: {
  salesOrderId: string;
  lineId: string;
  qtyOrdered: Prisma.Decimal;
  qtyShipped: Prisma.Decimal;
  isEditable: boolean;
  isClosed: boolean;
}) {
  if (isEditable) {
    return (
      <QtyShippedInput
        salesOrderId={salesOrderId}
        lineId={lineId}
        qtyOrdered={qtyOrdered.toString()}
        qtyShipped={qtyShipped.toString()}
        editable
      />
    );
  }
  if (isClosed) {
    const short = qtyShipped.lessThan(qtyOrdered);
    return (
      <>
        <div>
          <span className={short ? 'text-amber-600 dark:text-amber-500' : ''}>
            {formatQty(qtyShipped)}
          </span>
        </div>
        {short ? (
          <div className="text-[10px] uppercase tracking-wide text-amber-600 dark:text-amber-500">
            short
          </div>
        ) : null}
      </>
    );
  }
  return <span className="text-muted-foreground">—</span>;
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

function computeLineTotal(
  l: SalesOrderLineRow,
  isClosed: boolean,
): Prisma.Decimal {
  // Pre-CLOSE the line total reflects the order's commitment (qtyOrdered).
  // After CLOSE, switch to qtyShipped so the displayed total matches the
  // invoice line that was actually generated — important for short
  // shipments where ordered > shipped.
  const qty = isClosed ? l.qtyShipped : l.qtyOrdered;
  let lineTotal = qty.times(l.unitPrice);
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
