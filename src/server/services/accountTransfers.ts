import { randomUUID } from 'node:crypto';
import { AccountType, AuditAction, Prisma } from '@/generated/tenant';
import type {
  JournalEntry,
  JournalEntryLine,
  PrismaClient,
} from '@/generated/tenant';
import { audit, type AuditContext } from '@/lib/audit/audit';
import { post } from '@/lib/gl/post';
import {
  postAccountTransferInputSchema,
  type PostAccountTransferInput,
} from '@/lib/validation/accountTransfers';

// =============================================================================
// Account Transfer service. Moves money between two GL accounts (bank →
// credit card, bank → bank, etc.) as one balanced journal entry:
//
//   DR <to account>   amount
//   CR <from account> amount
//
// The JE is tagged entityType='AccountTransfer' so transfers can be listed
// + drilled into separately from system-posted operational JEs and from
// the (deferred) general manual-JE path. reference + notes ride on the JE
// row's metadata columns.
// =============================================================================

export const ACCOUNT_TRANSFER_ENTITY_TYPE = 'AccountTransfer';

export type AccountTransferResult = JournalEntry & {
  lines: JournalEntryLine[];
};

export async function postAccountTransfer(
  db: PrismaClient,
  input: PostAccountTransferInput,
  ctx?: AuditContext,
): Promise<AccountTransferResult> {
  const data = postAccountTransferInputSchema.parse(input);
  if (data.fromAccountId === data.toAccountId) {
    throw new Error('From and To accounts must be different');
  }
  const amount = new Prisma.Decimal(data.amount);
  const date = data.date ?? new Date();

  return db.$transaction(async (tx) => {
    const [from, to] = await Promise.all([
      tx.glAccount.findFirst({
        where: { id: data.fromAccountId, deletedAt: null },
      }),
      tx.glAccount.findFirst({
        where: { id: data.toAccountId, deletedAt: null },
      }),
    ]);
    if (!from) throw new Error(`From account not found: ${data.fromAccountId}`);
    if (!to) throw new Error(`To account not found: ${data.toAccountId}`);

    // Transfers move money between balance-sheet money accounts only.
    // ASSET (cash/bank) and LIABILITY (credit-card payable / line of
    // credit) are valid; EQUITY/REVENUE/EXPENSE are not "money" accounts
    // and a transfer into/out of them would distort P&L.
    for (const a of [from, to]) {
      if (a.type !== AccountType.ASSET && a.type !== AccountType.LIABILITY) {
        throw new Error(
          `Account ${a.code} is ${a.type}; transfers only move money between ASSET and LIABILITY accounts`,
        );
      }
      if (!a.active) throw new Error(`GlAccount ${a.code} is inactive`);
    }

    const description = `Transfer: ${from.name} → ${to.name}`;
    const je = await post(tx, {
      entityType: ACCOUNT_TRANSFER_ENTITY_TYPE,
      // No separate entity row backs a transfer — the JE IS the record.
      // A fresh id keeps post()'s idempotency guard from ever colliding
      // (each transfer is a distinct event).
      entityId: randomUUID(),
      description,
      postedAt: date,
      lines: [
        {
          accountCode: to.code,
          debit: amount,
          memo: `Transfer in from ${from.code} ${from.name}`,
        },
        {
          accountCode: from.code,
          credit: amount,
          memo: `Transfer out to ${to.code} ${to.name}`,
        },
      ],
    });

    // Persist JE-level reference + notes. post() doesn't carry these, so
    // this is a metadata-only follow-up update — no lines, balance, or
    // sequence touched, so the GL invariants post() owns still hold.
    const updated = await tx.journalEntry.update({
      where: { id: je.id },
      data: {
        reference: data.reference?.trim() || null,
        notes: data.notes?.trim() || null,
      },
      include: { lines: true },
    });

    await audit(tx, {
      action: AuditAction.CREATE,
      entityType: ACCOUNT_TRANSFER_ENTITY_TYPE,
      entityId: je.id,
      after: updated,
      ctx,
    });

    return updated;
  });
}

// ---------------------------------------------------------------------------
// History list — JEs tagged AccountTransfer, with from/to derived from the
// credit/debit legs. Filterable by date range + either account.
// ---------------------------------------------------------------------------

export type AccountTransferListFilters = {
  fromAccountId?: string;
  toAccountId?: string;
  from?: Date; // postedAt >=
  to?: Date; // postedAt <=
  skip?: number;
  take?: number;
};

export type AccountTransferRow = {
  id: string;
  number: string;
  postedAt: Date;
  fromCode: string | null;
  fromName: string | null;
  toCode: string | null;
  toName: string | null;
  amount: Prisma.Decimal;
  reference: string | null;
  notes: string | null;
  reversedAt: Date | null;
};

export async function listAccountTransfersPaged(
  db: PrismaClient,
  filters: AccountTransferListFilters = {},
): Promise<{ rows: AccountTransferRow[]; total: number }> {
  const { skip = 0, take = 20, fromAccountId, toAccountId, from, to } = filters;

  const dateFilter: { gte?: Date; lte?: Date } = {};
  if (from) dateFilter.gte = from;
  if (to) dateFilter.lte = to;

  const where: Prisma.JournalEntryWhereInput = {
    entityType: ACCOUNT_TRANSFER_ENTITY_TYPE,
    deletedAt: null,
    ...(from || to ? { postedAt: dateFilter } : {}),
    // From = the credited leg; To = the debited leg.
    ...(fromAccountId
      ? { lines: { some: { accountId: fromAccountId, credit: { gt: 0 } } } }
      : {}),
    ...(toAccountId
      ? { lines: { some: { accountId: toAccountId, debit: { gt: 0 } } } }
      : {}),
  };

  const [entries, total] = await Promise.all([
    db.journalEntry.findMany({
      where,
      include: {
        lines: {
          include: { account: { select: { code: true, name: true } } },
        },
      },
      orderBy: [{ postedAt: 'desc' }, { createdAt: 'desc' }],
      skip,
      take: Math.min(take, 100),
    }),
    db.journalEntry.count({ where }),
  ]);

  const rows: AccountTransferRow[] = entries.map((e) => {
    const drLine = e.lines.find((l) => l.debit.greaterThan(0)) ?? null;
    const crLine = e.lines.find((l) => l.credit.greaterThan(0)) ?? null;
    return {
      id: e.id,
      number: e.number,
      postedAt: e.postedAt,
      toCode: drLine?.account.code ?? null,
      toName: drLine?.account.name ?? null,
      fromCode: crLine?.account.code ?? null,
      fromName: crLine?.account.name ?? null,
      amount: drLine?.debit ?? new Prisma.Decimal(0),
      reference: e.reference,
      notes: e.notes,
      reversedAt: e.reversedAt,
    };
  });

  return { rows, total };
}

export type AccountTransferDetail = JournalEntry & {
  lines: Array<
    JournalEntryLine & {
      account: { code: string; name: string; type: AccountType };
    }
  >;
};

export async function getAccountTransfer(
  db: PrismaClient,
  id: string,
): Promise<AccountTransferDetail | null> {
  return db.journalEntry.findFirst({
    where: { id, entityType: ACCOUNT_TRANSFER_ENTITY_TYPE, deletedAt: null },
    include: {
      lines: {
        include: {
          account: { select: { code: true, name: true, type: true } },
        },
      },
    },
  });
}
