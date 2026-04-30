import { AuditAction, CreditMemoStatus } from '@/generated/tenant';
import type { CreditMemoCategory, PrismaClient } from '@/generated/tenant';
import { audit, type AuditContext } from '@/lib/audit/audit';
import {
  createCreditMemoCategoryInputSchema,
  updateCreditMemoCategoryInputSchema,
  type CreateCreditMemoCategoryInput,
  type UpdateCreditMemoCategoryInput,
} from '@/lib/validation/creditMemoCategories';

// Admin-managed credit-memo category dictionary. Mirrors the
// paymentTerms / glAccounts stub-service pattern. Distinct from
// CustomerCategory (which categorizes customers).
//
// `code` is immutable post-creation — see validation file for why.
// `affectsInventory` is the operationally-meaningful flag: confirmation
// of a credit memo whose category has affectsInventory=true emits a
// structured restock event for the future costing engine slice.
//
// Seeded rows (RETURN, DAMAGED, PRICING_DISPUTE, GOODWILL, CANCELLED,
// BAD_DEBT) ship with the add_invoicing_ar_core migration — only
// RETURN has affectsInventory=true.

export async function createCategory(
  db: PrismaClient,
  input: CreateCreditMemoCategoryInput,
  ctx?: AuditContext,
): Promise<CreditMemoCategory> {
  const data = createCreditMemoCategoryInputSchema.parse(input);
  return db.$transaction(async (tx) => {
    const created = await tx.creditMemoCategory.create({
      data: {
        code: data.code.trim(),
        label: data.label,
        affectsInventory: data.affectsInventory ?? false,
        active: data.active ?? true,
      },
    });
    await audit(tx, {
      action: AuditAction.CREATE,
      entityType: 'CreditMemoCategory',
      entityId: created.id,
      after: created,
      ctx,
    });
    return created;
  });
}

export async function updateCategory(
  db: PrismaClient,
  id: string,
  input: UpdateCreditMemoCategoryInput,
  ctx?: AuditContext,
): Promise<CreditMemoCategory> {
  const data = updateCreditMemoCategoryInputSchema.parse(input);
  return db.$transaction(async (tx) => {
    const before = await tx.creditMemoCategory.findUnique({ where: { id } });
    if (!before) throw new Error(`CreditMemoCategory not found: ${id}`);
    if (before.deletedAt) throw new Error('CreditMemoCategory is soft-deleted');

    const after = await tx.creditMemoCategory.update({
      where: { id },
      data: {
        ...(data.label !== undefined ? { label: data.label } : {}),
        ...(data.affectsInventory !== undefined
          ? { affectsInventory: data.affectsInventory }
          : {}),
        ...(data.active !== undefined ? { active: data.active } : {}),
      },
    });
    await audit(tx, {
      action: AuditAction.UPDATE,
      entityType: 'CreditMemoCategory',
      entityId: id,
      before,
      after,
      ctx,
    });
    return after;
  });
}

/**
 * Soft-delete a credit-memo category. Refuses if any non-deleted,
 * non-voided CreditMemo references it — historical references that
 * are voided or themselves soft-deleted don't count, since they're
 * already out of operational scope.
 */
export async function softDeleteCategory(
  db: PrismaClient,
  id: string,
  ctx?: AuditContext,
): Promise<CreditMemoCategory> {
  return db.$transaction(async (tx) => {
    const before = await tx.creditMemoCategory.findUnique({ where: { id } });
    if (!before) throw new Error(`CreditMemoCategory not found: ${id}`);
    if (before.deletedAt) throw new Error('CreditMemoCategory is already soft-deleted');

    const activeRefCount = await tx.creditMemo.count({
      where: {
        categoryId: id,
        deletedAt: null,
        status: { not: CreditMemoStatus.VOIDED },
      },
    });
    if (activeRefCount > 0) {
      throw new Error(
        `Cannot soft-delete CreditMemoCategory: ${activeRefCount} active credit memo(s) reference it; void or soft-delete them first`,
      );
    }

    const after = await tx.creditMemoCategory.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    await audit(tx, {
      action: AuditAction.DELETE,
      entityType: 'CreditMemoCategory',
      entityId: id,
      before,
      after,
      ctx,
    });
    return after;
  });
}

export async function getCategoryById(
  db: PrismaClient,
  id: string,
): Promise<CreditMemoCategory | null> {
  return db.creditMemoCategory.findFirst({ where: { id, deletedAt: null } });
}

export async function getCategoryByCode(
  db: PrismaClient,
  code: string,
): Promise<CreditMemoCategory | null> {
  return db.creditMemoCategory.findFirst({ where: { code, deletedAt: null } });
}

export async function listCategories(
  db: PrismaClient,
  filters: { active?: boolean; skip?: number; take?: number } = {},
): Promise<CreditMemoCategory[]> {
  const { skip = 0, take = 100, active } = filters;
  return db.creditMemoCategory.findMany({
    where: {
      deletedAt: null,
      ...(active !== undefined ? { active } : {}),
    },
    orderBy: { code: 'asc' },
    skip,
    take,
  });
}
