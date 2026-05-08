import {
  InvoiceStatus,
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
// Pilot scope: 6 widgets (the highest-value subset of the 12 listed):
//   - openSosWidget
//   - openPosWidget
//   - todaysSalesWidget
//   - cashPositionWidget
//   - arAgingWidget (wraps agingSummary; aggregate totals only)
//   - apAgingWidget (wraps apAgingSummary; aggregate totals only)
//
// Each widget returns a small flat shape suitable for direct render
// (counts, totals, top-N samples). Larger drill-downs go through the
// dedicated report endpoints.
// =============================================================================

const ZERO = new Prisma.Decimal(0);

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
export async function openSosWidget(db: PrismaClient): Promise<OpenSosWidget> {
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
): Promise<ArAgingWidget> {
  // Pull a generous slice of the summary to roll up. limit=500 matches
  // the agingSummary helper's max — pilot tenants are small enough that
  // this fits in one call.
  const rows = await agingSummary(db, asOf, { limit: 500, offset: 0 });
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
