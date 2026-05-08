import { AccountType, Prisma } from '@/generated/tenant';
import type { PrismaClient } from '@/generated/tenant';

// =============================================================================
// Financial reports — slice B of phase 9.
//   - trialBalance(db, { from, to })
//   - glDetail(db, { accountCode, from, to })
//   - journalReport(db, { from, to, entityType?, accountCode? })
//
// Date semantics (per Q6 sign-off): all reports use postedAt as the
// dimension, with [from, to) half-open for activity windows. asOf is
// computed as { lt: to }. Deleted JEs are excluded; reversed JEs are
// included (they're real history; in TB they cancel out the original,
// which is the correct portrayal of the audit trail).
//
// All Decimal math via Prisma.Decimal — never JS Number. Read-only;
// these functions never mutate.
// =============================================================================

// ---------------------------------------------------------------------------
// trialBalance
// ---------------------------------------------------------------------------

export type TrialBalanceFilters = {
  // Half-open window for the period activity. `from` may be omitted to
  // mean "since system inception" (beginning balance = 0 for every
  // account; period activity = all-time activity through `to`).
  from?: Date;
  to: Date;
};

export type TrialBalanceRow = {
  accountId: string;
  accountCode: string;
  accountName: string;
  accountType: AccountType;
  // Each side is mutually exclusive — exactly one is non-zero (or both
  // zero on a flat account). Standard TB display convention.
  beginningDebit: Prisma.Decimal;
  beginningCredit: Prisma.Decimal;
  periodDebits: Prisma.Decimal;
  periodCredits: Prisma.Decimal;
  endingDebit: Prisma.Decimal;
  endingCredit: Prisma.Decimal;
};

export type TrialBalanceTotals = {
  totalBeginningDebit: Prisma.Decimal;
  totalBeginningCredit: Prisma.Decimal;
  totalPeriodDebits: Prisma.Decimal;
  totalPeriodCredits: Prisma.Decimal;
  totalEndingDebit: Prisma.Decimal;
  totalEndingCredit: Prisma.Decimal;
};

export type TrialBalanceReport = {
  asOfFrom: Date | null;
  asOfTo: Date;
  rows: TrialBalanceRow[];
  totals: TrialBalanceTotals;
};

/**
 * Computes a balanced trial balance: per-account beginning, period
 * activity, and ending balances. Asset/Expense accounts naturally
 * carry debit balances; Liability/Equity/Revenue carry credit. The
 * report shows whichever side is positive in the appropriate column.
 *
 * Invariant: SUM(endingDebit) === SUM(endingCredit) across all rows.
 * If this fails, post() has been bypassed somewhere — investigate
 * before trusting any downstream report.
 *
 * Excludes accounts with zero activity in the period AND zero
 * beginning balance (no signal to display).
 */
export async function trialBalance(
  db: PrismaClient,
  filters: TrialBalanceFilters,
): Promise<TrialBalanceReport> {
  const { from, to } = filters;

  // Beginning-balance aggregations (everything posted BEFORE `from`).
  const beginningAggs = from
    ? await db.journalEntryLine.groupBy({
        by: ['accountId'],
        where: {
          journalEntry: {
            postedAt: { lt: from },
            deletedAt: null,
          },
        },
        _sum: { debit: true, credit: true },
      })
    : [];

  // Period activity (in [from, to); when from is null, this is
  // everything through `to`, exclusive).
  const periodAggs = await db.journalEntryLine.groupBy({
    by: ['accountId'],
    where: {
      journalEntry: {
        postedAt: { ...(from ? { gte: from } : {}), lt: to },
        deletedAt: null,
      },
    },
    _sum: { debit: true, credit: true },
  });

  // Build a unified accountId set.
  const accountIds = new Set<string>();
  for (const a of beginningAggs) accountIds.add(a.accountId);
  for (const a of periodAggs) accountIds.add(a.accountId);
  if (accountIds.size === 0) {
    return {
      asOfFrom: from ?? null,
      asOfTo: to,
      rows: [],
      totals: emptyTotals(),
    };
  }

  // Single account-info fetch.
  const accounts = await db.glAccount.findMany({
    where: { id: { in: Array.from(accountIds) } },
    select: { id: true, code: true, name: true, type: true },
  });
  const accountById = new Map(accounts.map((a) => [a.id, a]));

  const beginningById = new Map(
    beginningAggs.map((a) => [
      a.accountId,
      {
        debit: a._sum.debit ?? new Prisma.Decimal(0),
        credit: a._sum.credit ?? new Prisma.Decimal(0),
      },
    ]),
  );
  const periodById = new Map(
    periodAggs.map((a) => [
      a.accountId,
      {
        debit: a._sum.debit ?? new Prisma.Decimal(0),
        credit: a._sum.credit ?? new Prisma.Decimal(0),
      },
    ]),
  );

  const totals: TrialBalanceTotals = emptyTotals();
  const rows: TrialBalanceRow[] = [];

  for (const accountId of accountIds) {
    const account = accountById.get(accountId);
    if (!account) continue; // soft-deleted account with prior activity — skip

    const beg = beginningById.get(accountId) ?? {
      debit: new Prisma.Decimal(0),
      credit: new Prisma.Decimal(0),
    };
    const per = periodById.get(accountId) ?? {
      debit: new Prisma.Decimal(0),
      credit: new Prisma.Decimal(0),
    };

    // Beginning signed = beg.debit - beg.credit
    const beginningSigned = beg.debit.minus(beg.credit);
    const endingSigned = beginningSigned.plus(per.debit).minus(per.credit);

    // Skip accounts with zero beginning AND zero period activity AND
    // zero ending — no signal worth displaying.
    if (
      beginningSigned.equals(0) &&
      per.debit.equals(0) &&
      per.credit.equals(0) &&
      endingSigned.equals(0)
    ) {
      continue;
    }

    const { debit: beginningDebit, credit: beginningCredit } =
      splitSigned(beginningSigned);
    const { debit: endingDebit, credit: endingCredit } = splitSigned(endingSigned);

    rows.push({
      accountId,
      accountCode: account.code,
      accountName: account.name,
      accountType: account.type,
      beginningDebit,
      beginningCredit,
      periodDebits: per.debit,
      periodCredits: per.credit,
      endingDebit,
      endingCredit,
    });

    totals.totalBeginningDebit = totals.totalBeginningDebit.plus(beginningDebit);
    totals.totalBeginningCredit = totals.totalBeginningCredit.plus(beginningCredit);
    totals.totalPeriodDebits = totals.totalPeriodDebits.plus(per.debit);
    totals.totalPeriodCredits = totals.totalPeriodCredits.plus(per.credit);
    totals.totalEndingDebit = totals.totalEndingDebit.plus(endingDebit);
    totals.totalEndingCredit = totals.totalEndingCredit.plus(endingCredit);
  }

  rows.sort((a, b) => a.accountCode.localeCompare(b.accountCode));

  return { asOfFrom: from ?? null, asOfTo: to, rows, totals };
}

function splitSigned(signed: Prisma.Decimal): {
  debit: Prisma.Decimal;
  credit: Prisma.Decimal;
} {
  if (signed.greaterThan(0)) {
    return { debit: signed, credit: new Prisma.Decimal(0) };
  }
  if (signed.lessThan(0)) {
    return { debit: new Prisma.Decimal(0), credit: signed.negated() };
  }
  return { debit: new Prisma.Decimal(0), credit: new Prisma.Decimal(0) };
}

function emptyTotals(): TrialBalanceTotals {
  return {
    totalBeginningDebit: new Prisma.Decimal(0),
    totalBeginningCredit: new Prisma.Decimal(0),
    totalPeriodDebits: new Prisma.Decimal(0),
    totalPeriodCredits: new Prisma.Decimal(0),
    totalEndingDebit: new Prisma.Decimal(0),
    totalEndingCredit: new Prisma.Decimal(0),
  };
}

// ---------------------------------------------------------------------------
// glDetail
// ---------------------------------------------------------------------------

export type GlDetailFilters = {
  accountCode: string;
  from?: Date;
  to: Date;
};

export type GlDetailRow = {
  jeNumber: string;
  jeId: string;
  postedAt: Date;
  description: string;
  memo: string | null;
  entityType: string;
  entityId: string;
  debit: Prisma.Decimal;
  credit: Prisma.Decimal;
  // Signed running balance (Dr − Cr cumulative). Asset/Expense
  // accounts have positive runningBalance when in their natural state.
  runningBalance: Prisma.Decimal;
};

export type GlDetailReport = {
  accountId: string;
  accountCode: string;
  accountName: string;
  accountType: AccountType;
  asOfFrom: Date | null;
  asOfTo: Date;
  beginningBalance: Prisma.Decimal; // signed
  endingBalance: Prisma.Decimal; // signed
  totalDebits: Prisma.Decimal;
  totalCredits: Prisma.Decimal;
  rows: GlDetailRow[];
};

/**
 * Per-account transaction listing for the period [from, to). Includes
 * a beginningBalance (signed Dr−Cr) computed from all activity prior
 * to `from`, and a per-row runningBalance that walks through the
 * period activity in (postedAt asc, JE number asc) order.
 *
 * Throws if accountCode does not resolve to an active GL account.
 */
export async function glDetail(
  db: PrismaClient,
  filters: GlDetailFilters,
): Promise<GlDetailReport> {
  const { accountCode, from, to } = filters;
  const account = await db.glAccount.findFirst({
    where: { code: accountCode, deletedAt: null },
    select: { id: true, code: true, name: true, type: true },
  });
  if (!account) {
    throw new Error(`GL account not found or soft-deleted: code=${accountCode}`);
  }

  // Beginning balance: signed sum of all activity before `from`.
  const beginningAgg = from
    ? await db.journalEntryLine.aggregate({
        where: {
          accountId: account.id,
          journalEntry: {
            postedAt: { lt: from },
            deletedAt: null,
          },
        },
        _sum: { debit: true, credit: true },
      })
    : null;
  const beginningBalance = beginningAgg
    ? (beginningAgg._sum.debit ?? new Prisma.Decimal(0)).minus(
        beginningAgg._sum.credit ?? new Prisma.Decimal(0),
      )
    : new Prisma.Decimal(0);

  // Period rows in chronological JE order (postedAt asc, then number asc
  // for stable ties — JE-YYYY-NNNNN is monotonic within a year).
  const lines = await db.journalEntryLine.findMany({
    where: {
      accountId: account.id,
      journalEntry: {
        postedAt: { ...(from ? { gte: from } : {}), lt: to },
        deletedAt: null,
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
        },
      },
    },
    orderBy: [
      { journalEntry: { postedAt: 'asc' } },
      { journalEntry: { number: 'asc' } },
    ],
  });

  let running = beginningBalance;
  let totalDebits = new Prisma.Decimal(0);
  let totalCredits = new Prisma.Decimal(0);
  const rows: GlDetailRow[] = lines.map((l) => {
    running = running.plus(l.debit).minus(l.credit);
    totalDebits = totalDebits.plus(l.debit);
    totalCredits = totalCredits.plus(l.credit);
    return {
      jeNumber: l.journalEntry.number,
      jeId: l.journalEntry.id,
      postedAt: l.journalEntry.postedAt,
      description: l.journalEntry.description,
      memo: l.memo,
      entityType: l.journalEntry.entityType,
      entityId: l.journalEntry.entityId,
      debit: l.debit,
      credit: l.credit,
      runningBalance: running,
    };
  });

  return {
    accountId: account.id,
    accountCode: account.code,
    accountName: account.name,
    accountType: account.type,
    asOfFrom: from ?? null,
    asOfTo: to,
    beginningBalance,
    endingBalance: running,
    totalDebits,
    totalCredits,
    rows,
  };
}

// ---------------------------------------------------------------------------
// journalReport
// ---------------------------------------------------------------------------

export type JournalReportFilters = {
  from?: Date;
  to: Date;
  entityType?: string;
  // When supplied, restricts to JEs that have at least one line on
  // the named account.
  accountCode?: string;
  skip?: number;
  take?: number;
};

export type JournalReportLine = {
  accountCode: string;
  accountName: string;
  debit: Prisma.Decimal;
  credit: Prisma.Decimal;
  memo: string | null;
};

export type JournalReportEntry = {
  id: string;
  number: string;
  postedAt: Date;
  description: string;
  entityType: string;
  entityId: string;
  reversedAt: Date | null;
  lines: JournalReportLine[];
};

export type JournalReportResult = {
  asOfFrom: Date | null;
  asOfTo: Date;
  entries: JournalReportEntry[];
};

/**
 * All JEs in the date range [from, to), optionally filtered by
 * entityType and/or accountCode. Each entry includes its full line
 * detail with account code/name resolved.
 *
 * Includes reversed JEs — they're real history. The reversedAt field
 * is exposed on each entry so consumers can render a strikethrough or
 * tag.
 */
export async function journalReport(
  db: PrismaClient,
  filters: JournalReportFilters,
): Promise<JournalReportResult> {
  const { from, to, entityType, accountCode, skip = 0, take = 200 } = filters;

  // Resolve accountCode → id once if supplied; the JE filter then uses
  // the line-level accountId via a relation predicate.
  let accountIdFilter: string | undefined;
  if (accountCode) {
    const account = await db.glAccount.findFirst({
      where: { code: accountCode, deletedAt: null },
      select: { id: true },
    });
    if (!account) {
      throw new Error(`GL account not found or soft-deleted: code=${accountCode}`);
    }
    accountIdFilter = account.id;
  }

  const jes = await db.journalEntry.findMany({
    where: {
      deletedAt: null,
      postedAt: { ...(from ? { gte: from } : {}), lt: to },
      ...(entityType ? { entityType } : {}),
      ...(accountIdFilter
        ? { lines: { some: { accountId: accountIdFilter } } }
        : {}),
    },
    include: {
      lines: {
        include: {
          account: { select: { code: true, name: true } },
        },
      },
    },
    orderBy: [{ postedAt: 'asc' }, { number: 'asc' }],
    skip,
    take: Math.min(take, 1000),
  });

  const entries: JournalReportEntry[] = jes.map((je) => ({
    id: je.id,
    number: je.number,
    postedAt: je.postedAt,
    description: je.description,
    entityType: je.entityType,
    entityId: je.entityId,
    reversedAt: je.reversedAt,
    lines: je.lines.map((l) => ({
      accountCode: l.account.code,
      accountName: l.account.name,
      debit: l.debit,
      credit: l.credit,
      memo: l.memo,
    })),
  }));

  return { asOfFrom: from ?? null, asOfTo: to, entries };
}
