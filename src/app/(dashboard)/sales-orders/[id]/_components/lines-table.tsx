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
import { ProductThumbnail } from '@/components/shared/product-thumbnail';
import { ProductImageToggle } from '@/components/shared/product-image-toggle';
import { StockContextToggle } from '@/components/shared/stock-context-toggle';
import { QtyShippedInput } from './qty-shipped-input';
import { RemoveLineButton } from './remove-line-button';
import { RemoveBundleButton } from './remove-bundle-button';
import {
  EditableDiscountCell,
  EditableNotesBlock,
  EditableQtyCell,
  EditableUnitPriceCell,
} from './editable-line-cells';

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
  imageUrl: string | null;
  bundleGroupId: string | null;
  bundleSourceSku: string | null;
  bundleSourceName: string | null;
  // Internal-only stock + cost reference for staff. Null when no
  // InventoryItem row exists for the (variant, warehouse) pair —
  // typically a variant that has never had a movement. Hidden on
  // customer-facing documents regardless of value.
  onHand: Prisma.Decimal | null;
  available: Prisma.Decimal | null;
  wac: Prisma.Decimal | null;
  lastCost: Prisma.Decimal | null;
};

export function SalesOrderLinesTable({
  lines,
  status,
  salesOrderId,
  overShippingPolicy,
}: {
  lines: SalesOrderLineRow[];
  status: string;
  salesOrderId: string;
  overShippingPolicy: 'ALLOW' | 'CONFIRM' | 'BLOCK';
}) {
  if (lines.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border p-12 text-center text-sm text-muted-foreground">
        No lines on this order.
      </div>
    );
  }

  const isClosed = status === 'CLOSED';
  // Bundle group rollup — total, line count, and a representative
  // line id (the first component) used by the header row's remove
  // button. The header itself isn't a real SalesOrderLine, so
  // "remove bundle" targets any component line with ?bundle=true and
  // the service expands to the whole group via bundleGroupId.
  type GroupMeta = {
    total: Prisma.Decimal;
    lineCount: number;
    representativeLineId: string;
  };
  const groupMeta = new Map<string, GroupMeta>();
  for (const l of lines) {
    if (l.bundleGroupId == null) continue;
    const lt = computeLineTotal(l, isClosed);
    const prev = groupMeta.get(l.bundleGroupId);
    if (prev) {
      prev.total = prev.total.plus(lt);
      prev.lineCount += 1;
    } else {
      groupMeta.set(l.bundleGroupId, {
        total: lt,
        lineCount: 1,
        representativeLineId: l.id,
      });
    }
  }
  // displayItems interleaves bundle header rows with regular line
  // items, in the original order. Walks lines once; emits a header
  // each time the bundleGroupId changes to a non-null value.
  type DisplayItem =
    | {
        kind: 'header';
        groupId: string;
        bundleSku: string | null;
        bundleName: string | null;
        total: Prisma.Decimal;
        lineCount: number;
        representativeLineId: string;
      }
    | { kind: 'line'; line: SalesOrderLineRow };
  const displayItems: DisplayItem[] = [];
  let lastGroupId: string | null = null;
  for (const l of lines) {
    if (l.bundleGroupId != null && l.bundleGroupId !== lastGroupId) {
      const meta = groupMeta.get(l.bundleGroupId)!;
      displayItems.push({
        kind: 'header',
        groupId: l.bundleGroupId,
        bundleSku: l.bundleSourceSku,
        bundleName: l.bundleSourceName,
        total: meta.total,
        lineCount: meta.lineCount,
        representativeLineId: meta.representativeLineId,
      });
    }
    lastGroupId = l.bundleGroupId;
    displayItems.push({ kind: 'line', line: l });
  }
  // CONFIRMED + DISPATCHED are the editable window for qtyShipped —
  // CONFIRMED catches pickup orders that close without ever entering
  // DISPATCHED. See updateSalesOrderLineQtyShipped for the matching
  // server-side gate.
  const isEditable = status === 'CONFIRMED' || status === 'DISPATCHED';
  // DRAFT + CONFIRMED are the editable window for the inline field
  // edits (qty / price / discount / notes). After dispatch the line
  // is locked at the field level — only qtyShipped stays editable
  // until close. See updateSalesOrderLineFields for the matching
  // server-side gate.
  const fieldsEditable = status === 'DRAFT' || status === 'CONFIRMED';

  return (
    <div className="space-y-3">
      {/* Toggles sit above both views — each toggles a global class
          on <html> via its hook, which the matching cells below
          respond to. One pair of toggles for both desktop + mobile
          (same global state). Stock info is staff-only context. */}
      <div className="flex justify-end gap-2">
        <StockContextToggle />
        <ProductImageToggle />
      </div>

      {/* Mobile: one card per line, stacked. Hidden on md+ where the
          full table takes over. Bundle header cards interleave above
          their component groups. */}
      <div className="space-y-3 md:hidden">
        {displayItems.map((item, idx) => {
          if (item.kind === 'header') {
            return (
              <BundleHeaderCard
                key={`h-${item.groupId}-${idx}`}
                bundleSku={item.bundleSku}
                bundleName={item.bundleName}
                total={item.total}
                salesOrderId={salesOrderId}
                representativeLineId={item.representativeLineId}
                lineCount={item.lineCount}
                fieldsEditable={fieldsEditable}
              />
            );
          }
          return (
            <SalesOrderLineCard
              key={item.line.id}
              line={item.line}
              isClosed={isClosed}
              isEditable={isEditable}
              fieldsEditable={fieldsEditable}
              salesOrderId={salesOrderId}
              overShippingPolicy={overShippingPolicy}
            />
          );
        })}
      </div>

      {/* Desktop: sticky-header scrollable table. */}
      <div className="hidden overflow-hidden rounded-lg border border-border md:block">
        <Table containerClassName="max-h-[60vh] overflow-y-auto">
          <TableHeader className="sticky top-0 z-10 bg-background">
            <TableRow className="bg-muted/30 hover:bg-muted/30">
              {/* Image column hides when the global toggle is off. The
                  arbitrary variant matches when any ancestor element
                  carries the .hide-product-images class (set on <html>
                  by the toggle hook + the no-flicker layout script). */}
              <TableHead className="w-[60px] [.hide-product-images_&]:hidden">
                <span className="sr-only">Image</span>
              </TableHead>
              <TableHead>SKU</TableHead>
              <TableHead>Description</TableHead>
              <TableHead className="text-right">Ordered</TableHead>
              <TableHead className="text-right">Shipped</TableHead>
              <TableHead className="text-right">Unit price</TableHead>
              <TableHead className="text-right">Discount</TableHead>
              <TableHead className="text-right">Line total</TableHead>
              {/* Actions column — narrow; hosts the hover-only remove
                  button on DRAFT / CONFIRMED orders. Header label is
                  visually hidden to keep the column unobtrusive. */}
              <TableHead className="w-[40px]">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {displayItems.map((item, idx) => {
              if (item.kind === 'header') {
                return (
                  <BundleHeaderRow
                    key={`h-${item.groupId}-${idx}`}
                    bundleSku={item.bundleSku}
                    bundleName={item.bundleName}
                    total={item.total}
                    salesOrderId={salesOrderId}
                    representativeLineId={item.representativeLineId}
                    lineCount={item.lineCount}
                    fieldsEditable={fieldsEditable}
                  />
                );
              }
              const l = item.line;
              const inBundle = l.bundleGroupId != null;
              return (
                // `group` lets the per-row hover affordances
                // (Add note pills, Remove button) reveal via
                // group-hover. Removed from BundleHeaderRow.
                <TableRow key={l.id} className="group">
                  <TableCell className="[.hide-product-images_&]:hidden">
                    <ProductThumbnail
                      src={l.imageUrl}
                      productName={l.productName}
                    />
                  </TableCell>
                  <TableCell
                    className={
                      'font-mono text-sm font-semibold ' +
                      (inBundle ? 'pl-6' : '')
                    }
                  >
                    {l.sku}
                  </TableCell>
                  <TableCell>
                    <div className="text-sm text-muted-foreground">
                      {l.productName}
                    </div>
                    {l.variantName ? (
                      <div className="text-xs text-muted-foreground">
                        {l.variantName}
                      </div>
                    ) : null}
                    <StockAndCostBlock line={l} />
                    <EditableNotesBlock
                      salesOrderId={salesOrderId}
                      lineId={l.id}
                      customerNote={l.customerNote}
                      internalNote={l.internalNote}
                      editable={fieldsEditable}
                    />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    <EditableQtyCell
                      salesOrderId={salesOrderId}
                      lineId={l.id}
                      qtyOrdered={l.qtyOrdered.toString()}
                      editable={fieldsEditable}
                    />
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
                      overShippingPolicy={overShippingPolicy}
                    />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    <EditableUnitPriceCell
                      salesOrderId={salesOrderId}
                      lineId={l.id}
                      unitPrice={l.unitPrice.toString()}
                      editable={fieldsEditable}
                    />
                    <PriceRuleBadge rule={l.priceRule} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    <EditableDiscountCell
                      salesOrderId={salesOrderId}
                      lineId={l.id}
                      discountPercent={l.discountPercent?.toString() ?? null}
                      discountAmount={l.discountAmount?.toString() ?? null}
                      editable={fieldsEditable}
                    />
                  </TableCell>
                  <TableCell className="text-right tabular-nums font-medium">
                    {formatCurrency(computeLineTotal(l, isClosed))}
                  </TableCell>
                  <TableCell className="text-right">
                    {fieldsEditable ? (
                      <RemoveLineButton
                        salesOrderId={salesOrderId}
                        lineId={l.id}
                        sku={l.sku}
                        qty={formatQty(l.qtyOrdered)}
                        bundleSku={l.bundleSourceSku}
                      />
                    ) : null}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
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
  fieldsEditable,
  salesOrderId,
  overShippingPolicy,
}: {
  line: SalesOrderLineRow;
  isClosed: boolean;
  isEditable: boolean;
  fieldsEditable: boolean;
  salesOrderId: string;
  overShippingPolicy: 'ALLOW' | 'CONFIRM' | 'BLOCK';
}) {
  const hasDiscount = l.discountPercent != null || l.discountAmount != null;
  return (
    // `group` parallels the desktop TableRow — Add note affordances
    // inside reveal on hover. On touch devices hover is unreliable,
    // so the Remove button uses its inline-card variant (always
    // visible) instead of the hover variant.
    <div className="group space-y-3 rounded-lg border border-border bg-card p-3">
      <div className="flex items-start gap-3">
        {/* Thumbnail at top-left, hides with the global toggle. */}
        <div className="[.hide-product-images_&]:hidden">
          <ProductThumbnail src={l.imageUrl} productName={l.productName} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-mono text-sm font-semibold">{l.sku}</div>
          <div className="text-sm text-muted-foreground">{l.productName}</div>
          {l.variantName ? (
            <div className="text-xs text-muted-foreground">{l.variantName}</div>
          ) : null}
          <StockAndCostBlock line={l} />
        </div>
        {fieldsEditable ? (
          <RemoveLineButton
            salesOrderId={salesOrderId}
            lineId={l.id}
            sku={l.sku}
            qty={formatQty(l.qtyOrdered)}
            bundleSku={l.bundleSourceSku}
            variant="inline-card"
          />
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
            overShippingPolicy={overShippingPolicy}
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
      <EditableNotesBlock
        salesOrderId={salesOrderId}
        lineId={l.id}
        customerNote={l.customerNote}
        internalNote={l.internalNote}
        editable={fieldsEditable}
      />
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
  overShippingPolicy,
}: {
  salesOrderId: string;
  lineId: string;
  qtyOrdered: Prisma.Decimal;
  qtyShipped: Prisma.Decimal;
  isEditable: boolean;
  isClosed: boolean;
  overShippingPolicy: 'ALLOW' | 'CONFIRM' | 'BLOCK';
}) {
  if (isEditable) {
    return (
      <QtyShippedInput
        salesOrderId={salesOrderId}
        lineId={lineId}
        qtyOrdered={qtyOrdered.toString()}
        qtyShipped={qtyShipped.toString()}
        editable
        overShippingPolicy={overShippingPolicy}
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

// Internal-only stock + cost reference for a line. Wrapped in the
// `.hide-stock-context` gate so the operator can collapse it via the
// Stock-info toggle. Never rendered on customer-facing documents —
// the lines table lives on the SO detail page only, and invoice /
// packing-slip templates don't import it.
//
// onHand + available come from the InventoryItem row for the line's
// (variant, warehouse); null when the row doesn't exist (variant has
// never had a movement at this warehouse). WAC + last cost come from
// the FifoLayer ledger via lib/server/services/wac.
function StockAndCostBlock({ line: l }: { line: SalesOrderLineRow }) {
  const hasStock = l.onHand != null || l.available != null;
  const hasCost = l.wac != null || l.lastCost != null;
  if (!hasStock && !hasCost) return null;
  return (
    <div className="mt-1 space-y-0.5 text-xs text-muted-foreground [.hide-stock-context_&]:hidden">
      {hasStock ? (
        <div className="tabular-nums">
          <span>QOH: </span>
          <span>{l.onHand != null ? formatQty(l.onHand) : '—'}</span>
          <span className="mx-2 text-muted-foreground/60">·</span>
          <span>Available: </span>
          <span className={availableTone(l.available)}>
            {l.available != null ? formatQty(l.available) : '—'}
          </span>
        </div>
      ) : null}
      {hasCost ? (
        <div className="tabular-nums">
          <span>WAC: </span>
          <span>{l.wac != null ? formatCurrency(l.wac) : '—'}</span>
          <span className="mx-2 text-muted-foreground/60">·</span>
          <span>Last: </span>
          <span>{l.lastCost != null ? formatCurrency(l.lastCost) : '—'}</span>
        </div>
      ) : null}
    </div>
  );
}

function availableTone(available: Prisma.Decimal | null): string {
  if (available == null) return '';
  if (available.lessThan(0)) {
    return 'font-medium text-red-600 dark:text-red-500';
  }
  if (available.equals(0)) {
    return 'font-medium text-amber-600 dark:text-amber-500';
  }
  return '';
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
    case 'BUNDLE_ALLOCATED':
      return 'bundle';
    default:
      return rule.toLowerCase();
  }
}

// Synthetic row rendered above each bundle's component lines on the
// desktop table. Sum of children's line totals = the bundle's effective
// price (manual override or basePrice × bundleQty when the explode ran).
function BundleHeaderRow({
  bundleSku,
  bundleName,
  total,
  salesOrderId,
  representativeLineId,
  lineCount,
  fieldsEditable,
}: {
  bundleSku: string | null;
  bundleName: string | null;
  total: Prisma.Decimal;
  salesOrderId: string;
  representativeLineId: string;
  lineCount: number;
  fieldsEditable: boolean;
}) {
  return (
    // `group` enables the hover-only reveal on the bundle-remove
    // button in the actions cell, matching the per-line rows.
    <TableRow className="group bg-amber-50/50 hover:bg-amber-50/70 dark:bg-amber-950/20 dark:hover:bg-amber-950/30">
      <TableCell className="[.hide-product-images_&]:hidden" />
      <TableCell className="font-mono text-xs font-medium">
        <span className="rounded bg-amber-200/60 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-amber-900 dark:bg-amber-800/40 dark:text-amber-200">
          Bundle
        </span>{' '}
        {bundleSku ?? '—'}
      </TableCell>
      <TableCell className="font-medium">{bundleName ?? '—'}</TableCell>
      <TableCell />
      <TableCell />
      <TableCell />
      <TableCell />
      <TableCell className="text-right tabular-nums font-semibold">
        {formatCurrency(total)}
      </TableCell>
      <TableCell className="text-right">
        {fieldsEditable ? (
          <RemoveBundleButton
            salesOrderId={salesOrderId}
            representativeLineId={representativeLineId}
            bundleSku={bundleSku}
            lineCount={lineCount}
          />
        ) : null}
      </TableCell>
    </TableRow>
  );
}

// Mobile companion — appears above the component cards for each
// bundle group on viewports < md.
function BundleHeaderCard({
  bundleSku,
  bundleName,
  total,
  salesOrderId,
  representativeLineId,
  lineCount,
  fieldsEditable,
}: {
  bundleSku: string | null;
  bundleName: string | null;
  total: Prisma.Decimal;
  salesOrderId: string;
  representativeLineId: string;
  lineCount: number;
  fieldsEditable: boolean;
}) {
  return (
    <div className="rounded-lg border border-amber-300/60 bg-amber-50/50 p-3 dark:border-amber-700/40 dark:bg-amber-950/20">
      <div className="flex items-center justify-between gap-3">
        <div className="space-y-0.5">
          <span className="rounded bg-amber-200/60 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-amber-900 dark:bg-amber-800/40 dark:text-amber-200">
            Bundle
          </span>
          <div className="font-mono text-xs">{bundleSku ?? '—'}</div>
          <div className="text-sm font-medium">{bundleName ?? '—'}</div>
        </div>
        <div className="flex items-center gap-2">
          <div className="tabular-nums font-semibold">
            {formatCurrency(total)}
          </div>
          {fieldsEditable ? (
            <RemoveBundleButton
              salesOrderId={salesOrderId}
              representativeLineId={representativeLineId}
              bundleSku={bundleSku}
              lineCount={lineCount}
              variant="inline-card"
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
