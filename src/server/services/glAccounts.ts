import { AuditAction } from '@/generated/tenant';
import type { GlAccount, PrismaClient } from '@/generated/tenant';
import { audit, type AuditContext } from '@/lib/audit/audit';
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
    const after = await tx.glAccount.update({
      where: { id },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.active !== undefined ? { active: data.active } : {}),
      },
    });
    await audit(tx, {
      action: AuditAction.UPDATE,
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
