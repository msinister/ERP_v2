import { AuditAction } from '@/generated/tenant';
import type { OrderTag, PrismaClient } from '@/generated/tenant';
import { audit, type AuditContext } from '@/lib/audit/audit';
import {
  orderTagNameSchema,
  type OrderTagsPatchInput,
} from '@/lib/validation/orderTags';

// =============================================================================
// Shared operational tags. OrderTag rows are global (one dictionary, shared
// across SalesOrder / PurchaseOrder / Bill / CreditMemo / Rma / WorkOrder /
// VendorCredit) and created lazily on first use via the autocomplete editor.
// OrderTag.name is CITEXT so equality is case-insensitive natively;
// substring autocomplete still needs mode:'insensitive'.
//
// Today only SalesOrder has a tag join (SalesOrderTagAssignment). Future
// per-entity setters live alongside `setSalesOrderTags` and follow the same
// shape — atomic upsert/remove + minimal audit on the assignment row.
// =============================================================================

// Autocomplete the dictionary. Empty q → most recent tags alphabetically.
export async function searchOrderTags(
  db: PrismaClient,
  q: string | undefined,
  limit: number = 25,
): Promise<OrderTag[]> {
  return db.orderTag.findMany({
    where: q ? { name: { contains: q, mode: 'insensitive' } } : {},
    orderBy: { name: 'asc' },
    take: Math.min(limit, 100),
  });
}

// Every tag, for the list-page filter dropdown.
export async function listAllOrderTags(db: PrismaClient): Promise<OrderTag[]> {
  return db.orderTag.findMany({ orderBy: { name: 'asc' } });
}

export async function listTagsForSalesOrder(
  db: PrismaClient,
  salesOrderId: string,
): Promise<OrderTag[]> {
  const rows = await db.salesOrderTagAssignment.findMany({
    where: { salesOrderId },
    include: { tag: true },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((r) => r.tag);
}

/**
 * Batch add/remove tags on a sales order by name. Adds upsert the global
 * OrderTag (lazily creating it) then ensure the assignment exists. Removes
 * delete the assignment but leave the global tag (other entities may use
 * it). Idempotent. Returns the SO's tags after the change.
 *
 * Mirrors setProductTags (productTags.ts) — keep the shapes aligned so
 * future PO/Bill/CM/RMA/WO/VC setters can copy this template.
 */
export async function setSalesOrderTags(
  db: PrismaClient,
  salesOrderId: string,
  input: OrderTagsPatchInput,
  ctx?: AuditContext,
): Promise<OrderTag[]> {
  // Normalize + de-dupe; ignore blanks. A name appearing in both add and
  // remove resolves to add (explicit add wins).
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
    const so = await tx.salesOrder.findUnique({
      where: { id: salesOrderId },
      select: { id: true, deletedAt: true },
    });
    if (!so || so.deletedAt) {
      throw new Error(`SalesOrder not found: ${salesOrderId}`);
    }

    for (const name of addNames) {
      const tag = await tx.orderTag.upsert({
        where: { name },
        create: { name },
        update: {},
      });
      const existing = await tx.salesOrderTagAssignment.findUnique({
        where: { salesOrderId_tagId: { salesOrderId, tagId: tag.id } },
      });
      if (existing) continue;
      await tx.salesOrderTagAssignment.create({
        data: { salesOrderId, tagId: tag.id },
      });
      await audit(tx, {
        action: AuditAction.CREATE,
        entityType: 'SalesOrderTagAssignment',
        entityId: `${salesOrderId}:${tag.id}`,
        after: { salesOrderId, tagId: tag.id, name: tag.name },
        ctx,
      });
    }

    for (const name of removeNames) {
      const tag = await tx.orderTag.findUnique({ where: { name } });
      if (!tag) continue;
      const existing = await tx.salesOrderTagAssignment.findUnique({
        where: { salesOrderId_tagId: { salesOrderId, tagId: tag.id } },
      });
      if (!existing) continue;
      await tx.salesOrderTagAssignment.delete({
        where: { salesOrderId_tagId: { salesOrderId, tagId: tag.id } },
      });
      await audit(tx, {
        action: AuditAction.DELETE,
        entityType: 'SalesOrderTagAssignment',
        entityId: `${salesOrderId}:${tag.id}`,
        before: { salesOrderId, tagId: tag.id, name: tag.name },
        ctx,
      });
    }

    const rows = await tx.salesOrderTagAssignment.findMany({
      where: { salesOrderId },
      include: { tag: true },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => r.tag);
  });
}

function safeName(raw: string): string | null {
  const parsed = orderTagNameSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
