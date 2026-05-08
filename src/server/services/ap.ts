import {
  BillPaymentStatus,
  BillStatus,
  Prisma,
  VendorCreditStatus,
} from '@/generated/tenant';
import type { PrismaClient } from '@/generated/tenant';

// =============================================================================
// AP aging service. Mirror of src/server/services/ar.ts.
//
// Read-only — this service writes nothing. All Decimal math via
// Prisma.Decimal; never JS Number.
//
// Three public functions:
//   - apBalanceForVendor — open AP + unapplied vendor credit (separate fields).
//   - agingForVendor    — bucketed detail per bill + summary buckets.
//   - apAgingSummary    — aggregate roll-up across all vendors.
//
// asOf parameter:
//   - Defaults to new Date() at function entry.
//   - Tests pass fixed dates for determinism.
//   - All bucket-boundary math is computed from this single instant.
//
// dueDate semantics:
//   - bill.dueDate is computed at confirm time from vendor.paymentTerm.netDays.
//     null dueDate (vendor with no payment term, or COD/Prepay netDays=null)
//     is treated as bill.billDate — due immediately.
//   - We do NOT recompute from current vendor.paymentTerm — bill.dueDate
//     is the source of truth, capturing the term as-of confirm time.
//
// Bill eligibility:
//   - Excluded:  status != CONFIRMED, deletedAt != null.
//   - Included:  status = CONFIRMED with paymentStatus in (UNPAID, PARTIAL).
//                PAID has no balance.
//
// Bucket assignment (mirror of docs/06 AR aging — same boundaries apply):
//   daysPastDue < 0           →  current        (not yet due)
//   0  <= daysPastDue <= 30   →  b1to30
//   31 <= daysPastDue <= 60   →  b31to60
//   61 <= daysPastDue <= 90   →  b61to90
//   daysPastDue >= 91         →  b91plus
// =============================================================================

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export type AgingBucketKey =
  | 'current'
  | 'b1to30'
  | 'b31to60'
  | 'b61to90'
  | 'b91plus';

export type AgingBuckets = Record<AgingBucketKey, Prisma.Decimal>;

export type AgingBillRow = {
  billId: string;
  number: string;
  vendorReference: string | null;
  billDate: Date;
  dueDate: Date;
  daysPastDue: number;
  total: Prisma.Decimal;
  amountPaid: Prisma.Decimal;
  amountCredited: Prisma.Decimal;
  balance: Prisma.Decimal;
  bucket: AgingBucketKey;
};

export type ApAgingDetail = {
  vendorId: string;
  asOf: Date;
  buckets: AgingBuckets;
  total: Prisma.Decimal;
  unappliedCreditBalance: Prisma.Decimal;
  bills: AgingBillRow[];
};

export type ApAgingSummaryRow = {
  vendorId: string;
  vendorCode: string;
  vendorName: string;
  current: Prisma.Decimal;
  b1to30: Prisma.Decimal;
  b31to60: Prisma.Decimal;
  b61to90: Prisma.Decimal;
  b91plus: Prisma.Decimal;
  total: Prisma.Decimal;
  unappliedCreditBalance: Prisma.Decimal;
};

// ---------------------------------------------------------------------------
// apBalanceForVendor
// ---------------------------------------------------------------------------

/**
 * Two complementary fields:
 *   - apBalance:              SUM over open bills of total − amountPaid − amountCredited.
 *                             Always >= 0 (denorm self-heal in bills service caps it).
 *   - unappliedCreditBalance: SUM over CONFIRMED VCs of (amount − appliedAmount).
 *                             Always >= 0.
 *
 * NEVER netted into a single signed number. A vendor with no open
 * bills and $50 of unapplied credit returns:
 *   { apBalance: 0, unappliedCreditBalance: 50 }
 * NOT { apBalance: -50 }.
 *
 * `asOf` is accepted for API symmetry; today's balances do not depend
 * on it (all amount* counters are current). Aging buckets do depend
 * on it — see agingForVendor.
 */
export async function apBalanceForVendor(
  db: PrismaClient,
  vendorId: string,
  _asOf: Date = new Date(),
): Promise<{
  apBalance: Prisma.Decimal;
  unappliedCreditBalance: Prisma.Decimal;
}> {
  const [bills, vendorCredits] = await Promise.all([
    db.bill.findMany({
      where: {
        vendorId,
        deletedAt: null,
        status: BillStatus.CONFIRMED,
        paymentStatus: { in: [BillPaymentStatus.UNPAID, BillPaymentStatus.PARTIAL] },
      },
      select: { total: true, amountPaid: true, amountCredited: true },
    }),
    db.vendorCredit.findMany({
      where: {
        vendorId,
        deletedAt: null,
        status: VendorCreditStatus.CONFIRMED,
      },
      select: { amount: true, appliedAmount: true },
    }),
  ]);

  const apBalance = bills.reduce(
    (acc, b) => acc.plus(b.total).minus(b.amountPaid).minus(b.amountCredited),
    new Prisma.Decimal(0),
  );
  const unappliedCreditBalance = vendorCredits.reduce(
    (acc, v) => acc.plus(v.amount).minus(v.appliedAmount),
    new Prisma.Decimal(0),
  );

  return { apBalance, unappliedCreditBalance };
}

// ---------------------------------------------------------------------------
// agingForVendor
// ---------------------------------------------------------------------------

function bucketFor(daysPastDue: number): AgingBucketKey {
  if (daysPastDue < 0) return 'current';
  if (daysPastDue <= 30) return 'b1to30';
  if (daysPastDue <= 60) return 'b31to60';
  if (daysPastDue <= 90) return 'b61to90';
  return 'b91plus';
}

function emptyBuckets(): AgingBuckets {
  return {
    current: new Prisma.Decimal(0),
    b1to30: new Prisma.Decimal(0),
    b31to60: new Prisma.Decimal(0),
    b61to90: new Prisma.Decimal(0),
    b91plus: new Prisma.Decimal(0),
  };
}

function effectiveDueDate(billDate: Date, dueDate: Date | null): Date {
  // null dueDate = COD/Prepay/no-term — treat as billDate (due
  // immediately on the bill date). Matches AR's COD convention.
  return dueDate ?? billDate;
}

function computeDaysPastDue(asOf: Date, dueDate: Date): number {
  const diffMs = asOf.getTime() - dueDate.getTime();
  return Math.floor(diffMs / ONE_DAY_MS);
}

/**
 * Bucketed aging detail for a single vendor, with per-bill rows.
 * Bills sorted oldest-delinquency-first (daysPastDue DESC).
 *
 * Excludes deleted, cancelled, and PAID bills. dueDate snapshot from
 * the bill itself (not recomputed from current vendor.paymentTerm).
 */
export async function agingForVendor(
  db: PrismaClient,
  vendorId: string,
  asOf: Date = new Date(),
): Promise<ApAgingDetail> {
  const vendor = await db.vendor.findUniqueOrThrow({
    where: { id: vendorId },
    select: { id: true },
  });

  const [openBills, balanceResult] = await Promise.all([
    db.bill.findMany({
      where: {
        vendorId,
        deletedAt: null,
        status: BillStatus.CONFIRMED,
        paymentStatus: {
          in: [BillPaymentStatus.UNPAID, BillPaymentStatus.PARTIAL],
        },
      },
      select: {
        id: true,
        number: true,
        vendorReference: true,
        billDate: true,
        dueDate: true,
        total: true,
        amountPaid: true,
        amountCredited: true,
      },
    }),
    apBalanceForVendor(db, vendorId, asOf),
  ]);

  const buckets = emptyBuckets();
  const rows: AgingBillRow[] = openBills.map((b) => {
    const dueDate = effectiveDueDate(b.billDate, b.dueDate);
    const daysPastDue = computeDaysPastDue(asOf, dueDate);
    const balance = b.total.minus(b.amountPaid).minus(b.amountCredited);
    const bucket = bucketFor(daysPastDue);
    buckets[bucket] = buckets[bucket].plus(balance);
    return {
      billId: b.id,
      number: b.number,
      vendorReference: b.vendorReference,
      billDate: b.billDate,
      dueDate,
      daysPastDue,
      total: b.total,
      amountPaid: b.amountPaid,
      amountCredited: b.amountCredited,
      balance,
      bucket,
    };
  });

  rows.sort((a, b) => b.daysPastDue - a.daysPastDue);

  const total = (Object.keys(buckets) as AgingBucketKey[]).reduce(
    (acc, k) => acc.plus(buckets[k]),
    new Prisma.Decimal(0),
  );

  return {
    vendorId: vendor.id,
    asOf,
    buckets,
    total,
    unappliedCreditBalance: balanceResult.unappliedCreditBalance,
    bills: rows,
  };
}

// ---------------------------------------------------------------------------
// apAgingSummary
// ---------------------------------------------------------------------------

/**
 * One row per vendor with at least one open bill. Sorted by total
 * balance DESC, paginated via limit/offset.
 *
 * Implementation: pulls open bills joined with vendor (one query) and
 * confirmed VCs (one query) — two queries total, NOT N+1 in number of
 * vendors.
 */
export async function apAgingSummary(
  db: PrismaClient,
  asOf: Date = new Date(),
  opts: { limit?: number; offset?: number } = {},
): Promise<ApAgingSummaryRow[]> {
  const limit = Math.min(opts.limit ?? 50, 500);
  const offset = opts.offset ?? 0;

  const openBills = await db.bill.findMany({
    where: {
      deletedAt: null,
      status: BillStatus.CONFIRMED,
      paymentStatus: {
        in: [BillPaymentStatus.UNPAID, BillPaymentStatus.PARTIAL],
      },
    },
    select: {
      vendorId: true,
      billDate: true,
      dueDate: true,
      total: true,
      amountPaid: true,
      amountCredited: true,
      vendor: { select: { id: true, code: true, name: true } },
    },
  });

  if (openBills.length === 0) return [];

  // Group by vendor, accumulating bucket totals.
  const byVendor = new Map<
    string,
    {
      vendorId: string;
      vendorCode: string;
      vendorName: string;
      buckets: AgingBuckets;
    }
  >();

  for (const bill of openBills) {
    const balance = bill.total.minus(bill.amountPaid).minus(bill.amountCredited);
    const dueDate = effectiveDueDate(bill.billDate, bill.dueDate);
    const daysPastDue = computeDaysPastDue(asOf, dueDate);
    const bucket = bucketFor(daysPastDue);
    let entry = byVendor.get(bill.vendor.id);
    if (!entry) {
      entry = {
        vendorId: bill.vendor.id,
        vendorCode: bill.vendor.code,
        vendorName: bill.vendor.name,
        buckets: emptyBuckets(),
      };
      byVendor.set(bill.vendor.id, entry);
    }
    entry.buckets[bucket] = entry.buckets[bucket].plus(balance);
  }

  const vendorIds = Array.from(byVendor.keys());

  const vcs = await db.vendorCredit.findMany({
    where: {
      vendorId: { in: vendorIds },
      deletedAt: null,
      status: VendorCreditStatus.CONFIRMED,
    },
    select: { vendorId: true, amount: true, appliedAmount: true },
  });

  const unappliedByVendor = new Map<string, Prisma.Decimal>();
  for (const v of vcs) {
    const cur = unappliedByVendor.get(v.vendorId) ?? new Prisma.Decimal(0);
    unappliedByVendor.set(v.vendorId, cur.plus(v.amount).minus(v.appliedAmount));
  }

  const rows: ApAgingSummaryRow[] = Array.from(byVendor.values()).map((entry) => {
    const total = (Object.keys(entry.buckets) as AgingBucketKey[]).reduce(
      (acc, k) => acc.plus(entry.buckets[k]),
      new Prisma.Decimal(0),
    );
    return {
      vendorId: entry.vendorId,
      vendorCode: entry.vendorCode,
      vendorName: entry.vendorName,
      current: entry.buckets.current,
      b1to30: entry.buckets.b1to30,
      b31to60: entry.buckets.b31to60,
      b61to90: entry.buckets.b61to90,
      b91plus: entry.buckets.b91plus,
      total,
      unappliedCreditBalance:
        unappliedByVendor.get(entry.vendorId) ?? new Prisma.Decimal(0),
    };
  });

  rows.sort((a, b) => {
    const cmp = b.total.comparedTo(a.total);
    if (cmp !== 0) return cmp;
    return a.vendorName.localeCompare(b.vendorName);
  });

  return rows.slice(offset, offset + limit);
}
