import { AuditAction } from '@/generated/tenant';
import type { Customer, PrismaClient } from '@/generated/tenant';
import { audit, type AuditContext } from '@/lib/audit/audit';
import {
  createCustomerInputSchema,
  updateCustomerInputSchema,
  type CreateCustomerInput,
  type UpdateCustomerInput,
} from '@/lib/validation/sales';

// Customer stub service. Strict mirror of the Vendor stub. EXPAND LATER.
// The full Customer master (contacts, addresses, terms, tax exemption,
// pricing tier, sales rep, AR balance, portal credentials) lands in its
// own slice (docs/03-customers.md). For now we only need the minimum so
// Sales Orders can FK against something and tests can construct fixtures.

export async function createCustomer(
  db: PrismaClient,
  input: CreateCustomerInput,
  ctx?: AuditContext,
): Promise<Customer> {
  const data = createCustomerInputSchema.parse(input);
  return db.$transaction(async (tx) => {
    const customer = await tx.customer.create({
      data: {
        code: data.code,
        name: data.name,
        active: data.active ?? true,
      },
    });
    await audit(tx, {
      action: AuditAction.CREATE,
      entityType: 'Customer',
      entityId: customer.id,
      after: customer,
      ctx,
    });
    return customer;
  });
}

export async function updateCustomer(
  db: PrismaClient,
  id: string,
  input: UpdateCustomerInput,
  ctx?: AuditContext,
): Promise<Customer> {
  const data = updateCustomerInputSchema.parse(input);
  return db.$transaction(async (tx) => {
    const before = await tx.customer.findUnique({ where: { id } });
    if (!before) throw new Error(`Customer not found: ${id}`);
    if (before.deletedAt) throw new Error('Customer is soft-deleted');
    const after = await tx.customer.update({
      where: { id },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.active !== undefined ? { active: data.active } : {}),
      },
    });
    await audit(tx, {
      action: AuditAction.UPDATE,
      entityType: 'Customer',
      entityId: id,
      before,
      after,
      ctx,
    });
    return after;
  });
}

export async function softDeleteCustomer(
  db: PrismaClient,
  id: string,
  ctx?: AuditContext,
): Promise<Customer> {
  return db.$transaction(async (tx) => {
    const before = await tx.customer.findUnique({ where: { id } });
    if (!before) throw new Error(`Customer not found: ${id}`);
    if (before.deletedAt) throw new Error('Customer is already soft-deleted');
    const after = await tx.customer.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    await audit(tx, {
      action: AuditAction.DELETE,
      entityType: 'Customer',
      entityId: id,
      before,
      after,
      ctx,
    });
    return after;
  });
}

export async function getCustomer(
  db: PrismaClient,
  id: string,
): Promise<Customer | null> {
  return db.customer.findFirst({ where: { id, deletedAt: null } });
}

export async function listCustomers(
  db: PrismaClient,
  filters: { active?: boolean; skip?: number; take?: number } = {},
): Promise<Customer[]> {
  const { skip = 0, take = 100, active } = filters;
  return db.customer.findMany({
    where: {
      deletedAt: null,
      ...(active !== undefined ? { active } : {}),
    },
    orderBy: { createdAt: 'desc' },
    skip,
    take,
  });
}
