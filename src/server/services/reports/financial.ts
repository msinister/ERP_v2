import { AccountType, Prisma } from '@/generated/tenant';
import type { PrismaClient } from '@/generated/tenant';

// =============================================================================
// Financial reports.
//   Slice B:
//     - trialBalance(db, { from, to })
//     - glDetail(db, { accountCode, from, to })
//     - journalReport(db, { from, to, entityType?, accountCode? })
//   Slice C:
//     - balanceSheet(db, asOf)
//     - incomeStatement(db, { from, to })
//
// Date semantics (per Q6 sign-off): all reports use postedAt as the
// dimension, with [from, to) half-open for activity windows. asOf is
// computed as { lt: asOf }. Deleted JEs are excluded; reversed JEs are
// included (they're real history; in TB they cancel out the original,
// which is the correct portrayal of the audit trail).
//
// Sign convention for Balance Sheet / Income Statement display:
//   ASSET   / EXPENSE   → natural debit  → display = Dr − Cr
//   LIABILITY / EQUITY  → natural credit → display = Cr − Dr
//   REVENUE             → natural credit → display = Cr − Dr
// Negative display values mean an account is in its non-natural state
// (e.g., overdrawn cash, debit balance on AP). Surfaced as-is for the
// caller to render with parentheses or sign convention of choice.
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

// ---------------------------------------------------------------------------
// journalEntriesForInvoice — cross-entity JE walk for the SO detail
// "Journal entries" card. journalReport filters by entityType only;
// this helper returns every JE whose effect lands against a given
// invoice:
//
//   - entityType='Invoice', entityId=invoiceId
//       Close-time AR JE, COGS JE, void JE, COGS reversal JE.
//   - entityType='Payment', entityId IN (payment ids applied to this
//     invoice via CreditApplication kind=PAYMENT_TO_INVOICE).
//       Payment JE (DR Cash / CR AR) + payment reversal JE.
//   - entityType='CreditMemo', entityId IN (CM ids applied to this
//     invoice via CreditApplication kind=CREDIT_TO_INVOICE).
//       CM confirm JE (DR Sales Returns / CR AR + the restocking-fee
//       chargeback pair when set) and any void/offset JE the CM
//       lifecycle posts under the same entityId.
//
// Reversed applications are still counted so the operator sees the
// original JE alongside its offsetting JE — the audit trail relies on
// both being visible together.
//
// Results sorted by postedAt (oldest first) so the visual flow reads
// chronologically: close → COGS → payments → credit memos → reversals.
// ---------------------------------------------------------------------------

export async function journalEntriesForInvoice(
  db: PrismaClient,
  invoiceId: string,
): Promise<JournalReportEntry[]> {
  // CreditApplication is the single source of truth for "what touched
  // this invoice." Pull both payment-driven and credit-memo-driven
  // applications in one query, then split the source ids. Reversed
  // applications are intentionally ignored at the filter level — the
  // source JE is still in the books regardless of whether its
  // application later got unwound (the reversal is its own JE).
  const appRows = await db.creditApplication.findMany({
    where: { invoiceId },
    select: { paymentId: true, creditMemoId: true },
  });
  const paymentIds = Array.from(
    new Set(
      appRows
        .map((r) => r.paymentId)
        .filter((id): id is string => id != null),
    ),
  );
  const creditMemoIds = Array.from(
    new Set(
      appRows
        .map((r) => r.creditMemoId)
        .filter((id): id is string => id != null),
    ),
  );

  const jes = await db.journalEntry.findMany({
    where: {
      deletedAt: null,
      OR: [
        { entityType: 'Invoice', entityId: invoiceId },
        ...(paymentIds.length > 0
          ? [
              {
                entityType: 'Payment',
                entityId: { in: paymentIds },
              },
            ]
          : []),
        ...(creditMemoIds.length > 0
          ? [
              {
                entityType: 'CreditMemo',
                entityId: { in: creditMemoIds },
              },
            ]
          : []),
      ],
    },
    include: {
      lines: {
        include: {
          account: { select: { code: true, name: true } },
        },
      },
    },
    orderBy: [{ postedAt: 'asc' }, { number: 'asc' }],
  });

  return jes.map((je) => ({
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
}

// ---------------------------------------------------------------------------
// journalEntriesForEntity — all JEs posted under a single (entityType,
// entityId). Used by detail pages whose JEs post under the entity's own
// id (e.g. Payment detail: entityType='Payment', entityId=paymentId —
// covers both the cash-receipt JE and any reversal JE).
// ---------------------------------------------------------------------------

export async function journalEntriesForEntity(
  db: PrismaClient,
  entityType: string,
  entityId: string,
): Promise<JournalReportEntry[]> {
  const jes = await db.journalEntry.findMany({
    where: { deletedAt: null, entityType, entityId },
    include: {
      lines: { include: { account: { select: { code: true, name: true } } } },
    },
    orderBy: [{ postedAt: 'asc' }, { number: 'asc' }],
  });
  return jes.map((je) => ({
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
}

// ---------------------------------------------------------------------------
// balanceSheet (slice C)
// ---------------------------------------------------------------------------

export type BalanceSheetRow = {
  accountId: string;
  accountCode: string;
  accountName: string;
  // Display value at natural sign — positive = "in normal posture,"
  // negative = "abnormal" (e.g., overdrawn cash, debit balance on AP).
  // Caller decides how to render negatives.
  balance: Prisma.Decimal;
};

export type BalanceSheetSection = {
  rows: BalanceSheetRow[];
  total: Prisma.Decimal;
};

export type BalanceSheetEquitySection = {
  rows: BalanceSheetRow[]; // EQUITY-typed accounts only
  // Cumulative net income (Revenue − Expenses) through asOf, NOT yet
  // closed to retained earnings. Until year-end-close ships, this is
  // where since-inception undistributed profit appears on the BS. The
  // year-end JE that zeros revenue/expense to retained earnings will
  // collapse this into rows[] and reset currentPeriodEarnings to 0.
  currentPeriodEarnings: Prisma.Decimal;
  total: Prisma.Decimal; // sum(rows) + currentPeriodEarnings
};

export type BalanceSheetReport = {
  asOf: Date;
  assets: BalanceSheetSection;
  liabilities: BalanceSheetSection;
  equity: BalanceSheetEquitySection;
  totalLiabilitiesAndEquity: Prisma.Decimal;
  // assets.total − totalLiabilitiesAndEquity. Should be zero if every
  // post went through lib/gl/post() (which enforces SUM(Dr)=SUM(Cr)).
  // Non-zero surfaces a data-integrity issue — investigate before
  // trusting downstream reports.
  imbalance: Prisma.Decimal;
};

/**
 * Point-in-time Balance Sheet as of `asOf` (exclusive — i.e., the
 * report includes everything posted strictly before `asOf`).
 *
 * Math:
 *   Assets    = SUM(Dr − Cr) per ASSET account, displayed at natural sign
 *   Liab      = SUM(Cr − Dr) per LIABILITY account, displayed at natural sign
 *   Equity    = SUM(Cr − Dr) per EQUITY account
 *               + currentPeriodEarnings (cumulative Revenue − Expenses)
 *   Invariant: Assets total ≡ Liabilities total + Equity total.
 *              imbalance field surfaces any drift.
 */
export async function balanceSheet(
  db: PrismaClient,
  asOf: Date,
): Promise<BalanceSheetReport> {
  const aggs = await db.journalEntryLine.groupBy({
    by: ['accountId'],
    where: {
      journalEntry: {
        postedAt: { lt: asOf },
        deletedAt: null,
      },
    },
    _sum: { debit: true, credit: true },
  });

  if (aggs.length === 0) {
    return {
      asOf,
      assets: { rows: [], total: new Prisma.Decimal(0) },
      liabilities: { rows: [], total: new Prisma.Decimal(0) },
      equity: {
        rows: [],
        currentPeriodEarnings: new Prisma.Decimal(0),
        total: new Prisma.Decimal(0),
      },
      totalLiabilitiesAndEquity: new Prisma.Decimal(0),
      imbalance: new Prisma.Decimal(0),
    };
  }

  const accountIds = aggs.map((a) => a.accountId);
  const accounts = await db.glAccount.findMany({
    where: { id: { in: accountIds } },
    select: { id: true, code: true, name: true, type: true },
  });
  const accountById = new Map(accounts.map((a) => [a.id, a]));

  const assets: BalanceSheetRow[] = [];
  const liabilities: BalanceSheetRow[] = [];
  const equity: BalanceSheetRow[] = [];
  let revenueNatural = new Prisma.Decimal(0); // Cr − Dr cumulative
  let expenseNatural = new Prisma.Decimal(0); // Dr − Cr cumulative

  for (const agg of aggs) {
    const account = accountById.get(agg.accountId);
    if (!account) continue; // soft-deleted account with prior activity — skip
    const debit = agg._sum.debit ?? new Prisma.Decimal(0);
    const credit = agg._sum.credit ?? new Prisma.Decimal(0);

    switch (account.type) {
      case AccountType.ASSET: {
        const balance = debit.minus(credit);
        if (!balance.equals(0)) {
          assets.push({
            accountId: account.id,
            accountCode: account.code,
            accountName: account.name,
            balance,
          });
        }
        break;
      }
      case AccountType.LIABILITY: {
        const balance = credit.minus(debit);
        if (!balance.equals(0)) {
          liabilities.push({
            accountId: account.id,
            accountCode: account.code,
            accountName: account.name,
            balance,
          });
        }
        break;
      }
      case AccountType.EQUITY: {
        const balance = credit.minus(debit);
        if (!balance.equals(0)) {
          equity.push({
            accountId: account.id,
            accountCode: account.code,
            accountName: account.name,
            balance,
          });
        }
        break;
      }
      case AccountType.REVENUE: {
        revenueNatural = revenueNatural.plus(credit).minus(debit);
        break;
      }
      case AccountType.EXPENSE: {
        expenseNatural = expenseNatural.plus(debit).minus(credit);
        break;
      }
    }
  }

  assets.sort((a, b) => a.accountCode.localeCompare(b.accountCode));
  liabilities.sort((a, b) => a.accountCode.localeCompare(b.accountCode));
  equity.sort((a, b) => a.accountCode.localeCompare(b.accountCode));

  const assetsTotal = assets.reduce(
    (acc, r) => acc.plus(r.balance),
    new Prisma.Decimal(0),
  );
  const liabilitiesTotal = liabilities.reduce(
    (acc, r) => acc.plus(r.balance),
    new Prisma.Decimal(0),
  );
  const equityRowsTotal = equity.reduce(
    (acc, r) => acc.plus(r.balance),
    new Prisma.Decimal(0),
  );
  const currentPeriodEarnings = revenueNatural.minus(expenseNatural);
  const equityTotal = equityRowsTotal.plus(currentPeriodEarnings);
  const totalLiabilitiesAndEquity = liabilitiesTotal.plus(equityTotal);
  const imbalance = assetsTotal.minus(totalLiabilitiesAndEquity);

  return {
    asOf,
    assets: { rows: assets, total: assetsTotal },
    liabilities: { rows: liabilities, total: liabilitiesTotal },
    equity: { rows: equity, currentPeriodEarnings, total: equityTotal },
    totalLiabilitiesAndEquity,
    imbalance,
  };
}

// ---------------------------------------------------------------------------
// incomeStatement (slice C)
// ---------------------------------------------------------------------------

export type IncomeStatementFilters = {
  from?: Date;
  to: Date;
};

export type IncomeStatementRow = {
  accountId: string;
  accountCode: string;
  accountName: string;
  // Natural-sign activity in [from, to). Revenue: Cr − Dr (positive =
  // income). Expense: Dr − Cr (positive = expense). Negative values
  // are correct accounting (e.g., a return JE that DRs revenue shows
  // as negative revenue activity, which is the right portrayal).
  amount: Prisma.Decimal;
};

export type IncomeStatementSection = {
  rows: IncomeStatementRow[];
  total: Prisma.Decimal;
};

export type IncomeStatementReport = {
  asOfFrom: Date | null;
  asOfTo: Date;
  revenue: IncomeStatementSection;
  expenses: IncomeStatementSection;
  netIncome: Prisma.Decimal; // revenue.total − expenses.total
};

/**
 * Period Income Statement (Revenue − Expenses) for [from, to). Half-
 * open window; `from` may be omitted to mean "since system inception."
 *
 * Excludes accounts with zero activity in the window.
 */
export async function incomeStatement(
  db: PrismaClient,
  filters: IncomeStatementFilters,
): Promise<IncomeStatementReport> {
  const { from, to } = filters;

  const aggs = await db.journalEntryLine.groupBy({
    by: ['accountId'],
    where: {
      journalEntry: {
        postedAt: { ...(from ? { gte: from } : {}), lt: to },
        deletedAt: null,
      },
    },
    _sum: { debit: true, credit: true },
  });

  if (aggs.length === 0) {
    return {
      asOfFrom: from ?? null,
      asOfTo: to,
      revenue: { rows: [], total: new Prisma.Decimal(0) },
      expenses: { rows: [], total: new Prisma.Decimal(0) },
      netIncome: new Prisma.Decimal(0),
    };
  }

  // Restrict to revenue/expense accounts only — no need to fetch ASSET/
  // LIABILITY/EQUITY accounts for the IS.
  const accountIds = aggs.map((a) => a.accountId);
  const accounts = await db.glAccount.findMany({
    where: {
      id: { in: accountIds },
      type: { in: [AccountType.REVENUE, AccountType.EXPENSE] },
    },
    select: { id: true, code: true, name: true, type: true },
  });
  const accountById = new Map(accounts.map((a) => [a.id, a]));

  const revenue: IncomeStatementRow[] = [];
  const expenses: IncomeStatementRow[] = [];

  for (const agg of aggs) {
    const account = accountById.get(agg.accountId);
    if (!account) continue; // not a revenue/expense account — skip
    const debit = agg._sum.debit ?? new Prisma.Decimal(0);
    const credit = agg._sum.credit ?? new Prisma.Decimal(0);

    if (account.type === AccountType.REVENUE) {
      const amount = credit.minus(debit);
      if (!amount.equals(0)) {
        revenue.push({
          accountId: account.id,
          accountCode: account.code,
          accountName: account.name,
          amount,
        });
      }
    } else if (account.type === AccountType.EXPENSE) {
      const amount = debit.minus(credit);
      if (!amount.equals(0)) {
        expenses.push({
          accountId: account.id,
          accountCode: account.code,
          accountName: account.name,
          amount,
        });
      }
    }
  }

  revenue.sort((a, b) => a.accountCode.localeCompare(b.accountCode));
  expenses.sort((a, b) => a.accountCode.localeCompare(b.accountCode));

  const revenueTotal = revenue.reduce(
    (acc, r) => acc.plus(r.amount),
    new Prisma.Decimal(0),
  );
  const expensesTotal = expenses.reduce(
    (acc, r) => acc.plus(r.amount),
    new Prisma.Decimal(0),
  );
  const netIncome = revenueTotal.minus(expensesTotal);

  return {
    asOfFrom: from ?? null,
    asOfTo: to,
    revenue: { rows: revenue, total: revenueTotal },
    expenses: { rows: expenses, total: expensesTotal },
    netIncome,
  };
}
