import { AuditAction, Prisma } from '@/generated/tenant';
import type { CustomerContact, PrismaClient } from '@/generated/tenant';
import { audit, type AuditContext } from '@/lib/audit/audit';
import {
  createContactInputSchema,
  updateContactInputSchema,
  type CreateContactInput,
  type UpdateContactInput,
} from '@/lib/validation/customers';

// Customer contact service. Maintains the invariant "exactly one
// isPrimary=true row per customer among non-deleted rows" — also
// enforced by the partial unique index `customercontact_primary_idx`.

async function lockCustomer(
  tx: Prisma.TransactionClient,
  customerId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT 1 FROM "Customer" WHERE "id" = ${customerId} FOR UPDATE`;
}

async function clearOtherPrimaries(
  tx: Prisma.TransactionClient,
  customerId: string,
  exceptContactId: string | null,
): Promise<void> {
  await tx.customerContact.updateMany({
    where: {
      customerId,
      isPrimary: true,
      deletedAt: null,
      ...(exceptContactId ? { NOT: { id: exceptContactId } } : {}),
    },
    data: { isPrimary: false },
  });
}

// ---------------------------------------------------------------------------
// Tx variant — used by the customer service's composite create.
// ---------------------------------------------------------------------------

export async function createContactTx(
  tx: Prisma.TransactionClient,
  customerId: string,
  input: CreateContactInput,
  ctx?: AuditContext,
): Promise<CustomerContact> {
  const data = createContactInputSchema.parse(input);
  await lockCustomer(tx, customerId);

  if (data.isPrimary) {
    await clearOtherPrimaries(tx, customerId, null);
  }

  const created = await tx.customerContact.create({
    data: {
      customerId,
      name: data.name,
      role: data.role ?? null,
      email: data.email ?? null,
      phone: data.phone ?? null,
      mobile: data.mobile ?? null,
      isPrimary: data.isPrimary ?? false,
    },
  });
  await audit(tx, {
    action: AuditAction.CREATE,
    entityType: 'CustomerContact',
    entityId: created.id,
    after: created,
    ctx,
  });
  return created;
}

// ---------------------------------------------------------------------------
// Public wrappers
// ---------------------------------------------------------------------------

export async function createContact(
  db: PrismaClient,
  customerId: string,
  input: CreateContactInput,
  ctx?: AuditContext,
): Promise<CustomerContact> {
  return db.$transaction((tx) => createContactTx(tx, customerId, input, ctx));
}

export async function updateContact(
  db: PrismaClient,
  contactId: string,
  input: UpdateContactInput,
  ctx?: AuditContext,
): Promise<CustomerContact> {
  const data = updateContactInputSchema.parse(input);
  return db.$transaction(async (tx) => {
    const before = await tx.customerContact.findUnique({ where: { id: contactId } });
    if (!before) throw new Error(`CustomerContact not found: ${contactId}`);
    if (before.deletedAt) throw new Error('CustomerContact is soft-deleted');

    await lockCustomer(tx, before.customerId);

    const becomingPrimary = data.isPrimary === true && before.isPrimary === false;
    if (becomingPrimary) {
      await clearOtherPrimaries(tx, before.customerId, before.id);
    }

    const updateData: Prisma.CustomerContactUpdateInput = {};
    if (data.name !== undefined) updateData.name = data.name;
    if ('role' in data) updateData.role = data.role ?? null;
    if ('email' in data) updateData.email = data.email ?? null;
    if ('phone' in data) updateData.phone = data.phone ?? null;
    if ('mobile' in data) updateData.mobile = data.mobile ?? null;
    if (data.isPrimary !== undefined) updateData.isPrimary = data.isPrimary;

    const after = await tx.customerContact.update({
      where: { id: contactId },
      data: updateData,
    });
    await audit(tx, {
      action: AuditAction.UPDATE,
      entityType: 'CustomerContact',
      entityId: contactId,
      before,
      after,
      ctx,
    });
    return after;
  });
}

/**
 * Soft-delete a contact. If the contact has isPrimary=true, the flag is
 * cleared in the SAME transaction — same rationale as softDeleteAddress
 * for the address invariant: avoids a "ghost primary" deleted row.
 */
export async function softDeleteContact(
  db: PrismaClient,
  contactId: string,
  ctx?: AuditContext,
): Promise<CustomerContact> {
  return db.$transaction(async (tx) => {
    const before = await tx.customerContact.findUnique({ where: { id: contactId } });
    if (!before) throw new Error(`CustomerContact not found: ${contactId}`);
    if (before.deletedAt) throw new Error('CustomerContact is already soft-deleted');

    await lockCustomer(tx, before.customerId);

    const after = await tx.customerContact.update({
      where: { id: contactId },
      data: {
        deletedAt: new Date(),
        isPrimary: false,
      },
    });
    await audit(tx, {
      action: AuditAction.DELETE,
      entityType: 'CustomerContact',
      entityId: contactId,
      before,
      after,
      ctx,
    });
    return after;
  });
}

export async function setPrimaryContact(
  db: PrismaClient,
  contactId: string,
  ctx?: AuditContext,
): Promise<CustomerContact> {
  return db.$transaction(async (tx) => {
    const before = await tx.customerContact.findUnique({ where: { id: contactId } });
    if (!before) throw new Error(`CustomerContact not found: ${contactId}`);
    if (before.deletedAt) throw new Error('CustomerContact is soft-deleted');

    await lockCustomer(tx, before.customerId);
    await clearOtherPrimaries(tx, before.customerId, before.id);

    const after = await tx.customerContact.update({
      where: { id: contactId },
      data: { isPrimary: true },
    });
    await audit(tx, {
      action: AuditAction.UPDATE,
      entityType: 'CustomerContact',
      entityId: contactId,
      before,
      after,
      ctx: { ...ctx, reason: 'set as primary contact' },
    });
    return after;
  });
}

export async function listContacts(
  db: PrismaClient,
  customerId: string,
): Promise<CustomerContact[]> {
  return db.customerContact.findMany({
    where: { customerId, deletedAt: null },
    orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
  });
}
