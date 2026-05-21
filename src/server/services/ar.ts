import {
  CreditMemoStatus,
  InvoiceStatus,
  PaymentMethod,
  PaymentStatus,
  Prisma,
} from '@/generated/tenant';
import type { PrismaClient } from '@/generated/tenant';

// =============================================================================
// AR aging service.
//
// Read-only — this service writes nothing. All Decimal math via
// Prisma.Decimal; never JS Number.
//
// Three public functions:
//   - arBalanceForCustomer  — open AR + unapplied credit (separate fields).
//   - agingForCustomer      — bucketed detail per invoice + summary buckets.
//   - agingSummary          — aggregate roll-up across all customers.
//
// asOf parameter:
//   - Defaults to new Date() at function entry.
//   - Tests pass fixed dates for determinism.
//   - All bucket-boundary math is computed from this single instant.
//
// PaymentTerm semantics:
//   - paymentTerm.netDays === null  →  COD/Prepay; dueDate = invoiceDate
//     (immediately due — daysPastDue starts at 0 on the invoice date).
//   - paymentTerm.netDays >= 0      →  dueDate = invoiceDate + netDays.
//
// Invoice eligibility:
//   - Excluded:  status === VOIDED, deletedAt !== null.
//   - Included:  status in (OPEN, PARTIAL). PAID has no balance.
//
// Bucket assignment (per docs/06-invoicing-ar.md):
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

export type AgingInvoiceRow = {
  invoiceId: string;
  // Nullable: orphaned invoices (post-reopen + post-void) have no
  // live SO link. Surfaced so UI tables can link the invoice number
  // to its parent SO when present and render plain text otherwise.
  salesOrderId: string | null;
  number: string;
  invoiceDate: Date;
  dueDate: Date;
  daysPastDue: number;
  total: Prisma.Decimal;
  amountPaid: Prisma.Decimal;
  amountCredited: Prisma.Decimal;
  balance: Prisma.Decimal;
  bucket: AgingBucketKey;
};

export type AgingDetail = {
  customerId: string;
  asOf: Date;
  buckets: AgingBuckets;
  total: Prisma.Decimal;
  unappliedCreditBalance: Prisma.Decimal;
  invoices: AgingInvoiceRow[];
};

export type AgingSummaryRow = {
  customerId: string;
  customerName: string;
  current: Prisma.Decimal;
  b1to30: Prisma.Decimal;
  b31to60: Prisma.Decimal;
  b61to90: Prisma.Decimal;
  b91plus: Prisma.Decimal;
  total: Prisma.Decimal;
  unappliedCreditBalance: Prisma.Decimal;
};

// ---------------------------------------------------------------------------
// arBalanceForCustomer
// ---------------------------------------------------------------------------

/**
 * Two complementary fields:
 *   - arBalance:              SUM over open invoices of total − amountPaid − amountCredited.
 *                             Always >= 0 (denorm self-heal in invoices service caps it).
 *   - unappliedCreditBalance: SUM over CONFIRMED CMs of (netCredit − appliedAmount)
 *                             PLUS SUM over RECORDED non-APPLIED_CREDIT payments of
 *                             (amount − appliedAmount). Always >= 0.
 *
 * NEVER netted into a single signed number. A customer with no open
 * invoices and $50 of unapplied credit returns:
 *   { arBalance: 0, unappliedCreditBalance: 50 }
 * NOT { arBalance: -50 }.
 *
 * `asOf` is accepted for API symmetry; today's balances do not depend
 * on it (all amount* counters are current). Aging buckets do depend
 * on it — see agingForCustomer.
 */
export async function arBalanceForCustomer(
  db: PrismaClient,
  customerId: string,
  _asOf: Date = new Date(),
): Promise<{
  arBalance: Prisma.Decimal;
  unappliedCreditBalance: Prisma.Decimal;
}> {
  const [invoices, creditMemos, payments] = await Promise.all([
    db.invoice.findMany({
      where: {
        customerId,
        deletedAt: null,
        status: { in: [InvoiceStatus.OPEN, InvoiceStatus.PARTIAL] },
      },
      select: { total: true, amountPaid: true, amountCredited: true },
    }),
    db.creditMemo.findMany({
      where: {
        customerId,
        deletedAt: null,
        status: CreditMemoStatus.CONFIRMED,
      },
      select: { netCredit: true, appliedAmount: true },
    }),
    db.payment.findMany({
      where: {
        customerId,
        deletedAt: null,
        status: PaymentStatus.RECORDED,
        method: { not: PaymentMethod.APPLIED_CREDIT },
      },
      select: { amount: true, appliedAmount: true },
    }),
  ]);

  const arBalance = invoices.reduce(
    (acc, i) => acc.plus(i.total).minus(i.amountPaid).minus(i.amountCredited),
    new Prisma.Decimal(0),
  );

  const cmUnapplied = creditMemos.reduce(
    (acc, c) => acc.plus(c.netCredit).minus(c.appliedAmount),
    new Prisma.Decimal(0),
  );
  const pmtUnapplied = payments.reduce(
    (acc, p) => acc.plus(p.amount).minus(p.appliedAmount),
    new Prisma.Decimal(0),
  );
  const unappliedCreditBalance = cmUnapplied.plus(pmtUnapplied);

  return { arBalance, unappliedCreditBalance };
}

// ---------------------------------------------------------------------------
// agingForCustomer
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

function computeDueDate(invoiceDate: Date, netDays: number | null): Date {
  // netDays === null is the COD/Prepay convention — due immediately on
  // invoice date. Documented in JSDoc and in the file header.
  if (netDays === null) return invoiceDate;
  const due = new Date(invoiceDate);
  due.setUTCDate(due.getUTCDate() + netDays);
  return due;
}

function computeDaysPastDue(asOf: Date, dueDate: Date): number {
  const diffMs = asOf.getTime() - dueDate.getTime();
  return Math.floor(diffMs / ONE_DAY_MS);
}

/**
 * Bucketed aging detail for a single customer, with per-invoice rows.
 * Invoices sorted oldest-delinquency-first (daysPastDue DESC).
 *
 * Excludes VOIDED, soft-deleted, and PAID invoices. PaymentTerm is
 * read off the customer at query time — historical aging uses today's
 * term assignment, not the term as-of any prior date.
 */
export async function agingForCustomer(
  db: PrismaClient,
  customerId: string,
  asOf: Date = new Date(),
): Promise<AgingDetail> {
  const customer = await db.customer.findUniqueOrThrow({
    where: { id: customerId },
    select: { id: true, paymentTerm: { select: { netDays: true } } },
  });

  const [openInvoices, balanceResult] = await Promise.all([
    db.invoice.findMany({
      where: {
        customerId,
        deletedAt: null,
        status: { in: [InvoiceStatus.OPEN, InvoiceStatus.PARTIAL] },
      },
      select: {
        id: true,
        salesOrderId: true,
        number: true,
        invoiceDate: true,
        total: true,
        amountPaid: true,
        amountCredited: true,
      },
    }),
    arBalanceForCustomer(db, customerId, asOf),
  ]);

  const buckets = emptyBuckets();
  const rows: AgingInvoiceRow[] = openInvoices.map((inv) => {
    const dueDate = computeDueDate(inv.invoiceDate, customer.paymentTerm.netDays);
    const daysPastDue = computeDaysPastDue(asOf, dueDate);
    const balance = inv.total.minus(inv.amountPaid).minus(inv.amountCredited);
    const bucket = bucketFor(daysPastDue);
    buckets[bucket] = buckets[bucket].plus(balance);
    return {
      invoiceId: inv.id,
      salesOrderId: inv.salesOrderId,
      number: inv.number,
      invoiceDate: inv.invoiceDate,
      dueDate,
      daysPastDue,
      total: inv.total,
      amountPaid: inv.amountPaid,
      amountCredited: inv.amountCredited,
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
    customerId,
    asOf,
    buckets,
    total,
    unappliedCreditBalance: balanceResult.unappliedCreditBalance,
    invoices: rows,
  };
}

// ---------------------------------------------------------------------------
// agingSummary
// ---------------------------------------------------------------------------

/**
 * One row per customer with at least one open invoice. Sorted by
 * total balance DESC, paginated via limit/offset.
 *
 * Implementation: pulls open invoices joined with customer (one query)
 * and confirmed credit memos + recorded non-APPLIED_CREDIT payments
 * (two queries) — three queries total, NOT N+1 in number of customers.
 */
export async function agingSummary(
  db: PrismaClient,
  asOf: Date = new Date(),
  opts: {
    limit?: number;
    offset?: number;
    // When set, restrict to one rep's customers (dashboard "view own").
    customerSalesRepId?: string | null;
  } = {},
): Promise<AgingSummaryRow[]> {
  const limit = Math.min(opts.limit ?? 50, 500);
  const offset = opts.offset ?? 0;

  const openInvoices = await db.invoice.findMany({
    where: {
      deletedAt: null,
      status: { in: [InvoiceStatus.OPEN, InvoiceStatus.PARTIAL] },
      ...(opts.customerSalesRepId
        ? { customer: { salesRepId: opts.customerSalesRepId } }
        : {}),
    },
    select: {
      customerId: true,
      invoiceDate: true,
      total: true,
      amountPaid: true,
      amountCredited: true,
      customer: {
        select: {
          id: true,
          name: true,
          paymentTerm: { select: { netDays: true } },
        },
      },
    },
  });

  if (openInvoices.length === 0) return [];

  // Group by customer, accumulating bucket totals.
  const byCustomer = new Map<
    string,
    {
      customerId: string;
      customerName: string;
      buckets: AgingBuckets;
    }
  >();

  for (const inv of openInvoices) {
    const balance = inv.total.minus(inv.amountPaid).minus(inv.amountCredited);
    const dueDate = computeDueDate(inv.invoiceDate, inv.customer.paymentTerm.netDays);
    const daysPastDue = computeDaysPastDue(asOf, dueDate);
    const bucket = bucketFor(daysPastDue);
    let entry = byCustomer.get(inv.customer.id);
    if (!entry) {
      entry = {
        customerId: inv.customer.id,
        customerName: inv.customer.name,
        buckets: emptyBuckets(),
      };
      byCustomer.set(inv.customer.id, entry);
    }
    entry.buckets[bucket] = entry.buckets[bucket].plus(balance);
  }

  const customerIds = Array.from(byCustomer.keys());

  // Pull unapplied credit balances for just these customers in two
  // grouped queries — avoids N+1.
  const [cms, pmts] = await Promise.all([
    db.creditMemo.findMany({
      where: {
        customerId: { in: customerIds },
        deletedAt: null,
        status: CreditMemoStatus.CONFIRMED,
      },
      select: { customerId: true, netCredit: true, appliedAmount: true },
    }),
    db.payment.findMany({
      where: {
        customerId: { in: customerIds },
        deletedAt: null,
        status: PaymentStatus.RECORDED,
        method: { not: PaymentMethod.APPLIED_CREDIT },
      },
      select: { customerId: true, amount: true, appliedAmount: true },
    }),
  ]);

  const unappliedByCustomer = new Map<string, Prisma.Decimal>();
  for (const c of cms) {
    const cur = unappliedByCustomer.get(c.customerId) ?? new Prisma.Decimal(0);
    unappliedByCustomer.set(
      c.customerId,
      cur.plus(c.netCredit).minus(c.appliedAmount),
    );
  }
  for (const p of pmts) {
    const cur = unappliedByCustomer.get(p.customerId) ?? new Prisma.Decimal(0);
    unappliedByCustomer.set(p.customerId, cur.plus(p.amount).minus(p.appliedAmount));
  }

  const rows: AgingSummaryRow[] = Array.from(byCustomer.values()).map((entry) => {
    const total = (Object.keys(entry.buckets) as AgingBucketKey[]).reduce(
      (acc, k) => acc.plus(entry.buckets[k]),
      new Prisma.Decimal(0),
    );
    return {
      customerId: entry.customerId,
      customerName: entry.customerName,
      current: entry.buckets.current,
      b1to30: entry.buckets.b1to30,
      b31to60: entry.buckets.b31to60,
      b61to90: entry.buckets.b61to90,
      b91plus: entry.buckets.b91plus,
      total,
      unappliedCreditBalance:
        unappliedByCustomer.get(entry.customerId) ?? new Prisma.Decimal(0),
    };
  });

  rows.sort((a, b) => {
    const cmp = b.total.comparedTo(a.total);
    if (cmp !== 0) return cmp;
    return a.customerName.localeCompare(b.customerName);
  });

  return rows.slice(offset, offset + limit);
}
