import { AccountType, Prisma } from '@/generated/tenant';
import type { PrismaClient } from '@/generated/tenant';

// =============================================================================
// GL Account Ledger — a per-account transaction register (detailed Dr/Cr
// listing with a running balance), focused on cash + credit-card accounts.
// Read-only: every number derives from posted JournalEntryLine rows. Balance
// sign convention is "signed" = SUM(debit) − SUM(credit); the UI converts to
// a natural (display) balance per account type.
// =============================================================================

const ZERO = new Prisma.Decimal(0);
const MONEY_TYPES = [AccountType.ASSET, AccountType.LIABILITY];

export type LedgerAccount = {
  id: string;
  code: string;
  name: string;
  type: AccountType;
};

export type LedgerAccountWithBalance = LedgerAccount & {
  // Signed Dr − Cr across all (non-deleted) JE activity.
  signedBalance: Prisma.Decimal;
};

// All GL accounts for the selector, ordered by type (enum order →
// ASSET, LIABILITY, EQUITY, REVENUE, EXPENSE) then code.
export async function listGlAccountsForLedger(
  db: PrismaClient,
): Promise<LedgerAccount[]> {
  return db.glAccount.findMany({
    where: { deletedAt: null },
    orderBy: [{ type: 'asc' }, { code: 'asc' }],
    select: { id: true, code: true, name: true, type: true },
  });
}

// Cash (ASSET) + credit-card / other LIABILITY accounts with current
// balances — drives the overview grid + quick-filter buckets. Code-range
// bucketing (1100-1199 cash, 2100-2199 cards) is applied in the page; the
// chart numbering is per-tenant so the service stays range-agnostic.
export async function listMoneyAccountsWithBalances(
  db: PrismaClient,
): Promise<LedgerAccountWithBalance[]> {
  const accounts = await db.glAccount.findMany({
    where: { deletedAt: null, type: { in: MONEY_TYPES } },
    orderBy: [{ type: 'asc' }, { code: 'asc' }],
    select: { id: true, code: true, name: true, type: true },
  });
  if (accounts.length === 0) return [];

  const grouped = await db.journalEntryLine.groupBy({
    by: ['accountId'],
    where: {
      accountId: { in: accounts.map((a) => a.id) },
      journalEntry: { deletedAt: null },
    },
    _sum: { debit: true, credit: true },
  });
  const balById = new Map<string, Prisma.Decimal>(
    grouped.map((g) => [
      g.accountId,
      (g._sum.debit ?? ZERO).minus(g._sum.credit ?? ZERO),
    ]),
  );

  return accounts.map((a) => ({
    ...a,
    signedBalance: balById.get(a.id) ?? ZERO,
  }));
}

export type LedgerRow = {
  jeId: string;
  jeNumber: string;
  postedAt: Date;
  description: string;
  memo: string | null;
  reference: string | null;
  entityType: string;
  entityId: string;
  // Resolved id to deep-link the source entity (BillPayment → its bill,
  // AccountTransfer → the JE itself, otherwise entityId). Null when the
  // source has no detail page. The page maps entityType → route prefix.
  linkId: string | null;
  debit: Prisma.Decimal;
  credit: Prisma.Decimal;
  // Signed Dr − Cr cumulative through this row (chronological), including
  // the beginning balance carried in from before the date window.
  signedRunningBalance: Prisma.Decimal;
};

export type AccountLedgerFilters = {
  accountId: string;
  from?: Date;
  to?: Date;
  skip?: number;
  take?: number;
};

export type AccountLedger = {
  account: LedgerAccount;
  // All-time signed balance (independent of the date filter) for the
  // prominent summary number.
  currentSignedBalance: Prisma.Decimal;
  rows: LedgerRow[]; // page slice, newest-first
  total: number; // rows in the filtered window
  periodDebits: Prisma.Decimal;
  periodCredits: Prisma.Decimal;
};

type ChronoBuild = {
  account: LedgerAccount;
  currentSignedBalance: Prisma.Decimal;
  // Newest-first, every row in the window, with running balance.
  rows: Omit<LedgerRow, 'linkId'>[];
  periodDebits: Prisma.Decimal;
  periodCredits: Prisma.Decimal;
};

// Core builder: every row in the window (newest-first) with a correct
// running balance carried from the pre-window beginning balance. Shared by
// the paginated page view and the (unpaginated) CSV export.
async function buildLedger(
  db: PrismaClient,
  account: LedgerAccount,
  from?: Date,
  to?: Date,
): Promise<ChronoBuild> {
  const allAgg = await db.journalEntryLine.aggregate({
    where: { accountId: account.id, journalEntry: { deletedAt: null } },
    _sum: { debit: true, credit: true },
  });
  const currentSignedBalance = (allAgg._sum.debit ?? ZERO).minus(
    allAgg._sum.credit ?? ZERO,
  );

  // Beginning balance = signed activity strictly before the window start.
  let beginning = ZERO;
  if (from) {
    const begAgg = await db.journalEntryLine.aggregate({
      where: {
        accountId: account.id,
        journalEntry: { deletedAt: null, postedAt: { lt: from } },
      },
      _sum: { debit: true, credit: true },
    });
    beginning = (begAgg._sum.debit ?? ZERO).minus(begAgg._sum.credit ?? ZERO);
  }

  const lines = await db.journalEntryLine.findMany({
    where: {
      accountId: account.id,
      journalEntry: {
        deletedAt: null,
        postedAt: {
          ...(from ? { gte: from } : {}),
          ...(to ? { lte: to } : {}),
        },
      },
    },
    include: {
      journalEntry: {
        select: {
          id: true,
          number: true,
          postedAt: true,
          description: true,
          entityType: true,
          entityId: true,
          reference: true,
        },
      },
    },
    orderBy: [
      { journalEntry: { postedAt: 'asc' } },
      { journalEntry: { number: 'asc' } },
    ],
  });

  let running = beginning;
  let periodDebits = ZERO;
  let periodCredits = ZERO;
  const chrono: Omit<LedgerRow, 'linkId'>[] = lines.map((l) => {
    running = running.plus(l.debit).minus(l.credit);
    periodDebits = periodDebits.plus(l.debit);
    periodCredits = periodCredits.plus(l.credit);
    return {
      jeId: l.journalEntry.id,
      jeNumber: l.journalEntry.number,
      postedAt: l.journalEntry.postedAt,
      description: l.journalEntry.description,
      memo: l.memo,
      reference: l.journalEntry.reference,
      entityType: l.journalEntry.entityType,
      entityId: l.journalEntry.entityId,
      debit: l.debit,
      credit: l.credit,
      signedRunningBalance: running,
    };
  });

  chrono.reverse(); // newest-first for display
  return {
    account,
    currentSignedBalance,
    rows: chrono,
    periodDebits,
    periodCredits,
  };
}

// Resolve the deep-link id for the page's rows. Most entityTypes link by
// entityId; AccountTransfer's entityId is a synthetic uuid (its detail page
// keys off the JE id); BillPayment's entityId is the payment row, so we
// hop to its bill. Batched so it stays one query per special type.
async function resolveLinkIds(
  db: PrismaClient,
  rows: Omit<LedgerRow, 'linkId'>[],
): Promise<LedgerRow[]> {
  const billPaymentIds = rows
    .filter((r) => r.entityType === 'BillPayment')
    .map((r) => r.entityId);
  const billByPaymentId = new Map<string, string>();
  if (billPaymentIds.length > 0) {
    const pays = await db.billPayment.findMany({
      where: { id: { in: billPaymentIds } },
      select: { id: true, billId: true },
    });
    for (const p of pays) billByPaymentId.set(p.id, p.billId);
  }

  return rows.map((r) => {
    let linkId: string | null;
    if (r.entityType === 'AccountTransfer') linkId = r.jeId;
    else if (r.entityType === 'BillPayment')
      linkId = billByPaymentId.get(r.entityId) ?? null;
    else linkId = r.entityId;
    return { ...r, linkId };
  });
}

export async function getAccountLedger(
  db: PrismaClient,
  filters: AccountLedgerFilters,
): Promise<AccountLedger | null> {
  const { accountId, from, to, skip = 0, take = 50 } = filters;
  const account = await db.glAccount.findFirst({
    where: { id: accountId, deletedAt: null },
    select: { id: true, code: true, name: true, type: true },
  });
  if (!account) return null;

  const built = await buildLedger(db, account, from, to);
  const pageRows = built.rows.slice(skip, skip + take);
  const rows = await resolveLinkIds(db, pageRows);

  return {
    account,
    currentSignedBalance: built.currentSignedBalance,
    rows,
    total: built.rows.length,
    periodDebits: built.periodDebits,
    periodCredits: built.periodCredits,
  };
}

export type AccountLedgerExport = {
  account: LedgerAccount;
  rows: Omit<LedgerRow, 'linkId'>[]; // all rows in the window, newest-first
};

export async function exportAccountLedger(
  db: PrismaClient,
  filters: { accountId: string; from?: Date; to?: Date },
): Promise<AccountLedgerExport | null> {
  const account = await db.glAccount.findFirst({
    where: { id: filters.accountId, deletedAt: null },
    select: { id: true, code: true, name: true, type: true },
  });
  if (!account) return null;
  const built = await buildLedger(db, account, filters.from, filters.to);
  return { account, rows: built.rows };
}

// ---------------------------------------------------------------------------
// Display helpers (signed → natural). Debit-normal accounts (ASSET/EXPENSE)
// read their signed balance directly; credit-normal accounts (LIABILITY/
// EQUITY/REVENUE) negate it so a credit balance reads positive.
// ---------------------------------------------------------------------------

export function isDebitNormal(type: AccountType): boolean {
  return type === AccountType.ASSET || type === AccountType.EXPENSE;
}

export function naturalBalance(
  signed: Prisma.Decimal,
  type: AccountType,
): Prisma.Decimal {
  return isDebitNormal(type) ? signed : signed.negated();
}
