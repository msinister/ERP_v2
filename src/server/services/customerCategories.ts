import { AuditAction, Prisma } from '@/generated/tenant';
import type { CustomerCategory, PrismaClient } from '@/generated/tenant';
import { audit, type AuditContext } from '@/lib/audit/audit';
import {
  createCategoryInputSchema,
  updateCategoryInputSchema,
  type CreateCategoryInput,
  type UpdateCategoryInput,
} from '@/lib/validation/customers';

// Pre-made customer categories — admin-managed dictionary. Distinct
// from CustomerTag (which is sales-rep-driven, free-form, label-only).
// Categories have a stable `code` admins can reference in scripts and
// imports. Soft-delete on a category hides it from new assignments
// while preserving the historical assignment rows.

// ---------------------------------------------------------------------------
// Dictionary CRUD
// ---------------------------------------------------------------------------

export async function createCategory(
  db: PrismaClient,
  input: CreateCategoryInput,
  ctx?: AuditContext,
): Promise<CustomerCategory> {
  const data = createCategoryInputSchema.parse(input);
  return db.$transaction(async (tx) => {
    const created = await tx.customerCategory.create({
      data: {
        code: data.code.trim().toUpperCase(),
        label: data.label,
        active: data.active ?? true,
      },
    });
    await audit(tx, {
      action: AuditAction.CREATE,
      entityType: 'CustomerCategory',
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
  input: UpdateCategoryInput,
  ctx?: AuditContext,
): Promise<CustomerCategory> {
  const data = updateCategoryInputSchema.parse(input);
  return db.$transaction(async (tx) => {
    const before = await tx.customerCategory.findUnique({ where: { id } });
    if (!before) throw new Error(`CustomerCategory not found: ${id}`);
    if (before.deletedAt) throw new Error('CustomerCategory is soft-deleted');

    const updateData: Prisma.CustomerCategoryUpdateInput = {};
    if (data.label !== undefined) updateData.label = data.label;
    if (data.active !== undefined) updateData.active = data.active;

    const after = await tx.customerCategory.update({ where: { id }, data: updateData });
    await audit(tx, {
      action: AuditAction.UPDATE,
      entityType: 'CustomerCategory',
      entityId: id,
      before,
      after,
      ctx,
    });
    return after;
  });
}

export async function softDeleteCategory(
  db: PrismaClient,
  id: string,
  ctx?: AuditContext,
): Promise<CustomerCategory> {
  return db.$transaction(async (tx) => {
    const before = await tx.customerCategory.findUnique({ where: { id } });
    if (!before) throw new Error(`CustomerCategory not found: ${id}`);
    if (before.deletedAt) throw new Error('CustomerCategory is already soft-deleted');
    const after = await tx.customerCategory.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    await audit(tx, {
      action: AuditAction.DELETE,
      entityType: 'CustomerCategory',
      entityId: id,
      before,
      after,
      ctx,
    });
    return after;
  });
}

export async function getCategory(
  db: PrismaClient,
  id: string,
): Promise<CustomerCategory | null> {
  return db.customerCategory.findFirst({ where: { id, deletedAt: null } });
}

export async function listCategories(
  db: PrismaClient,
  filters: { active?: boolean; skip?: number; take?: number } = {},
): Promise<CustomerCategory[]> {
  const { skip = 0, take = 100, active } = filters;
  return db.customerCategory.findMany({
    where: {
      deletedAt: null,
      ...(active !== undefined ? { active } : {}),
    },
    orderBy: { code: 'asc' },
    skip,
    take,
  });
}

// ---------------------------------------------------------------------------
// Assignment helpers
// ---------------------------------------------------------------------------

/**
 * Assign a category to a customer. Refuses if the category is soft-
 * deleted (assignments to dead categories don't make sense; existing
 * historical assignments are preserved separately by the listing
 * filter). Idempotent: assigning twice is a no-op.
 */
export async function assignCategory(
  db: PrismaClient,
  customerId: string,
  categoryId: string,
  ctx?: AuditContext,
): Promise<{ created: boolean }> {
  return db.$transaction(async (tx) => {
    const category = await tx.customerCategory.findUnique({ where: { id: categoryId } });
    if (!category) throw new Error(`CustomerCategory not found: ${categoryId}`);
    if (category.deletedAt) {
      throw new Error('Cannot assign a soft-deleted category');
    }

    const existing = await tx.customerCategoryAssignment.findUnique({
      where: { customerId_categoryId: { customerId, categoryId } },
    });
    if (existing) return { created: false };

    await tx.customerCategoryAssignment.create({
      data: { customerId, categoryId },
    });
    await audit(tx, {
      action: AuditAction.CREATE,
      entityType: 'CustomerCategoryAssignment',
      entityId: `${customerId}:${categoryId}`,
      after: { customerId, categoryId, code: category.code },
      ctx,
    });
    return { created: true };
  });
}

export async function unassignCategory(
  db: PrismaClient,
  customerId: string,
  categoryId: string,
  ctx?: AuditContext,
): Promise<{ removed: boolean }> {
  return db.$transaction(async (tx) => {
    const existing = await tx.customerCategoryAssignment.findUnique({
      where: { customerId_categoryId: { customerId, categoryId } },
    });
    if (!existing) return { removed: false };
    await tx.customerCategoryAssignment.delete({
      where: { customerId_categoryId: { customerId, categoryId } },
    });
    await audit(tx, {
      action: AuditAction.DELETE,
      entityType: 'CustomerCategoryAssignment',
      entityId: `${customerId}:${categoryId}`,
      before: { customerId, categoryId },
      ctx,
    });
    return { removed: true };
  });
}

/**
 * List a customer's assigned categories. Excludes assignments whose
 * category has been soft-deleted, so the customer page never shows
 * stale entries for retired categories. Historical assignment rows
 * are preserved at the DB level — re-activating the category brings
 * them back into the list.
 */
export async function listCategoriesForCustomer(
  db: PrismaClient,
  customerId: string,
): Promise<CustomerCategory[]> {
  const rows = await db.customerCategoryAssignment.findMany({
    where: {
      customerId,
      category: { deletedAt: null },
    },
    include: { category: true },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((r) => r.category);
}
