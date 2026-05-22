import { AuditAction, FiscalPeriodStatus, Prisma } from '@/generated/tenant';
import type { GlAccount, PrismaClient } from '@/generated/tenant';
import { audit, type AuditContext } from '@/lib/audit/audit';
import { periodCodeForDate } from '@/server/services/fiscalPeriods';
import {
  createGlAccountInputSchema,
  updateGlAccountInputSchema,
  type CreateGlAccountInput,
  type UpdateGlAccountInput,
} from '@/lib/validation/glAccounts';

// GL account stub service — minimum CRUD admin needs to see the seeded
// chart of accounts, add bespoke accounts, and rename them. The full
// GL service slice (hierarchy / parent-child / period close / manual
// JE entry / admin reversal with closed-period gating) lives in its
// own slice (Module 7, docs/08-gl-costing-reporting.md).
//
// JE creation does NOT happen here — services use lib/gl/post() which
// is the only sanctioned path for inserting JournalEntry rows.

export async function createAccount(
  db: PrismaClient,
  input: CreateGlAccountInput,
  ctx?: AuditContext,
): Promise<GlAccount> {
  const data = createGlAccountInputSchema.parse(input);
  return db.$transaction(async (tx) => {
    const account = await tx.glAccount.create({
      data: {
        code: data.code.trim(),
        name: data.name,
        type: data.type,
        active: data.active ?? true,
      },
    });
    await audit(tx, {
      action: AuditAction.CREATE,
      entityType: 'GlAccount',
      entityId: account.id,
      after: account,
      ctx,
    });
    return account;
  });
}

export async function updateAccount(
  db: PrismaClient,
  id: string,
  input: UpdateGlAccountInput,
  ctx?: AuditContext,
): Promise<GlAccount> {
  const data = updateGlAccountInputSchema.parse(input);
  return db.$transaction(async (tx) => {
    const before = await tx.glAccount.findUnique({ where: { id } });
    if (!before) throw new Error(`GlAccount not found: ${id}`);
    if (before.deletedAt) throw new Error('GlAccount is soft-deleted');

    // Reclassify gate. A type change retroactively changes how every
    // historical JE on this account is reported (the balance sheet/income
    // statement section it lands in, and its natural debit-vs-credit sign).
    // Refuse if any referencing JE falls in a HARD_CLOSED period — those
    // financials are signed off and a silent reclassify would alter them.
    // SOFT_CLOSED is allowed (mirrors assertPostingAllowedTx, which still
    // accepts posts into SOFT_CLOSED periods in pilot scope).
    const typeChanging = data.type !== undefined && data.type !== before.type;
    if (typeChanging) {
      await assertNoHardClosedJEsTx(tx, id);
    }

    const after = await tx.glAccount.update({
      where: { id },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(typeChanging ? { type: data.type } : {}),
        ...(data.active !== undefined ? { active: data.active } : {}),
      },
    });
    await audit(tx, {
      // A reclassification is a chart-of-accounts config change — tag it
      // CONFIG_CHANGE so audit reports can isolate reclassifies from
      // routine name/active edits. The before/after diff carries the
      // type transition either way.
      action: typeChanging ? AuditAction.CONFIG_CHANGE : AuditAction.UPDATE,
      entityType: 'GlAccount',
      entityId: id,
      before,
      after,
      ctx,
    });
    return after;
  });
}

/**
 * Throws if any JournalEntryLine on `accountId` belongs to a JE whose
 * postedAt falls in a HARD_CLOSED fiscal period. Used to gate account
 * type reclassification. Periods that were never created (no close
 * record) are treated as OPEN, consistent with the lazy-bootstrap model
 * in fiscalPeriods.ts.
 */
async function assertNoHardClosedJEsTx(
  tx: Prisma.TransactionClient,
  accountId: string,
): Promise<void> {
  const lines = await tx.journalEntryLine.findMany({
    where: { accountId },
    select: { journalEntry: { select: { postedAt: true } } },
  });
  if (lines.length === 0) return;

  const periodCodes = Array.from(
    new Set(lines.map((l) => periodCodeForDate(l.journalEntry.postedAt))),
  );
  const closed = await tx.fiscalPeriod.findMany({
    where: {
      code: { in: periodCodes },
      status: FiscalPeriodStatus.HARD_CLOSED,
    },
    select: { code: true },
    orderBy: { code: 'asc' },
  });
  if (closed.length > 0) {
    throw new Error(
      `Cannot change account type: ${closed.length} hard-closed period(s) ` +
        `have journal entries on this account (${closed
          .map((p) => p.code)
          .join(', ')}). Reopen the period(s) first or leave the type as-is.`,
    );
  }
}

/**
 * Soft-delete a GL account. Refuses if ANY JournalEntryLine
 * references it — including lines on reversed JEs. Stub-slice
 * stance is conservative: soft-delete is for genuinely-unused
 * accounts only. The GL service slice can relax this once
 * period-close rules are in place (e.g., allow soft-delete if
 * every referencing JE is in a closed period and there's no
 * activity in the current period).
 */
export async function softDeleteAccount(
  db: PrismaClient,
  id: string,
  ctx?: AuditContext,
): Promise<GlAccount> {
  return db.$transaction(async (tx) => {
    const before = await tx.glAccount.findUnique({ where: { id } });
    if (!before) throw new Error(`GlAccount not found: ${id}`);
    if (before.deletedAt) throw new Error('GlAccount is already soft-deleted');

    const refCount = await tx.journalEntryLine.count({
      where: { accountId: id },
    });
    if (refCount > 0) {
      throw new Error(
        `Cannot soft-delete GlAccount: ${refCount} journal entry line(s) reference it`,
      );
    }

    const after = await tx.glAccount.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    await audit(tx, {
      action: AuditAction.DELETE,
      entityType: 'GlAccount',
      entityId: id,
      before,
      after,
      ctx,
    });
    return after;
  });
}

export async function getAccount(
  db: PrismaClient,
  id: string,
): Promise<GlAccount | null> {
  return db.glAccount.findFirst({ where: { id, deletedAt: null } });
}

export async function getAccountByCode(
  db: PrismaClient,
  code: string,
): Promise<GlAccount | null> {
  return db.glAccount.findFirst({ where: { code, deletedAt: null } });
}

export async function listAccounts(
  db: PrismaClient,
  filters: { active?: boolean; skip?: number; take?: number } = {},
): Promise<GlAccount[]> {
  const { skip = 0, take = 200, active } = filters;
  return db.glAccount.findMany({
    where: {
      deletedAt: null,
      ...(active !== undefined ? { active } : {}),
    },
    orderBy: { code: 'asc' },
    skip,
    take,
  });
}
