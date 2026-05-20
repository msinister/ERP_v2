import { randomUUID } from 'node:crypto';
import { AuditAction, Prisma } from '@/generated/tenant';
import type { CommissionBasis, PrismaClient, SalesRep } from '@/generated/tenant';
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
        commissionEnabled: data.commissionEnabled ?? false,
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
    if (data.commissionEnabled !== undefined)
      updateData.commissionEnabled = data.commissionEnabled;
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

// ---------------------------------------------------------------------------
// Admin management — reps with assigned-customer counts + linked user, for
// the /admin/sales-reps page.
// ---------------------------------------------------------------------------

export type SalesRepAdminRow = {
  id: string;
  code: string;
  name: string;
  email: string | null;
  active: boolean;
  commissionEnabled: boolean;
  commissionBasis: CommissionBasis | null;
  commissionPercent: string | null;
  assignedCustomerCount: number;
  linkedUser: { id: string; name: string; email: string; enabled: boolean } | null;
};

export async function listSalesRepsForAdmin(
  db: PrismaClient,
): Promise<SalesRepAdminRow[]> {
  const reps = await db.salesRep.findMany({
    where: { deletedAt: null },
    include: { user: { select: { id: true, name: true, email: true, enabled: true } } },
    orderBy: { code: 'asc' },
  });
  // One grouped count instead of N per-rep queries.
  const counts = await db.customer.groupBy({
    by: ['salesRepId'],
    where: { deletedAt: null },
    _count: { _all: true },
  });
  const countMap = new Map(counts.map((c) => [c.salesRepId, c._count._all]));
  return reps.map((r) => ({
    id: r.id,
    code: r.code,
    name: r.name,
    email: r.email,
    active: r.active,
    commissionEnabled: r.commissionEnabled,
    commissionBasis: r.commissionBasis,
    commissionPercent: r.commissionPercent ? r.commissionPercent.toString() : null,
    assignedCustomerCount: countMap.get(r.id) ?? 0,
    linkedUser: r.user
      ? { id: r.user.id, name: r.user.name, email: r.user.email, enabled: r.user.enabled }
      : null,
  }));
}

// ---------------------------------------------------------------------------
// User ↔ SalesRep link. The "Sales rep" toggle on the user edit form drives
// these. A user links to AT MOST one SalesRep (User.salesRepId is unique);
// commission fields live on the SalesRep where the commission engine reads
// them. See docs/03-customers.md (sales rep & commissions).
// ---------------------------------------------------------------------------

export type SalesRepCommissionFields = {
  commissionEnabled?: boolean;
  commissionBasis?: CommissionBasis | null;
  commissionPercent?: string | number | null;
};

/**
 * Derive a short, uppercase base for an auto-generated sales-rep code that
 * matches the manual convention (e.g. "CPT", "SKT") — NO "REP-" prefix:
 *   - 2+ word name → initials (first alnum char per word, max 4)
 *   - single word  → first 3 chars
 *   - else         → email local part (first 3 alnum chars), then random
 * The base is not guaranteed unique; generateSalesRepCode appends a numeric
 * suffix on collision.
 */
export function deriveSalesRepCodeBase(
  name: string,
  email: string | null,
): string {
  const words = name
    .split(/\s+/)
    .map((w) => w.replace(/[^A-Za-z0-9]/g, ''))
    .filter(Boolean);
  if (words.length >= 2) {
    const initials = words
      .map((w) => w.charAt(0))
      .join('')
      .toUpperCase()
      .slice(0, 4);
    if (initials.length >= 2) return initials;
  }
  if (words.length === 1 && words[0].length >= 2) {
    return words[0].toUpperCase().slice(0, 3);
  }
  const local = (email ?? '').split('@')[0] ?? '';
  const fromEmail = local
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase()
    .slice(0, 3);
  if (fromEmail.length >= 2) return fromEmail;
  // No usable name/email — short random alnum (still the "short uppercase"
  // shape, just not human-derived).
  return randomUUID().replace(/[^A-Za-z0-9]/g, '').slice(0, 4).toUpperCase();
}

/**
 * Auto-generate a unique short uppercase sales-rep code. Tries the derived
 * base, then base+2, base+3, … against existing SalesRep.code (globally
 * unique). Matches the manual code convention.
 */
export async function generateSalesRepCode(
  tx: Prisma.TransactionClient,
  name: string,
  email: string | null,
): Promise<string> {
  const base = deriveSalesRepCodeBase(name, email);
  for (let n = 0; n < 50; n++) {
    const candidate = n === 0 ? base : `${base}${n + 1}`;
    const existing = await tx.salesRep.findUnique({
      where: { code: candidate },
    });
    if (!existing) return candidate;
  }
  // Pathological-collision fallback: base + short random suffix.
  return `${base}${randomUUID().replace(/[^A-Za-z0-9]/g, '').slice(0, 4).toUpperCase()}`;
}

/**
 * Flag a user as a sales rep. Creates a SalesRep + sets User.salesRepId
 * when the user isn't linked yet; otherwise updates the linked rep's
 * commission fields. Returns the linked rep. Auto-generates a rep code
 * (operators can rename it on the /admin/sales-reps page).
 */
export async function linkUserAsSalesRep(
  db: PrismaClient,
  userId: string,
  fields: SalesRepCommissionFields,
  ctx?: AuditContext,
): Promise<SalesRep> {
  return db.$transaction(async (tx) => {
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, email: true, salesRepId: true, deletedAt: true },
    });
    if (!user) throw new Error(`User not found: ${userId}`);
    if (user.deletedAt) throw new Error('User is soft-deleted');

    const commissionPercent =
      fields.commissionPercent != null
        ? new Prisma.Decimal(fields.commissionPercent)
        : null;

    if (user.salesRepId) {
      const before = await tx.salesRep.findUniqueOrThrow({
        where: { id: user.salesRepId },
      });
      const after = await tx.salesRep.update({
        where: { id: user.salesRepId },
        data: {
          ...(fields.commissionEnabled !== undefined
            ? { commissionEnabled: fields.commissionEnabled }
            : {}),
          ...(fields.commissionBasis !== undefined
            ? { commissionBasis: fields.commissionBasis }
            : {}),
          ...(fields.commissionPercent !== undefined ? { commissionPercent } : {}),
        },
      });
      await audit(tx, {
        action: AuditAction.UPDATE,
        entityType: 'SalesRep',
        entityId: after.id,
        before,
        after,
        ctx,
      });
      return after;
    }

    const rep = await tx.salesRep.create({
      data: {
        code: await generateSalesRepCode(tx, user.name, user.email),
        name: user.name,
        email: user.email,
        active: true,
        commissionEnabled: fields.commissionEnabled ?? false,
        commissionBasis: fields.commissionBasis ?? null,
        commissionPercent,
      },
    });
    await tx.user.update({ where: { id: userId }, data: { salesRepId: rep.id } });
    await audit(tx, {
      action: AuditAction.CREATE,
      entityType: 'SalesRep',
      entityId: rep.id,
      after: rep,
      ctx,
    });
    await audit(tx, {
      action: AuditAction.UPDATE,
      entityType: 'User',
      entityId: userId,
      before: { salesRepId: null },
      after: { salesRepId: rep.id },
      ctx,
    });
    return rep;
  });
}

/**
 * Remove a user's sales-rep assignment (set User.salesRepId = null). The
 * SalesRep row is preserved (it may carry commission history + still own
 * customers). Returns the count of customers still assigned to the rep so
 * the caller can surface a warning — this does NOT block.
 */
export async function unlinkUserSalesRep(
  db: PrismaClient,
  userId: string,
  ctx?: AuditContext,
): Promise<{ unlinkedRepId: string | null; assignedCustomerCount: number }> {
  return db.$transaction(async (tx) => {
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { id: true, salesRepId: true, deletedAt: true },
    });
    if (!user) throw new Error(`User not found: ${userId}`);
    if (user.deletedAt) throw new Error('User is soft-deleted');
    if (!user.salesRepId) {
      return { unlinkedRepId: null, assignedCustomerCount: 0 };
    }

    const assignedCustomerCount = await tx.customer.count({
      where: { salesRepId: user.salesRepId, deletedAt: null },
    });
    await tx.user.update({ where: { id: userId }, data: { salesRepId: null } });
    await audit(tx, {
      action: AuditAction.UPDATE,
      entityType: 'User',
      entityId: userId,
      before: { salesRepId: user.salesRepId },
      after: { salesRepId: null },
      ctx,
    });
    return { unlinkedRepId: user.salesRepId, assignedCustomerCount };
  });
}
