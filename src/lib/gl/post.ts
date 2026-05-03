import { Prisma } from '@/generated/tenant';
import type { JournalEntry, JournalEntryLine } from '@/generated/tenant';
import { getNextSequence } from '@/lib/sequences/sequences';

/**
 * Foundational journal-entry posting helper. Every operational event
 * that needs to write to the GL goes through this function — invoice
 * generation, payment received, credit memo confirmed, etc. The full
 * GL service slice will add manual JE entry from the admin UI; that
 * path also goes through here.
 *
 * Contract:
 *   - SUM(debits) === SUM(credits) at full Decimal precision. Throws
 *     a specific error naming the imbalance if not balanced.
 *   - Each line has exactly one of debit XOR credit non-zero. Both >= 0.
 *     Throws if both > 0, both 0, or either negative.
 *   - Account lookup by code via findFirst with deletedAt: null. Throws
 *     a specific error naming the missing code if not found or
 *     soft-deleted.
 *   - JE number allocated via getNextSequence ('journal_entry' /
 *     'JE' / annual reset → JE-YYYY-NNNNN).
 *   - Idempotency: if a non-reversed JE already exists for
 *     (entityType, entityId, description) the call throws naming the
 *     existing number. Reversed prior JEs do NOT block a fresh post —
 *     reversal posting (creating offsetting JEs when an entity is
 *     voided) is the caller's responsibility (compose two post()
 *     calls), not this helper's.
 *
 * IMPORTANT — this is the ONLY way to create JournalEntry rows.
 * Services must NEVER call tx.journalEntry.create directly. Bypassing
 * this helper bypasses the balance check, idempotency guard, and
 * sequence numbering — all three are GL invariants.
 */

const JE_SEQUENCE_NAME = 'journal_entry';
const JE_PREFIX = 'JE';

export type PostInputLine = {
  accountCode: string;
  // Both default to 0 if omitted. Exactly one must be > 0.
  debit?: Prisma.Decimal | string | number;
  credit?: Prisma.Decimal | string | number;
  memo?: string;
};

export type PostInput = {
  entityType: string; // 'Invoice' / 'Payment' / 'CreditMemo' / etc.
  entityId: string;
  description: string;
  lines: PostInputLine[];
  // Optional business-event date for the JE. When omitted, falls through
  // to the schema's @default(now()) for postedAt. Late-landed-cost
  // adjustments (Part 4 of the costing engine slice) backdate this to
  // the original CONSUME movement's createdAt for period-correct COGS
  // reporting per docs/08-gl-costing-reporting.md:167. createdAt is
  // never overridden — it stays at insertion time as audit history.
  postedAt?: Date;
};

export type PostedJournalEntry = JournalEntry & { lines: JournalEntryLine[] };

function toDecimal(v: Prisma.Decimal | string | number | undefined): Prisma.Decimal {
  if (v == null) return new Prisma.Decimal(0);
  if (v instanceof Prisma.Decimal) return v;
  return new Prisma.Decimal(v);
}

export async function post(
  tx: Prisma.TransactionClient,
  input: PostInput,
): Promise<PostedJournalEntry> {
  if (input.lines.length === 0) {
    throw new Error('post(): JE must have at least one line');
  }

  // 1. Per-line XOR + non-negative validation. Use Decimal math.
  let debitTotal = new Prisma.Decimal(0);
  let creditTotal = new Prisma.Decimal(0);
  for (let i = 0; i < input.lines.length; i++) {
    const line = input.lines[i];
    const debit = toDecimal(line.debit);
    const credit = toDecimal(line.credit);
    if (debit.lessThan(0) || credit.lessThan(0)) {
      throw new Error(
        `post(): line ${i} has negative amount (debit=${debit.toString()} credit=${credit.toString()}); both must be >= 0`,
      );
    }
    const debitNonZero = debit.greaterThan(0);
    const creditNonZero = credit.greaterThan(0);
    if (debitNonZero && creditNonZero) {
      throw new Error(
        `post(): line ${i} has BOTH debit and credit non-zero (debit=${debit.toString()} credit=${credit.toString()}); each line must be debit XOR credit`,
      );
    }
    if (!debitNonZero && !creditNonZero) {
      throw new Error(
        `post(): line ${i} has BOTH debit and credit zero; each line must have exactly one side`,
      );
    }
    debitTotal = debitTotal.plus(debit);
    creditTotal = creditTotal.plus(credit);
  }

  // 2. Balance check at full Decimal precision.
  if (!debitTotal.equals(creditTotal)) {
    throw new Error(
      `post(): JE not balanced — debits=${debitTotal.toString()} credits=${creditTotal.toString()} difference=${debitTotal.minus(creditTotal).toString()}`,
    );
  }

  // 3. Idempotency: refuse if a non-reversed JE already exists for the
  //    same operational event. Reversed prior JEs do not block.
  const existing = await tx.journalEntry.findFirst({
    where: {
      entityType: input.entityType,
      entityId: input.entityId,
      description: input.description,
      reversedAt: null,
      deletedAt: null,
    },
    select: { id: true, number: true },
  });
  if (existing) {
    throw new Error(
      `post(): journal entry already posted for this event (entityType=${input.entityType} entityId=${input.entityId} description='${input.description}' existing=${existing.number})`,
    );
  }

  // 4. Resolve account codes → ids. Single batched query.
  const codes = Array.from(new Set(input.lines.map((l) => l.accountCode)));
  const accounts = await tx.glAccount.findMany({
    where: { code: { in: codes }, deletedAt: null },
    select: { id: true, code: true },
  });
  const codeToId = new Map(accounts.map((a) => [a.code, a.id]));
  for (const code of codes) {
    if (!codeToId.has(code)) {
      throw new Error(
        `post(): GL account not found or soft-deleted: code=${code}`,
      );
    }
  }

  // 5. Allocate JE number.
  const seq = await getNextSequence(tx, {
    name: JE_SEQUENCE_NAME,
    prefix: JE_PREFIX,
    useYear: true,
  });

  // 6. Create the JournalEntry + lines in one statement.
  const created = await tx.journalEntry.create({
    data: {
      number: seq.formatted,
      entityType: input.entityType,
      entityId: input.entityId,
      description: input.description,
      // Backdating: when caller supplies postedAt, use it; otherwise omit
      // so Prisma uses the schema's @default(now()). createdAt is NEVER
      // overridden — that field is row-insertion timestamp, not a
      // business date. See PostInput.postedAt comment.
      ...(input.postedAt ? { postedAt: input.postedAt } : {}),
      lines: {
        create: input.lines.map((line) => ({
          accountId: codeToId.get(line.accountCode)!,
          debit: toDecimal(line.debit),
          credit: toDecimal(line.credit),
          memo: line.memo ?? null,
        })),
      },
    },
    include: { lines: true },
  });

  return created;
}
