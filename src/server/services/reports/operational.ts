import {
  InvoiceStatus,
  Prisma,
} from '@/generated/tenant';
import type { PrismaClient } from '@/generated/tenant';

// =============================================================================
// Operational reports — slice E of phase 9.
//   - salesByCustomer({ from, to })
//   - salesByItem({ from, to })
//   - inventoryValuation({ warehouseId? })
//   - cashPosition()
//
// Pilot scope subset of docs/08:225-272's full operational report list.
// Spec deferrals: top-by-product/brand/vendor, profit-margin reports,
// AOV/CLV, inventory aging/dead-stock, purchasing reports — these can
// be added as the operator's reporting needs surface in production.
//
// Date semantics for sales reports: invoiceDate (the business event
// date), half-open [from, to). Excludes VOIDED and soft-deleted
// invoices — these aren't real sales.
//
// inventoryValuation does NOT support asOf in pilot — FifoLayer rows
// don't preserve a historical snapshot of qtyRemaining at past dates,
// so accurate historical valuation would require event-replay across
// movements. Returns current state.
// =============================================================================

const ZERO = new Prisma.Decimal(0);

// ---------------------------------------------------------------------------
// salesByCustomer
// ---------------------------------------------------------------------------

export type SalesByCustomerFilters = {
  from?: Date;
  to: Date;
};

export type SalesByCustomerRow = {
  customerId: string;
  customerCode: string;
  customerName: string;
  invoiceCount: number;
  grossSales: Prisma.Decimal;
};

export type SalesByCustomerReport = {
  asOfFrom: Date | null;
  asOfTo: Date;
  rows: SalesByCustomerRow[];
  totalGrossSales: Prisma.Decimal;
  totalInvoices: number;
};

/**
 * Per-customer revenue + invoice count for invoices with invoiceDate
 * in [from, to). Excludes VOIDED + soft-deleted. Sorted by grossSales DESC.
 */
export async function salesByCustomer(
  db: PrismaClient,
  filters: SalesByCustomerFilters,
): Promise<SalesByCustomerReport> {
  const { from, to } = filters;
  const aggs = await db.invoice.groupBy({
    by: ['customerId'],
    where: {
      deletedAt: null,
      status: { not: InvoiceStatus.VOIDED },
      invoiceDate: { ...(from ? { gte: from } : {}), lt: to },
    },
    _sum: { total: true },
    _count: { _all: true },
  });

  if (aggs.length === 0) {
    return {
      asOfFrom: from ?? null,
      asOfTo: to,
      rows: [],
      totalGrossSales: ZERO,
      totalInvoices: 0,
    };
  }

  const customerIds = aggs.map((a) => a.customerId);
  const customers = await db.customer.findMany({
    where: { id: { in: customerIds } },
    select: { id: true, code: true, name: true },
  });
  const byId = new Map(customers.map((c) => [c.id, c]));

  let totalGrossSales = ZERO;
  let totalInvoices = 0;
  const rows: SalesByCustomerRow[] = aggs
    .map((a) => {
      const customer = byId.get(a.customerId);
      if (!customer) return null;
      const grossSales = a._sum.total ?? ZERO;
      totalGrossSales = totalGrossSales.plus(grossSales);
      totalInvoices += a._count._all;
      return {
        customerId: customer.id,
        customerCode: customer.code,
        customerName: customer.name,
        invoiceCount: a._count._all,
        grossSales,
      };
    })
    .filter((r): r is SalesByCustomerRow => r !== null);

  rows.sort((a, b) => {
    const cmp = b.grossSales.comparedTo(a.grossSales);
    if (cmp !== 0) return cmp;
    return a.customerName.localeCompare(b.customerName);
  });

  return {
    asOfFrom: from ?? null,
    asOfTo: to,
    rows,
    totalGrossSales,
    totalInvoices,
  };
}

// ---------------------------------------------------------------------------
// salesByItem
// ---------------------------------------------------------------------------

export type SalesByItemFilters = {
  from?: Date;
  to: Date;
};

export type SalesByItemRow = {
  variantId: string;
  sku: string;
  name: string | null;
  qtySold: Prisma.Decimal;
  grossSales: Prisma.Decimal;
};

export type SalesByItemReport = {
  asOfFrom: Date | null;
  asOfTo: Date;
  rows: SalesByItemRow[];
  totalQty: Prisma.Decimal;
  totalGrossSales: Prisma.Decimal;
};

/**
 * Per-variant qty sold + revenue for invoice lines whose parent
 * invoice has invoiceDate in [from, to) and is not VOIDED/deleted.
 * Sorted by grossSales DESC.
 *
 * Pilot scope: no COGS column. Adding it requires walking
 * FifoConsumption rows linked to each invoice line — cleaner as a
 * follow-on slice once profit-margin reports are needed.
 */
export async function salesByItem(
  db: PrismaClient,
  filters: SalesByItemFilters,
): Promise<SalesByItemReport> {
  const { from, to } = filters;
  const aggs = await db.invoiceLine.groupBy({
    by: ['variantId'],
    where: {
      deletedAt: null,
      invoice: {
        deletedAt: null,
        status: { not: InvoiceStatus.VOIDED },
        invoiceDate: { ...(from ? { gte: from } : {}), lt: to },
      },
    },
    _sum: { qty: true, lineTotal: true },
  });

  if (aggs.length === 0) {
    return {
      asOfFrom: from ?? null,
      asOfTo: to,
      rows: [],
      totalQty: ZERO,
      totalGrossSales: ZERO,
    };
  }

  const variantIds = aggs.map((a) => a.variantId);
  const variants = await db.productVariant.findMany({
    where: { id: { in: variantIds } },
    select: { id: true, sku: true, name: true },
  });
  const byId = new Map(variants.map((v) => [v.id, v]));

  let totalQty = ZERO;
  let totalGrossSales = ZERO;
  const rows: SalesByItemRow[] = aggs
    .map((a) => {
      const variant = byId.get(a.variantId);
      if (!variant) return null;
      const qtySold = a._sum.qty ?? ZERO;
      const grossSales = a._sum.lineTotal ?? ZERO;
      totalQty = totalQty.plus(qtySold);
      totalGrossSales = totalGrossSales.plus(grossSales);
      return {
        variantId: variant.id,
        sku: variant.sku,
        name: variant.name,
        qtySold,
        grossSales,
      };
    })
    .filter((r): r is SalesByItemRow => r !== null);

  rows.sort((a, b) => {
    const cmp = b.grossSales.comparedTo(a.grossSales);
    if (cmp !== 0) return cmp;
    return a.sku.localeCompare(b.sku);
  });

  return {
    asOfFrom: from ?? null,
    asOfTo: to,
    rows,
    totalQty,
    totalGrossSales,
  };
}

// ---------------------------------------------------------------------------
// inventoryValuation
// ---------------------------------------------------------------------------

export type InventoryValuationFilters = {
  warehouseId?: string;
};

export type InventoryValuationRow = {
  variantId: string;
  sku: string;
  name: string | null;
  warehouseId: string;
  warehouseCode: string;
  qty: Prisma.Decimal;
  value: Prisma.Decimal; // SUM(qtyRemaining × unitCost)
};

export type InventoryValuationReport = {
  warehouseId: string | null;
  rows: InventoryValuationRow[];
  totalQty: Prisma.Decimal;
  totalValue: Prisma.Decimal;
};

/**
 * Current inventory value at FIFO cost. One row per (variant, warehouse)
 * with non-zero qtyRemaining across non-deleted layers. Optionally
 * scoped to a single warehouse.
 *
 * Sorted by value DESC, ties broken by sku ASC.
 */
export async function inventoryValuation(
  db: PrismaClient,
  filters: InventoryValuationFilters = {},
): Promise<InventoryValuationReport> {
  const { warehouseId } = filters;

  const layers = await db.fifoLayer.findMany({
    where: {
      deletedAt: null,
      qtyRemaining: { gt: 0 },
      ...(warehouseId ? { warehouseId } : {}),
    },
    select: {
      variantId: true,
      warehouseId: true,
      qtyRemaining: true,
      unitCost: true,
      variant: { select: { sku: true, name: true } },
      warehouse: { select: { code: true } },
    },
  });

  // Aggregate (variant, warehouse) buckets in JS — Prisma groupBy can
  // do this but we need joined fields, so the post-fetch group keeps
  // the query simpler.
  const byKey = new Map<
    string,
    {
      variantId: string;
      sku: string;
      name: string | null;
      warehouseId: string;
      warehouseCode: string;
      qty: Prisma.Decimal;
      value: Prisma.Decimal;
    }
  >();
  let totalQty = ZERO;
  let totalValue = ZERO;
  for (const l of layers) {
    const key = `${l.variantId}::${l.warehouseId}`;
    let entry = byKey.get(key);
    if (!entry) {
      entry = {
        variantId: l.variantId,
        sku: l.variant.sku,
        name: l.variant.name,
        warehouseId: l.warehouseId,
        warehouseCode: l.warehouse.code,
        qty: ZERO,
        value: ZERO,
      };
      byKey.set(key, entry);
    }
    const layerValue = l.qtyRemaining.times(l.unitCost);
    entry.qty = entry.qty.plus(l.qtyRemaining);
    entry.value = entry.value.plus(layerValue);
    totalQty = totalQty.plus(l.qtyRemaining);
    totalValue = totalValue.plus(layerValue);
  }

  const rows: InventoryValuationRow[] = Array.from(byKey.values());
  rows.sort((a, b) => {
    const cmp = b.value.comparedTo(a.value);
    if (cmp !== 0) return cmp;
    return a.sku.localeCompare(b.sku);
  });

  return {
    warehouseId: warehouseId ?? null,
    rows,
    totalQty,
    totalValue,
  };
}

// ---------------------------------------------------------------------------
// cashPosition
// ---------------------------------------------------------------------------

const CASH_ACCOUNT = '1110';

export type CashPositionReport = {
  cashAccountCode: string;
  glBalance: Prisma.Decimal; // signed Dr−Cr (positive = natural Dr balance)
};

/**
 * Current GL 1110 cash/bank balance. Signed — positive means natural
 * debit balance ("we have cash"), negative would mean overdrawn (rare).
 *
 * Future slice: fan out across multiple bank accounts when the
 * operator adds them.
 */
export async function cashPosition(db: PrismaClient): Promise<CashPositionReport> {
  const account = await db.glAccount.findFirstOrThrow({
    where: { code: CASH_ACCOUNT, deletedAt: null },
  });
  const agg = await db.journalEntryLine.aggregate({
    where: {
      accountId: account.id,
      journalEntry: { deletedAt: null },
    },
    _sum: { debit: true, credit: true },
  });
  const glBalance = (agg._sum.debit ?? ZERO).minus(agg._sum.credit ?? ZERO);
  return {
    cashAccountCode: CASH_ACCOUNT,
    glBalance,
  };
}
