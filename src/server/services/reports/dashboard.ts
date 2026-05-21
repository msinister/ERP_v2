import {
  AuditAction,
  InvoiceStatus,
  PaymentStatus,
  Prisma,
  PurchaseOrderStatus,
  SalesOrderStatus,
} from '@/generated/tenant';
import type { PrismaClient } from '@/generated/tenant';
import { agingSummary } from '@/server/services/ar';
import { apAgingSummary } from '@/server/services/ap';
import { cashPosition } from './operational';

// =============================================================================
// Dashboard widget endpoints — slice E of phase 9. Spec docs/08:286-302.
//
// Each widget returns a small flat shape suitable for direct render
// (counts, totals, top-N samples). Larger drill-downs go through the
// dedicated report endpoints.
// =============================================================================

const ZERO = new Prisma.Decimal(0);

// Optional per-rep scoping for the sales/AR widgets. When customerSalesRepId
// is set, the widget counts/sums only that rep's customers' records; null/
// undefined leaves the widget unscoped (the default — managers/admins).
export type WidgetScopeOpts = {
  customerSalesRepId?: string | null;
};

// ---------------------------------------------------------------------------
// openSosWidget
// ---------------------------------------------------------------------------

export type OpenSosWidget = {
  byStatus: Record<string, number>;
  totalCount: number;
};

/**
 * Counts of "open" sales orders, grouped by status. "Open" = anything
 * that's not CLOSED or CANCELLED (DRAFT + CONFIRMED + DISPATCHED).
 * Excludes soft-deleted.
 *
 * Count-only — SalesOrder has no subtotal denorm. Drill into the SO list
 * endpoint with status filters for amounts.
 */
export async function openSosWidget(
  db: PrismaClient,
  opts: WidgetScopeOpts = {},
): Promise<OpenSosWidget> {
  const aggs = await db.salesOrder.groupBy({
    by: ['status'],
    where: {
      deletedAt: null,
      status: {
        in: [
          SalesOrderStatus.DRAFT,
          SalesOrderStatus.CONFIRMED,
          SalesOrderStatus.DISPATCHED,
        ],
      },
      ...(opts.customerSalesRepId
        ? { customer: { salesRepId: opts.customerSalesRepId } }
        : {}),
    },
    _count: { _all: true },
  });
  const byStatus: Record<string, number> = {};
  let totalCount = 0;
  for (const a of aggs) {
    byStatus[a.status] = a._count._all;
    totalCount += a._count._all;
  }
  return { byStatus, totalCount };
}

// ---------------------------------------------------------------------------
// openPosWidget
// ---------------------------------------------------------------------------

export type OpenPosWidget = {
  byStatus: Record<string, number>;
  totalCount: number;
};

/**
 * Counts of open purchase orders, grouped by status. "Open" = DRAFT +
 * CONFIRMED + PARTIALLY_RECEIVED. PO doesn't carry a subtotal denorm,
 * so this widget is count-only. Drill into the open POs via the POs
 * list endpoint for amounts.
 */
export async function openPosWidget(db: PrismaClient): Promise<OpenPosWidget> {
  const aggs = await db.purchaseOrder.groupBy({
    by: ['status'],
    where: {
      deletedAt: null,
      status: {
        in: [
          PurchaseOrderStatus.DRAFT,
          PurchaseOrderStatus.CONFIRMED,
          PurchaseOrderStatus.PARTIALLY_RECEIVED,
        ],
      },
    },
    _count: { _all: true },
  });
  const byStatus: Record<string, number> = {};
  let totalCount = 0;
  for (const a of aggs) {
    byStatus[a.status] = a._count._all;
    totalCount += a._count._all;
  }
  return { byStatus, totalCount };
}

// ---------------------------------------------------------------------------
// todaysSalesWidget
// ---------------------------------------------------------------------------

export type TodaysSalesWidget = {
  date: Date;
  invoiceCount: number;
  grossSales: Prisma.Decimal;
};

/**
 * Count + sum of invoices generated on the current UTC day. Excludes
 * VOIDED + soft-deleted. The "today" boundary is UTC, matching the
 * date convention used by the GL.
 */
export async function todaysSalesWidget(
  db: PrismaClient,
  now: Date = new Date(),
  opts: WidgetScopeOpts = {},
): Promise<TodaysSalesWidget> {
  const startOfDay = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const startOfNextDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000);

  const agg = await db.invoice.aggregate({
    where: {
      deletedAt: null,
      status: { not: InvoiceStatus.VOIDED },
      invoiceDate: { gte: startOfDay, lt: startOfNextDay },
      ...(opts.customerSalesRepId
        ? { customer: { salesRepId: opts.customerSalesRepId } }
        : {}),
    },
    _count: { _all: true },
    _sum: { total: true },
  });
  return {
    date: startOfDay,
    invoiceCount: agg._count._all,
    grossSales: agg._sum.total ?? ZERO,
  };
}

// ---------------------------------------------------------------------------
// cashPositionWidget
// ---------------------------------------------------------------------------

export type CashPositionWidget = {
  cashAccountCode: string;
  glBalance: Prisma.Decimal;
};

/** Thin wrapper over operational.cashPosition for the dashboard. */
export async function cashPositionWidget(
  db: PrismaClient,
): Promise<CashPositionWidget> {
  const result = await cashPosition(db);
  return {
    cashAccountCode: result.cashAccountCode,
    glBalance: result.glBalance,
  };
}

// ---------------------------------------------------------------------------
// arAgingWidget
// ---------------------------------------------------------------------------

export type ArAgingWidget = {
  current: Prisma.Decimal;
  b1to30: Prisma.Decimal;
  b31to60: Prisma.Decimal;
  b61to90: Prisma.Decimal;
  b91plus: Prisma.Decimal;
  total: Prisma.Decimal;
  customerCount: number;
};

/**
 * Aggregate AR aging across all customers — the dashboard pane wants
 * top-level bucket totals + how many customers have open balances.
 * Drill-downs go through /api/ar/aging-summary or per-customer endpoints.
 */
export async function arAgingWidget(
  db: PrismaClient,
  asOf: Date = new Date(),
  opts: WidgetScopeOpts = {},
): Promise<ArAgingWidget> {
  // Pull a generous slice of the summary to roll up. limit=500 matches
  // the agingSummary helper's max — pilot tenants are small enough that
  // this fits in one call.
  const rows = await agingSummary(db, asOf, {
    limit: 500,
    offset: 0,
    customerSalesRepId: opts.customerSalesRepId,
  });
  let current = ZERO;
  let b1to30 = ZERO;
  let b31to60 = ZERO;
  let b61to90 = ZERO;
  let b91plus = ZERO;
  for (const r of rows) {
    current = current.plus(r.current);
    b1to30 = b1to30.plus(r.b1to30);
    b31to60 = b31to60.plus(r.b31to60);
    b61to90 = b61to90.plus(r.b61to90);
    b91plus = b91plus.plus(r.b91plus);
  }
  const total = current.plus(b1to30).plus(b31to60).plus(b61to90).plus(b91plus);
  return {
    current,
    b1to30,
    b31to60,
    b61to90,
    b91plus,
    total,
    customerCount: rows.length,
  };
}

// ---------------------------------------------------------------------------
// apAgingWidget
// ---------------------------------------------------------------------------

export type ApAgingWidget = {
  current: Prisma.Decimal;
  b1to30: Prisma.Decimal;
  b31to60: Prisma.Decimal;
  b61to90: Prisma.Decimal;
  b91plus: Prisma.Decimal;
  total: Prisma.Decimal;
  vendorCount: number;
};

export async function apAgingWidget(
  db: PrismaClient,
  asOf: Date = new Date(),
): Promise<ApAgingWidget> {
  const rows = await apAgingSummary(db, asOf, { limit: 500, offset: 0 });
  let current = ZERO;
  let b1to30 = ZERO;
  let b31to60 = ZERO;
  let b61to90 = ZERO;
  let b91plus = ZERO;
  for (const r of rows) {
    current = current.plus(r.current);
    b1to30 = b1to30.plus(r.b1to30);
    b31to60 = b31to60.plus(r.b31to60);
    b61to90 = b61to90.plus(r.b61to90);
    b91plus = b91plus.plus(r.b91plus);
  }
  const total = current.plus(b1to30).plus(b31to60).plus(b61to90).plus(b91plus);
  return {
    current,
    b1to30,
    b31to60,
    b61to90,
    b91plus,
    total,
    vendorCount: rows.length,
  };
}

// ---------------------------------------------------------------------------
// lowStockWidget
// ---------------------------------------------------------------------------

export type LowStockRow = {
  variantId: string;
  productId: string;
  sku: string;
  name: string; // variant name || parent product name
  qoh: Prisma.Decimal;
  available: Prisma.Decimal; // qoh − reserved
};

export type LowStockWidget = {
  rows: LowStockRow[];
  totalLow: number; // count of variants with available ≤ threshold across all of inventory
};

const LOW_STOCK_LIMIT = 10;

/**
 * Variants that need attention: available qty ≤ 0 across all warehouses,
 * aggregated by variant. Pilot uses ≤ 0 as the threshold — no
 * per-product reorder point exists in schema yet (deferred per
 * docs/11). Only inventory-tracked, active, non-deleted variants
 * surface.
 *
 * Returns top-N (ascending available — most-negative first) plus a
 * total count so the widget can show "X of N low-stock items".
 */
export async function lowStockWidget(
  db: PrismaClient,
): Promise<LowStockWidget> {
  const variants = await db.productVariant.findMany({
    where: {
      active: true,
      deletedAt: null,
      product: { deletedAt: null, tracksInventory: true },
    },
    select: {
      id: true,
      sku: true,
      name: true,
      product: { select: { id: true, name: true } },
      inventory: { select: { onHand: true, reserved: true } },
    },
  });

  const aggregated: LowStockRow[] = [];
  for (const v of variants) {
    let qoh = ZERO;
    let reserved = ZERO;
    for (const item of v.inventory) {
      qoh = qoh.plus(item.onHand);
      reserved = reserved.plus(item.reserved);
    }
    const available = qoh.minus(reserved);
    if (available.lte(0)) {
      aggregated.push({
        variantId: v.id,
        productId: v.product.id,
        sku: v.sku,
        name: v.name ?? v.product.name,
        qoh,
        available,
      });
    }
  }

  // Most-negative (largest stockout) first; tiebreak by sku ASC for
  // stable display.
  aggregated.sort((a, b) => {
    const cmp = a.available.comparedTo(b.available);
    if (cmp !== 0) return cmp;
    return a.sku.localeCompare(b.sku);
  });

  return {
    rows: aggregated.slice(0, LOW_STOCK_LIMIT),
    totalLow: aggregated.length,
  };
}

// ---------------------------------------------------------------------------
// unappliedPaymentsWidget
// ---------------------------------------------------------------------------

export type UnappliedPaymentsWidget = {
  count: number;
  totalUnapplied: Prisma.Decimal;
};

/**
 * Customer payments with a remaining unapplied balance — RECORDED
 * status, not soft-deleted, amount > appliedAmount. The widget
 * surfaces the cash-on-account that still needs to be matched against
 * an invoice.
 */
export async function unappliedPaymentsWidget(
  db: PrismaClient,
  opts: WidgetScopeOpts = {},
): Promise<UnappliedPaymentsWidget> {
  const rows = await db.payment.findMany({
    where: {
      deletedAt: null,
      status: PaymentStatus.RECORDED,
      ...(opts.customerSalesRepId
        ? { customer: { salesRepId: opts.customerSalesRepId } }
        : {}),
    },
    select: { amount: true, appliedAmount: true },
  });
  let count = 0;
  let totalUnapplied = ZERO;
  for (const r of rows) {
    const unapplied = r.amount.minus(r.appliedAmount);
    if (unapplied.gt(0)) {
      count += 1;
      totalUnapplied = totalUnapplied.plus(unapplied);
    }
  }
  return { count, totalUnapplied };
}

// ---------------------------------------------------------------------------
// recentActivityWidget
// ---------------------------------------------------------------------------

export type RecentActivityRow = {
  id: string;
  action: AuditAction;
  entityType: string;
  entityId: string;
  reason: string | null;
  createdAt: Date;
  userName: string | null;
  userEmail: string | null;
};

export type RecentActivityWidget = {
  rows: RecentActivityRow[];
};

const RECENT_ACTIVITY_LIMIT = 10;

/**
 * Last N audit-log entries, newest first. Users are resolved in a
 * second batched query (no FK on AuditLog.userId by design — see
 * the AuditLog model comment in schema.prisma).
 */
export async function recentActivityWidget(
  db: PrismaClient,
): Promise<RecentActivityWidget> {
  const rawRows = await db.auditLog.findMany({
    orderBy: { createdAt: 'desc' },
    take: RECENT_ACTIVITY_LIMIT,
  });
  const userIds = Array.from(
    new Set(rawRows.map((r) => r.userId).filter((id): id is string => id !== null)),
  );
  const users = userIds.length
    ? await db.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, name: true, email: true },
      })
    : [];
  const usersById = new Map(users.map((u) => [u.id, u]));
  const rows: RecentActivityRow[] = rawRows.map((r) => {
    const u = r.userId ? usersById.get(r.userId) : null;
    return {
      id: r.id,
      action: r.action,
      entityType: r.entityType,
      entityId: r.entityId,
      reason: r.reason,
      createdAt: r.createdAt,
      userName: u?.name ?? null,
      userEmail: u?.email ?? null,
    };
  });
  return { rows };
}
