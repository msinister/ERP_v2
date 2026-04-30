import { AuditAction } from '@/generated/tenant';
import type { PaymentTerm, PrismaClient } from '@/generated/tenant';
import { audit, type AuditContext } from '@/lib/audit/audit';
import {
  createPaymentTermInputSchema,
  updatePaymentTermInputSchema,
  type CreatePaymentTermInput,
  type UpdatePaymentTermInput,
} from '@/lib/validation/paymentTerms';

// Payment term reference data — admin-managed list per docs/03-customers.md.
// Seeded with NET30, COD, PREPAY, DEP50, PAYSHIP, BILLNET30 by the
// expand_customer_master migration; this service exposes CRUD so admins can
// add bespoke terms (e.g., "Net 45") later. Soft-delete only — payment
// terms may be referenced by historical customer rows.

export async function createPaymentTerm(
  db: PrismaClient,
  input: CreatePaymentTermInput,
  ctx?: AuditContext,
): Promise<PaymentTerm> {
  const data = createPaymentTermInputSchema.parse(input);
  return db.$transaction(async (tx) => {
    const term = await tx.paymentTerm.create({
      data: {
        code: data.code.trim().toUpperCase(),
        label: data.label,
        netDays: data.netDays ?? null,
        active: data.active ?? true,
      },
    });
    await audit(tx, {
      action: AuditAction.CREATE,
      entityType: 'PaymentTerm',
      entityId: term.id,
      after: term,
      ctx,
    });
    return term;
  });
}

export async function updatePaymentTerm(
  db: PrismaClient,
  id: string,
  input: UpdatePaymentTermInput,
  ctx?: AuditContext,
): Promise<PaymentTerm> {
  const data = updatePaymentTermInputSchema.parse(input);
  return db.$transaction(async (tx) => {
    const before = await tx.paymentTerm.findUnique({ where: { id } });
    if (!before) throw new Error(`PaymentTerm not found: ${id}`);
    if (before.deletedAt) throw new Error('PaymentTerm is soft-deleted');
    const after = await tx.paymentTerm.update({
      where: { id },
      data: {
        ...(data.label !== undefined ? { label: data.label } : {}),
        ...('netDays' in data ? { netDays: data.netDays ?? null } : {}),
        ...(data.active !== undefined ? { active: data.active } : {}),
      },
    });
    await audit(tx, {
      action: AuditAction.UPDATE,
      entityType: 'PaymentTerm',
      entityId: id,
      before,
      after,
      ctx,
    });
    return after;
  });
}

/**
 * Soft-delete a payment term. Refuses if any non-deleted Customer
 * still references it — historical references must be preserved, and
 * orphaning live customers is a foot-gun. The caller is expected to
 * reassign customers off this term first.
 */
export async function softDeletePaymentTerm(
  db: PrismaClient,
  id: string,
  ctx?: AuditContext,
): Promise<PaymentTerm> {
  return db.$transaction(async (tx) => {
    const before = await tx.paymentTerm.findUnique({ where: { id } });
    if (!before) throw new Error(`PaymentTerm not found: ${id}`);
    if (before.deletedAt) throw new Error('PaymentTerm is already soft-deleted');

    const liveRefCount = await tx.customer.count({
      where: { paymentTermId: id, deletedAt: null },
    });
    if (liveRefCount > 0) {
      throw new Error(
        `Cannot soft-delete PaymentTerm: ${liveRefCount} customer(s) still reference it; reassign them first`,
      );
    }

    const after = await tx.paymentTerm.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    await audit(tx, {
      action: AuditAction.DELETE,
      entityType: 'PaymentTerm',
      entityId: id,
      before,
      after,
      ctx,
    });
    return after;
  });
}

export async function getPaymentTerm(
  db: PrismaClient,
  id: string,
): Promise<PaymentTerm | null> {
  return db.paymentTerm.findFirst({ where: { id, deletedAt: null } });
}

export async function listPaymentTerms(
  db: PrismaClient,
  filters: { active?: boolean; skip?: number; take?: number } = {},
): Promise<PaymentTerm[]> {
  const { skip = 0, take = 100, active } = filters;
  return db.paymentTerm.findMany({
    where: {
      deletedAt: null,
      ...(active !== undefined ? { active } : {}),
    },
    orderBy: { code: 'asc' },
    skip,
    take,
  });
}
