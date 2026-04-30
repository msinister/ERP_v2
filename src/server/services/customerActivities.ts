import { AuditAction, CustomerActivityKind, Prisma } from '@/generated/tenant';
import type { CustomerActivity, PrismaClient } from '@/generated/tenant';
import { audit, type AuditContext } from '@/lib/audit/audit';
import {
  createActivityInputSchema,
  type CreateActivityInput,
} from '@/lib/validation/customers';

// Customer-facing timeline. AUTO entries are written directly by the
// services that own the field changes (customers, documents,
// priceOverrides). This file is the ONLY path for MANUAL entries plus
// the read-side query that drives the customer page timeline.
//
// Per the CustomerActivity model JSDoc: AUTO entries carry the
// { field, from, to } detailJson shape; MANUAL entries leave detailJson
// null because the summary string is the whole content.

export async function addManualEntry(
  db: PrismaClient,
  customerId: string,
  input: CreateActivityInput,
  ctx?: AuditContext,
): Promise<CustomerActivity> {
  const data = createActivityInputSchema.parse(input);
  return db.$transaction(async (tx) => {
    const created = await tx.customerActivity.create({
      data: {
        customerId,
        kind: CustomerActivityKind.MANUAL,
        summary: data.summary,
        // Explicit Prisma.JsonNull (the SQL NULL token, not the JSON
        // null value) per the model JSDoc: MANUAL entries leave
        // detailJson null because the summary is the whole content.
        detailJson: Prisma.JsonNull,
        createdById: ctx?.userId ?? null,
      },
    });
    await audit(tx, {
      action: AuditAction.CREATE,
      entityType: 'CustomerActivity',
      entityId: created.id,
      after: created,
      ctx,
    });
    return created;
  });
}

export type ListActivityFilters = {
  kind?: CustomerActivityKind;
  from?: Date;
  to?: Date;
  skip?: number;
  take?: number;
};

export async function listActivity(
  db: PrismaClient,
  customerId: string,
  filters: ListActivityFilters = {},
): Promise<CustomerActivity[]> {
  const { kind, from, to, skip = 0, take = 100 } = filters;
  const dateFilter: { gte?: Date; lte?: Date } = {};
  if (from) dateFilter.gte = from;
  if (to) dateFilter.lte = to;
  return db.customerActivity.findMany({
    where: {
      customerId,
      ...(kind ? { kind } : {}),
      ...(from || to ? { createdAt: dateFilter } : {}),
    },
    orderBy: { createdAt: 'desc' },
    skip,
    take: Math.min(take, 500),
  });
}
