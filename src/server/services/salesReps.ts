import { AuditAction, Prisma } from '@/generated/tenant';
import type { PrismaClient, SalesRep } from '@/generated/tenant';
import { audit, type AuditContext } from '@/lib/audit/audit';
import {
  createSalesRepInputSchema,
  updateSalesRepInputSchema,
  type CreateSalesRepInput,
  type UpdateSalesRepInput,
} from '@/lib/validation/salesReps';

// SalesRep — minimal master per docs/03-customers.md. The seeded
// UNASSIGNED row is required by the customer master schema as a fallback;
// soft-delete refuses if any non-deleted Customer still references the
// rep, and the UNASSIGNED rep is permanently undeletable.

const PERMANENT_REP_CODE = 'UNASSIGNED';

export async function createSalesRep(
  db: PrismaClient,
  input: CreateSalesRepInput,
  ctx?: AuditContext,
): Promise<SalesRep> {
  const data = createSalesRepInputSchema.parse(input);
  return db.$transaction(async (tx) => {
    const rep = await tx.salesRep.create({
      data: {
        code: data.code.trim().toUpperCase(),
        name: data.name,
        email: data.email,
        active: data.active ?? true,
        userId: data.userId,
        commissionBasis: data.commissionBasis ?? null,
        commissionPercent:
          data.commissionPercent != null
            ? new Prisma.Decimal(data.commissionPercent)
            : null,
        groupId: data.groupId ?? null,
      },
    });
    await audit(tx, {
      action: AuditAction.CREATE,
      entityType: 'SalesRep',
      entityId: rep.id,
      after: rep,
      ctx,
    });
    return rep;
  });
}

export async function updateSalesRep(
  db: PrismaClient,
  id: string,
  input: UpdateSalesRepInput,
  ctx?: AuditContext,
): Promise<SalesRep> {
  const data = updateSalesRepInputSchema.parse(input);
  return db.$transaction(async (tx) => {
    const before = await tx.salesRep.findUnique({ where: { id } });
    if (!before) throw new Error(`SalesRep not found: ${id}`);
    if (before.deletedAt) throw new Error('SalesRep is soft-deleted');

    const updateData: Prisma.SalesRepUpdateInput = {};
    if (data.name !== undefined) updateData.name = data.name;
    if ('email' in data) updateData.email = data.email ?? null;
    if (data.active !== undefined) updateData.active = data.active;
    if ('userId' in data) updateData.userId = data.userId ?? null;
    if ('commissionBasis' in data) updateData.commissionBasis = data.commissionBasis ?? null;
    if ('commissionPercent' in data) {
      updateData.commissionPercent =
        data.commissionPercent != null
          ? new Prisma.Decimal(data.commissionPercent)
          : null;
    }
    if ('groupId' in data) updateData.groupId = data.groupId ?? null;

    const after = await tx.salesRep.update({ where: { id }, data: updateData });
    await audit(tx, {
      action: AuditAction.UPDATE,
      entityType: 'SalesRep',
      entityId: id,
      before,
      after,
      ctx,
    });
    return after;
  });
}

/**
 * Soft-delete a sales rep. Refuses if any non-deleted Customer still
 * references the rep (caller must reassign first) AND refuses for the
 * permanent UNASSIGNED rep that the customer schema falls back to.
 */
export async function softDeleteSalesRep(
  db: PrismaClient,
  id: string,
  ctx?: AuditContext,
): Promise<SalesRep> {
  return db.$transaction(async (tx) => {
    const before = await tx.salesRep.findUnique({ where: { id } });
    if (!before) throw new Error(`SalesRep not found: ${id}`);
    if (before.deletedAt) throw new Error('SalesRep is already soft-deleted');
    if (before.code === PERMANENT_REP_CODE) {
      throw new Error(
        `Cannot soft-delete the permanent ${PERMANENT_REP_CODE} sales rep`,
      );
    }

    const liveRefCount = await tx.customer.count({
      where: { salesRepId: id, deletedAt: null },
    });
    if (liveRefCount > 0) {
      throw new Error(
        `Cannot soft-delete SalesRep: ${liveRefCount} customer(s) still reference it; reassign them first`,
      );
    }

    const after = await tx.salesRep.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    await audit(tx, {
      action: AuditAction.DELETE,
      entityType: 'SalesRep',
      entityId: id,
      before,
      after,
      ctx,
    });
    return after;
  });
}

export async function getSalesRep(
  db: PrismaClient,
  id: string,
): Promise<SalesRep | null> {
  return db.salesRep.findFirst({ where: { id, deletedAt: null } });
}

export async function listSalesReps(
  db: PrismaClient,
  filters: { active?: boolean; skip?: number; take?: number } = {},
): Promise<SalesRep[]> {
  const { skip = 0, take = 100, active } = filters;
  return db.salesRep.findMany({
    where: {
      deletedAt: null,
      ...(active !== undefined ? { active } : {}),
    },
    orderBy: { code: 'asc' },
    skip,
    take,
  });
}
