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
// Each operational entity has its own assignment table (xxxTagAssignment) that
// FKs into OrderTag. The per-entity setter functions below are thin wrappers
// around a single internal helper — same atomic upsert/remove + minimal audit
// flow that setSalesOrderTags pioneered, kept in lockstep across all entities.
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

// ---------------------------------------------------------------------------
// Per-entity tag listing (for detail-page editor pre-load).
// ---------------------------------------------------------------------------

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

export async function listTagsForPurchaseOrder(
  db: PrismaClient,
  purchaseOrderId: string,
): Promise<OrderTag[]> {
  const rows = await db.purchaseOrderTagAssignment.findMany({
    where: { purchaseOrderId },
    include: { tag: true },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((r) => r.tag);
}

export async function listTagsForBill(
  db: PrismaClient,
  billId: string,
): Promise<OrderTag[]> {
  const rows = await db.billTagAssignment.findMany({
    where: { billId },
    include: { tag: true },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((r) => r.tag);
}

export async function listTagsForCreditMemo(
  db: PrismaClient,
  creditMemoId: string,
): Promise<OrderTag[]> {
  const rows = await db.creditMemoTagAssignment.findMany({
    where: { creditMemoId },
    include: { tag: true },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((r) => r.tag);
}

export async function listTagsForRma(
  db: PrismaClient,
  rmaId: string,
): Promise<OrderTag[]> {
  const rows = await db.rmaTagAssignment.findMany({
    where: { rmaId },
    include: { tag: true },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((r) => r.tag);
}

export async function listTagsForWorkOrder(
  db: PrismaClient,
  workOrderId: string,
): Promise<OrderTag[]> {
  const rows = await db.workOrderTagAssignment.findMany({
    where: { workOrderId },
    include: { tag: true },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((r) => r.tag);
}

export async function listTagsForVendorCredit(
  db: PrismaClient,
  vendorCreditId: string,
): Promise<OrderTag[]> {
  const rows = await db.vendorCreditTagAssignment.findMany({
    where: { vendorCreditId },
    include: { tag: true },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((r) => r.tag);
}

// ---------------------------------------------------------------------------
// Per-entity tag set (add / remove batched together).
//
// Each public setXxxTags is a thin wrapper around `setTagsForEntity` — the
// shared template that started as setSalesOrderTags. Adds upsert the global
// OrderTag (lazily creating it) then ensure the assignment exists; removes
// delete the assignment but leave the global tag (other entities may use
// it). Audit emits CREATE / DELETE on the assignment row. Idempotent.
// Returns the entity's tags after the change.
// ---------------------------------------------------------------------------

type EntitySpec = {
  // Used verbatim in audit rows + error messages ("PurchaseOrder", etc.).
  entityType: string;
  // Prisma client model key for the entity itself ("purchaseOrder").
  entityModel:
    | 'salesOrder'
    | 'purchaseOrder'
    | 'bill'
    | 'creditMemo'
    | 'rma'
    | 'workOrder'
    | 'vendorCredit';
  // Prisma client model key for the tag-assignment join table.
  assignmentModel:
    | 'salesOrderTagAssignment'
    | 'purchaseOrderTagAssignment'
    | 'billTagAssignment'
    | 'creditMemoTagAssignment'
    | 'rmaTagAssignment'
    | 'workOrderTagAssignment'
    | 'vendorCreditTagAssignment';
  // Foreign-key field on the join table referencing the entity.
  entityIdField: string;
  // Composite-unique selector name ("purchaseOrderId_tagId").
  compositeKey: string;
};

async function setTagsForEntity(
  db: PrismaClient,
  spec: EntitySpec,
  entityId: string,
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
    // Dynamic access — each entity / assignment model has a different
    // shape (different FK field name), but the operations are uniform.
    // Cast once at the boundary so the rest reads naturally.
    const txAny = tx as unknown as Record<
      string,
      {
        findUnique: (args: {
          where: Record<string, unknown>;
          select?: Record<string, boolean>;
        }) => Promise<{ id?: string; deletedAt?: Date | null } | null>;
        findMany: (args: {
          where: Record<string, unknown>;
          include?: Record<string, unknown>;
          orderBy?: Record<string, unknown>;
        }) => Promise<Array<{ tag: OrderTag }>>;
        create: (args: { data: Record<string, unknown> }) => Promise<unknown>;
        delete: (args: { where: Record<string, unknown> }) => Promise<unknown>;
      }
    >;

    const entity = await txAny[spec.entityModel].findUnique({
      where: { id: entityId },
      select: { id: true, deletedAt: true },
    });
    if (!entity || entity.deletedAt) {
      throw new Error(`${spec.entityType} not found: ${entityId}`);
    }

    for (const name of addNames) {
      const tag = await tx.orderTag.upsert({
        where: { name },
        create: { name },
        update: {},
      });
      const existing = await txAny[spec.assignmentModel].findUnique({
        where: {
          [spec.compositeKey]: { [spec.entityIdField]: entityId, tagId: tag.id },
        },
      });
      if (existing) continue;
      await txAny[spec.assignmentModel].create({
        data: { [spec.entityIdField]: entityId, tagId: tag.id },
      });
      await audit(tx, {
        action: AuditAction.CREATE,
        entityType: `${spec.entityType}TagAssignment`,
        entityId: `${entityId}:${tag.id}`,
        after: { [spec.entityIdField]: entityId, tagId: tag.id, name: tag.name },
        ctx,
      });
    }

    for (const name of removeNames) {
      const tag = await tx.orderTag.findUnique({ where: { name } });
      if (!tag) continue;
      const existing = await txAny[spec.assignmentModel].findUnique({
        where: {
          [spec.compositeKey]: { [spec.entityIdField]: entityId, tagId: tag.id },
        },
      });
      if (!existing) continue;
      await txAny[spec.assignmentModel].delete({
        where: {
          [spec.compositeKey]: { [spec.entityIdField]: entityId, tagId: tag.id },
        },
      });
      await audit(tx, {
        action: AuditAction.DELETE,
        entityType: `${spec.entityType}TagAssignment`,
        entityId: `${entityId}:${tag.id}`,
        before: { [spec.entityIdField]: entityId, tagId: tag.id, name: tag.name },
        ctx,
      });
    }

    const rows = await txAny[spec.assignmentModel].findMany({
      where: { [spec.entityIdField]: entityId },
      include: { tag: true },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => r.tag);
  });
}

export function setSalesOrderTags(
  db: PrismaClient,
  salesOrderId: string,
  input: OrderTagsPatchInput,
  ctx?: AuditContext,
): Promise<OrderTag[]> {
  return setTagsForEntity(
    db,
    {
      entityType: 'SalesOrder',
      entityModel: 'salesOrder',
      assignmentModel: 'salesOrderTagAssignment',
      entityIdField: 'salesOrderId',
      compositeKey: 'salesOrderId_tagId',
    },
    salesOrderId,
    input,
    ctx,
  );
}

export function setPurchaseOrderTags(
  db: PrismaClient,
  purchaseOrderId: string,
  input: OrderTagsPatchInput,
  ctx?: AuditContext,
): Promise<OrderTag[]> {
  return setTagsForEntity(
    db,
    {
      entityType: 'PurchaseOrder',
      entityModel: 'purchaseOrder',
      assignmentModel: 'purchaseOrderTagAssignment',
      entityIdField: 'purchaseOrderId',
      compositeKey: 'purchaseOrderId_tagId',
    },
    purchaseOrderId,
    input,
    ctx,
  );
}

export function setBillTags(
  db: PrismaClient,
  billId: string,
  input: OrderTagsPatchInput,
  ctx?: AuditContext,
): Promise<OrderTag[]> {
  return setTagsForEntity(
    db,
    {
      entityType: 'Bill',
      entityModel: 'bill',
      assignmentModel: 'billTagAssignment',
      entityIdField: 'billId',
      compositeKey: 'billId_tagId',
    },
    billId,
    input,
    ctx,
  );
}

export function setCreditMemoTags(
  db: PrismaClient,
  creditMemoId: string,
  input: OrderTagsPatchInput,
  ctx?: AuditContext,
): Promise<OrderTag[]> {
  return setTagsForEntity(
    db,
    {
      entityType: 'CreditMemo',
      entityModel: 'creditMemo',
      assignmentModel: 'creditMemoTagAssignment',
      entityIdField: 'creditMemoId',
      compositeKey: 'creditMemoId_tagId',
    },
    creditMemoId,
    input,
    ctx,
  );
}

export function setRmaTags(
  db: PrismaClient,
  rmaId: string,
  input: OrderTagsPatchInput,
  ctx?: AuditContext,
): Promise<OrderTag[]> {
  return setTagsForEntity(
    db,
    {
      entityType: 'Rma',
      entityModel: 'rma',
      assignmentModel: 'rmaTagAssignment',
      entityIdField: 'rmaId',
      compositeKey: 'rmaId_tagId',
    },
    rmaId,
    input,
    ctx,
  );
}

export function setWorkOrderTags(
  db: PrismaClient,
  workOrderId: string,
  input: OrderTagsPatchInput,
  ctx?: AuditContext,
): Promise<OrderTag[]> {
  return setTagsForEntity(
    db,
    {
      entityType: 'WorkOrder',
      entityModel: 'workOrder',
      assignmentModel: 'workOrderTagAssignment',
      entityIdField: 'workOrderId',
      compositeKey: 'workOrderId_tagId',
    },
    workOrderId,
    input,
    ctx,
  );
}

export function setVendorCreditTags(
  db: PrismaClient,
  vendorCreditId: string,
  input: OrderTagsPatchInput,
  ctx?: AuditContext,
): Promise<OrderTag[]> {
  return setTagsForEntity(
    db,
    {
      entityType: 'VendorCredit',
      entityModel: 'vendorCredit',
      assignmentModel: 'vendorCreditTagAssignment',
      entityIdField: 'vendorCreditId',
      compositeKey: 'vendorCreditId_tagId',
    },
    vendorCreditId,
    input,
    ctx,
  );
}

function safeName(raw: string): string | null {
  const parsed = orderTagNameSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
