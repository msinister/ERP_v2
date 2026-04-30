import { AuditAction } from '@/generated/tenant';
import type { CustomerTag, PrismaClient } from '@/generated/tenant';
import { audit, type AuditContext } from '@/lib/audit/audit';
import {
  createTagInputSchema,
  type CreateTagInput,
} from '@/lib/validation/customers';

// Free-form, autocomplete-driven tags. Tag rows are created lazily on
// first use; assignment is the meaningful operation. CustomerTag.label
// is CITEXT, so equality lookups are case-insensitive natively (e.g.
// "VIP" and "vip" collide in the unique index). substring lookups for
// the autocomplete still need mode:'insensitive' (citext only handles
// equality, not LIKE).
//
// Audit: assign + unassign emit minimal CREATE / DELETE audit rows. No
// CustomerActivity entries — tags are too low-stakes to clutter the
// customer timeline.

/**
 * Autocomplete the tag dictionary. Substring match on label, case-
 * insensitive. Empty `q` returns the most recently created tags.
 */
export async function searchTags(
  db: PrismaClient,
  q: string | undefined,
  limit: number = 25,
): Promise<CustomerTag[]> {
  return db.customerTag.findMany({
    where: q ? { label: { contains: q, mode: 'insensitive' } } : {},
    orderBy: { createdAt: 'desc' },
    take: Math.min(limit, 100),
  });
}

export async function listTagsForCustomer(
  db: PrismaClient,
  customerId: string,
): Promise<CustomerTag[]> {
  const rows = await db.customerTagAssignment.findMany({
    where: { customerId },
    include: { tag: true },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((r) => r.tag);
}

/**
 * Assign a tag (by label) to a customer. Lazily creates the
 * CustomerTag row on first use, then upserts the assignment so calling
 * this twice with the same label is idempotent.
 */
export async function assignTag(
  db: PrismaClient,
  customerId: string,
  input: CreateTagInput,
  ctx?: AuditContext,
): Promise<{ tag: CustomerTag; created: boolean }> {
  const data = createTagInputSchema.parse(input);
  return db.$transaction(async (tx) => {
    const tag = await tx.customerTag.upsert({
      where: { label: data.label },
      create: { label: data.label },
      update: {},
    });

    const existing = await tx.customerTagAssignment.findUnique({
      where: { customerId_tagId: { customerId, tagId: tag.id } },
    });
    if (existing) {
      return { tag, created: false };
    }

    await tx.customerTagAssignment.create({
      data: { customerId, tagId: tag.id },
    });
    await audit(tx, {
      action: AuditAction.CREATE,
      entityType: 'CustomerTagAssignment',
      entityId: `${customerId}:${tag.id}`,
      after: { customerId, tagId: tag.id, label: tag.label },
      ctx,
    });
    return { tag, created: true };
  });
}

/**
 * Unassign a tag from a customer by label. The CustomerTag dictionary
 * row stays — other customers may use it.
 */
export async function unassignTag(
  db: PrismaClient,
  customerId: string,
  label: string,
  ctx?: AuditContext,
): Promise<{ removed: boolean }> {
  return db.$transaction(async (tx) => {
    const tag = await tx.customerTag.findUnique({ where: { label } });
    if (!tag) return { removed: false };
    const existing = await tx.customerTagAssignment.findUnique({
      where: { customerId_tagId: { customerId, tagId: tag.id } },
    });
    if (!existing) return { removed: false };

    await tx.customerTagAssignment.delete({
      where: { customerId_tagId: { customerId, tagId: tag.id } },
    });
    await audit(tx, {
      action: AuditAction.DELETE,
      entityType: 'CustomerTagAssignment',
      entityId: `${customerId}:${tag.id}`,
      before: { customerId, tagId: tag.id, label: tag.label },
      ctx,
    });
    return { removed: true };
  });
}
