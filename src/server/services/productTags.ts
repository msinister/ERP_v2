import { AuditAction } from '@/generated/tenant';
import type { Tag, PrismaClient } from '@/generated/tenant';
import { audit, type AuditContext } from '@/lib/audit/audit';
import {
  productTagNameSchema,
  type ProductTagsPatchInput,
} from '@/lib/validation/product';

// =============================================================================
// Global product tags. Tag rows are shared across all products and created
// lazily on first use. Tag.name is CITEXT so equality is case-insensitive
// natively; substring autocomplete still needs mode:'insensitive'.
//
// Assign/unassign emit minimal CREATE / DELETE audit rows on ProductTag.
// =============================================================================

// Autocomplete the global tag dictionary. Empty q → most recent tags.
export async function searchTags(
  db: PrismaClient,
  q: string | undefined,
  limit: number = 25,
): Promise<Tag[]> {
  return db.tag.findMany({
    where: q ? { name: { contains: q, mode: 'insensitive' } } : {},
    orderBy: { name: 'asc' },
    take: Math.min(limit, 100),
  });
}

// Every tag, for the products-list filter dropdown.
export async function listAllTags(db: PrismaClient): Promise<Tag[]> {
  return db.tag.findMany({ orderBy: { name: 'asc' } });
}

export async function listTagsForProduct(
  db: PrismaClient,
  productId: string,
): Promise<Tag[]> {
  const rows = await db.productTag.findMany({
    where: { productId },
    include: { tag: true },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((r) => r.tag);
}

/**
 * Batch add/remove tags on a product by name. Adds upsert the global Tag
 * (lazily creating it) then ensure the ProductTag assignment exists.
 * Removes delete the assignment but leave the global Tag (other products
 * may use it). Idempotent. Returns the product's tags after the change.
 */
export async function setProductTags(
  db: PrismaClient,
  productId: string,
  input: ProductTagsPatchInput,
  ctx?: AuditContext,
): Promise<Tag[]> {
  // Normalize + de-dupe names; ignore blanks. A name appearing in both
  // add and remove resolves to add (explicit add wins).
  const removeNames = new Set(
    (input.remove ?? [])
      .map((n) => safeName(n))
      .filter((n): n is string => n != null),
  );
  const addNames = Array.from(
    new Set(
      (input.add ?? [])
        .map((n) => safeName(n))
        .filter((n): n is string => n != null),
    ),
  );
  for (const n of addNames) removeNames.delete(n);

  return db.$transaction(async (tx) => {
    const product = await tx.product.findUnique({
      where: { id: productId },
      select: { id: true, deletedAt: true },
    });
    if (!product || product.deletedAt) {
      throw new Error(`Product not found: ${productId}`);
    }

    for (const name of addNames) {
      const tag = await tx.tag.upsert({
        where: { name },
        create: { name },
        update: {},
      });
      const existing = await tx.productTag.findUnique({
        where: { productId_tagId: { productId, tagId: tag.id } },
      });
      if (existing) continue;
      const created = await tx.productTag.create({
        data: { productId, tagId: tag.id },
      });
      await audit(tx, {
        action: AuditAction.CREATE,
        entityType: 'ProductTag',
        entityId: created.id,
        after: { productId, tagId: tag.id, name: tag.name },
        ctx,
      });
    }

    for (const name of removeNames) {
      const tag = await tx.tag.findUnique({ where: { name } });
      if (!tag) continue;
      const existing = await tx.productTag.findUnique({
        where: { productId_tagId: { productId, tagId: tag.id } },
      });
      if (!existing) continue;
      await tx.productTag.delete({
        where: { productId_tagId: { productId, tagId: tag.id } },
      });
      await audit(tx, {
        action: AuditAction.DELETE,
        entityType: 'ProductTag',
        entityId: existing.id,
        before: { productId, tagId: tag.id, name: tag.name },
        ctx,
      });
    }

    const rows = await tx.productTag.findMany({
      where: { productId },
      include: { tag: true },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => r.tag);
  });
}

function safeName(raw: string): string | null {
  const parsed = productTagNameSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
