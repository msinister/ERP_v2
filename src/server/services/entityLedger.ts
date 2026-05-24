import {
  BillStatus,
  CreditApplicationKind,
  CreditMemoStatus,
  InvoiceStatus,
  PaymentMethod,
  PaymentStatus,
  Prisma,
  VendorCreditStatus,
} from '@/generated/tenant';
import type { PrismaClient } from '@/generated/tenant';

// =============================================================================
// Entity ledger — a per-vendor / per-customer transaction register with a
// running balance, in the spirit of the GL Account Ledger (glLedger.ts) but
// scoped to one trading partner instead of one GL account.
//
// Balance model: SINGLE NET BALANCE (statement style). The running balance
// is Σ(debit − credit) chronologically, where:
//   - debit  = increases what's owed (vendor: we owe them; customer: they
//              owe us). Bills / Invoices.
//   - credit = decreases what's owed. Payments, issued credits, deposits.
// A negative balance means the partner is in credit (they hold our money /
// we hold their credit) — i.e. a prepayment/credit position.
//
// To avoid double-counting, applications (credit→bill, deposit→bill,
// payment/credit→invoice) are shown as balance-NEUTRAL detail rows: the
// payment/credit already moved the balance once at its face value.
// Overpayment-sourced vendor credits are likewise neutral — their cash was
// already counted on the originating bill payment.
//
// Read-only. All Decimal math via Prisma.Decimal; never JS Number.
// =============================================================================

const ZERO = new Prisma.Decimal(0);

export type LedgerTxnType =
  // Vendor
  | 'BILL'
  | 'BILL_PAYMENT'
  | 'VENDOR_CREDIT'
  | 'VENDOR_CREDIT_APPLIED'
  | 'PO_DEPOSIT'
  | 'PO_DEPOSIT_APPLIED'
  // Customer
  | 'INVOICE'
  | 'CUSTOMER_PAYMENT'
  | 'CREDIT_MEMO'
  | 'CREDIT_APPLIED';

// Link-target model → route prefix. Mirrors gl-ledger's SOURCE_PREFIX.
type LinkType =
  | 'Bill'
  | 'PurchaseOrder'
  | 'VendorCredit'
  | 'Payment'
  | 'CreditMemo'
  | 'SalesOrder';

const LINK_PREFIX: Record<LinkType, string> = {
  Bill: 'bills',
  PurchaseOrder: 'purchase-orders',
  VendorCredit: 'vendor-credits',
  Payment: 'payments',
  CreditMemo: 'credit-memos',
  SalesOrder: 'sales-orders',
};

export function ledgerHref(
  linkType: LinkType | null,
  linkId: string | null,
): string | null {
  if (!linkType || !linkId) return null;
  return `/${LINK_PREFIX[linkType]}/${linkId}`;
}

export type LedgerRow = {
  // Stable unique id (sourceType:sourceId) for React keys + dedup.
  id: string;
  date: Date;
  type: LedgerTxnType;
  number: string;
  description: string;
  linkType: LinkType | null;
  linkId: string | null;
  debit: Prisma.Decimal;
  credit: Prisma.Decimal;
  // Signed net (debit − credit) cumulative through this row, all-time.
  runningBalance: Prisma.Decimal;
};

export type EntityLedger = {
  rows: LedgerRow[]; // display order (sort applied), windowed + paginated
  total: number; // rows in the filtered window (pre-pagination)
  currentBalance: Prisma.Decimal; // all-time net (independent of filters)
  windowDebits: Prisma.Decimal; // Σ debit over the filtered window
  windowCredits: Prisma.Decimal; // Σ credit over the filtered window
};

export type LedgerFilters = {
  from?: Date;
  to?: Date;
  type?: LedgerTxnType;
  sort?: 'newest' | 'oldest';
  skip?: number;
  take?: number;
};

// ---------------------------------------------------------------------------
// Chronological ordering: date asc, then debits-before-credits-before-neutral
// within a day (so a statement reads naturally), then number, then id.
// ---------------------------------------------------------------------------

function rank(r: { debit: Prisma.Decimal; credit: Prisma.Decimal }): number {
  if (r.debit.greaterThan(0)) return 0;
  if (r.credit.greaterThan(0)) return 1;
  return 2;
}

function chronoCompare(a: LedgerRow, b: LedgerRow): number {
  const d = a.date.getTime() - b.date.getTime();
  if (d !== 0) return d;
  const rr = rank(a) - rank(b);
  if (rr !== 0) return rr;
  if (a.number !== b.number) return a.number < b.number ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// Shared finisher: assign running balance over the full all-time set, then
// apply window (date/type) filters, sort, and pagination for display. The
// running balance on every returned row is the true cumulative balance at
// that transaction (all activity), regardless of the filters — same idea as
// glLedger carrying a pre-window beginning balance.
function finishLedger(all: LedgerRow[], filters: LedgerFilters): EntityLedger {
  const { from, to, type, sort = 'newest', skip = 0, take = 50 } = filters;

  // 1. Chronological (oldest-first) + running balance over everything.
  all.sort(chronoCompare);
  let running = ZERO;
  for (const row of all) {
    running = running.plus(row.debit).minus(row.credit);
    row.runningBalance = running;
  }
  const currentBalance = running;

  // 2. Window filter (date + type).
  const windowed = all.filter((r) => {
    if (from && r.date.getTime() < from.getTime()) return false;
    if (to && r.date.getTime() > to.getTime()) return false;
    if (type && r.type !== type) return false;
    return true;
  });

  const windowDebits = windowed.reduce((acc, r) => acc.plus(r.debit), ZERO);
  const windowCredits = windowed.reduce((acc, r) => acc.plus(r.credit), ZERO);

  // 3. Display order + pagination.
  if (sort === 'newest') windowed.reverse();
  const total = windowed.length;
  const rows = windowed.slice(skip, skip + take);

  return { rows, total, currentBalance, windowDebits, windowCredits };
}

// ---------------------------------------------------------------------------
// Vendor ledger
// ---------------------------------------------------------------------------

async function buildVendorRows(
  db: PrismaClient,
  vendorId: string,
): Promise<LedgerRow[]> {
  const [bills, payments, credits, creditApps, deposits, depositApps] =
    await Promise.all([
      db.bill.findMany({
        where: { vendorId, deletedAt: null, status: BillStatus.CONFIRMED },
        select: { id: true, number: true, billDate: true, total: true },
      }),
      db.billPayment.findMany({
        where: { vendorId, deletedAt: null, status: PaymentStatus.RECORDED },
        select: { id: true, number: true, paymentDate: true, amount: true, billId: true },
      }),
      db.vendorCredit.findMany({
        where: { vendorId, deletedAt: null, status: VendorCreditStatus.CONFIRMED },
        select: { id: true, number: true, creditDate: true, amount: true, sourceTag: true },
      }),
      db.vendorCreditApplication.findMany({
        where: { reversedAt: null, vendorCredit: { vendorId } },
        select: {
          id: true,
          amount: true,
          appliedAt: true,
          billId: true,
          vendorCredit: { select: { number: true } },
          bill: { select: { number: true } },
        },
      }),
      db.poPayment.findMany({
        where: { vendorId, deletedAt: null, status: PaymentStatus.RECORDED },
        select: {
          id: true,
          number: true,
          paymentDate: true,
          amount: true,
          purchaseOrderId: true,
        },
      }),
      db.poPaymentApplication.findMany({
        where: { reversedAt: null, poPayment: { vendorId } },
        select: {
          id: true,
          amount: true,
          appliedAt: true,
          billId: true,
          poPayment: { select: { number: true } },
          bill: { select: { number: true } },
        },
      }),
    ]);

  const rows: LedgerRow[] = [];

  for (const b of bills) {
    rows.push({
      id: `bill:${b.id}`,
      date: b.billDate,
      type: 'BILL',
      number: b.number,
      description: `Bill ${b.number}`,
      linkType: 'Bill',
      linkId: b.id,
      debit: b.total,
      credit: ZERO,
      runningBalance: ZERO,
    });
  }

  for (const p of payments) {
    rows.push({
      id: `billpmt:${p.id}`,
      date: p.paymentDate,
      type: 'BILL_PAYMENT',
      number: p.number,
      description: `Bill payment ${p.number}`,
      linkType: 'Bill',
      linkId: p.billId,
      debit: ZERO,
      credit: p.amount,
      runningBalance: ZERO,
    });
  }

  for (const c of credits) {
    // Overpayment-sourced credits are balance-neutral: their cash was
    // already counted on the originating bill payment.
    const isOverpayment = (c.sourceTag ?? '').startsWith('OVERPAYMENT:');
    rows.push({
      id: `vc:${c.id}`,
      date: c.creditDate,
      type: 'VENDOR_CREDIT',
      number: c.number,
      description: isOverpayment
        ? `Vendor credit ${c.number} (overpayment)`
        : `Vendor credit ${c.number}`,
      linkType: 'VendorCredit',
      linkId: c.id,
      debit: ZERO,
      credit: isOverpayment ? ZERO : c.amount,
      runningBalance: ZERO,
    });
  }

  for (const a of creditApps) {
    rows.push({
      id: `vcapp:${a.id}`,
      date: a.appliedAt,
      type: 'VENDOR_CREDIT_APPLIED',
      number: a.vendorCredit.number,
      description: `Credit ${a.vendorCredit.number} applied to bill ${a.bill.number}`,
      linkType: 'Bill',
      linkId: a.billId,
      debit: ZERO,
      credit: ZERO,
      runningBalance: ZERO,
    });
  }

  for (const d of deposits) {
    rows.push({
      id: `podep:${d.id}`,
      date: d.paymentDate,
      type: 'PO_DEPOSIT',
      number: d.number,
      description: `PO deposit ${d.number}`,
      linkType: 'PurchaseOrder',
      linkId: d.purchaseOrderId,
      debit: ZERO,
      credit: d.amount,
      runningBalance: ZERO,
    });
  }

  for (const a of depositApps) {
    rows.push({
      id: `podepapp:${a.id}`,
      date: a.appliedAt,
      type: 'PO_DEPOSIT_APPLIED',
      number: a.poPayment.number,
      description: `Deposit ${a.poPayment.number} applied to bill ${a.bill.number}`,
      linkType: 'Bill',
      linkId: a.billId,
      debit: ZERO,
      credit: ZERO,
      runningBalance: ZERO,
    });
  }

  return rows;
}

export async function getVendorLedger(
  db: PrismaClient,
  vendorId: string,
  filters: LedgerFilters = {},
): Promise<EntityLedger> {
  const all = await buildVendorRows(db, vendorId);
  return finishLedger(all, filters);
}

// ---------------------------------------------------------------------------
// Customer ledger
// ---------------------------------------------------------------------------

async function buildCustomerRows(
  db: PrismaClient,
  customerId: string,
): Promise<LedgerRow[]> {
  const [invoices, payments, creditMemos, creditApps] = await Promise.all([
    db.invoice.findMany({
      where: {
        customerId,
        deletedAt: null,
        status: { not: InvoiceStatus.VOIDED },
      },
      select: {
        id: true,
        number: true,
        invoiceDate: true,
        total: true,
        salesOrderId: true,
      },
    }),
    db.payment.findMany({
      where: {
        customerId,
        deletedAt: null,
        status: PaymentStatus.RECORDED,
        // APPLIED_CREDIT payments are credit-memo-funded; the credit memo
        // already counts. Excluding avoids double-counting.
        method: { not: PaymentMethod.APPLIED_CREDIT },
      },
      select: { id: true, number: true, receivedAt: true, amount: true },
    }),
    db.creditMemo.findMany({
      where: {
        customerId,
        deletedAt: null,
        status: CreditMemoStatus.CONFIRMED,
      },
      select: {
        id: true,
        number: true,
        issuedAt: true,
        createdAt: true,
        netCredit: true,
      },
    }),
    db.creditApplication.findMany({
      where: { reversedAt: null, invoice: { customerId } },
      select: {
        id: true,
        kind: true,
        amount: true,
        appliedAt: true,
        payment: { select: { number: true } },
        creditMemo: { select: { number: true } },
        invoice: { select: { number: true, salesOrderId: true } },
      },
    }),
  ]);

  const rows: LedgerRow[] = [];

  for (const i of invoices) {
    rows.push({
      id: `inv:${i.id}`,
      date: i.invoiceDate,
      type: 'INVOICE',
      number: i.number,
      description: `Invoice ${i.number}`,
      // Invoices have no standalone detail page — they're viewed via the SO.
      linkType: i.salesOrderId ? 'SalesOrder' : null,
      linkId: i.salesOrderId,
      debit: i.total,
      credit: ZERO,
      runningBalance: ZERO,
    });
  }

  for (const p of payments) {
    rows.push({
      id: `pmt:${p.id}`,
      date: p.receivedAt,
      type: 'CUSTOMER_PAYMENT',
      number: p.number,
      description: `Payment ${p.number}`,
      linkType: 'Payment',
      linkId: p.id,
      debit: ZERO,
      credit: p.amount,
      runningBalance: ZERO,
    });
  }

  for (const c of creditMemos) {
    rows.push({
      id: `cm:${c.id}`,
      date: c.issuedAt ?? c.createdAt,
      type: 'CREDIT_MEMO',
      number: c.number,
      description: `Credit memo ${c.number}`,
      linkType: 'CreditMemo',
      linkId: c.id,
      debit: ZERO,
      credit: c.netCredit,
      runningBalance: ZERO,
    });
  }

  for (const a of creditApps) {
    const isPayment = a.kind === CreditApplicationKind.PAYMENT_TO_INVOICE;
    const sourceNumber = isPayment
      ? (a.payment?.number ?? 'payment')
      : (a.creditMemo?.number ?? 'credit');
    rows.push({
      id: `capp:${a.id}`,
      date: a.appliedAt,
      type: 'CREDIT_APPLIED',
      number: sourceNumber,
      description: `${isPayment ? 'Payment' : 'Credit'} ${sourceNumber} applied to ${a.invoice.number}`,
      linkType: a.invoice.salesOrderId ? 'SalesOrder' : null,
      linkId: a.invoice.salesOrderId,
      debit: ZERO,
      credit: ZERO,
      runningBalance: ZERO,
    });
  }

  return rows;
}

export async function getCustomerLedger(
  db: PrismaClient,
  customerId: string,
  filters: LedgerFilters = {},
): Promise<EntityLedger> {
  const all = await buildCustomerRows(db, customerId);
  return finishLedger(all, filters);
}

// ---------------------------------------------------------------------------
// Filter parsing — shared by the tabs (searchParams Record) and the CSV
// export routes (URLSearchParams). Date strings are 'yyyy-mm-dd', parsed in
// UTC so the inclusive [from 00:00, to 23:59:59.999] window matches the
// stored timestamps.
// ---------------------------------------------------------------------------

export const VENDOR_LEDGER_TYPES: LedgerTxnType[] = [
  'BILL',
  'BILL_PAYMENT',
  'VENDOR_CREDIT',
  'VENDOR_CREDIT_APPLIED',
  'PO_DEPOSIT',
  'PO_DEPOSIT_APPLIED',
];

export const CUSTOMER_LEDGER_TYPES: LedgerTxnType[] = [
  'INVOICE',
  'CUSTOMER_PAYMENT',
  'CREDIT_MEMO',
  'CREDIT_APPLIED',
];

export function parseLedgerType(
  v: string | null | undefined,
  allowed: LedgerTxnType[],
): LedgerTxnType | undefined {
  if (!v) return undefined;
  return allowed.includes(v as LedgerTxnType) ? (v as LedgerTxnType) : undefined;
}

export function parseLedgerDate(
  v: string | null | undefined,
  endOfDay: boolean,
): Date | undefined {
  if (!v) return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return undefined;
  const [, y, mo, d] = m;
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  if (endOfDay) date.setUTCHours(23, 59, 59, 999);
  return date;
}
