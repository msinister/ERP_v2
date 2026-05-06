import { AuditAction, Prisma } from '@/generated/tenant';
import type { PrismaClient, VendorContact } from '@/generated/tenant';
import { audit, type AuditContext } from '@/lib/audit/audit';
import {
  createVendorContactInputSchema,
  updateVendorContactInputSchema,
  type CreateVendorContactInput,
  type UpdateVendorContactInput,
} from '@/lib/validation/vendors';

// Vendor contact service. Maintains the invariant "exactly one
// isPrimary=true row per vendor among non-deleted rows" — also enforced
// by the partial unique index `vendorcontact_primary_idx`.

async function lockVendor(
  tx: Prisma.TransactionClient,
  vendorId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT 1 FROM "Vendor" WHERE "id" = ${vendorId} FOR UPDATE`;
}

async function clearOtherPrimaries(
  tx: Prisma.TransactionClient,
  vendorId: string,
  exceptContactId: string | null,
): Promise<void> {
  await tx.vendorContact.updateMany({
    where: {
      vendorId,
      isPrimary: true,
      deletedAt: null,
      ...(exceptContactId ? { NOT: { id: exceptContactId } } : {}),
    },
    data: { isPrimary: false },
  });
}

export async function createVendorContactTx(
  tx: Prisma.TransactionClient,
  vendorId: string,
  input: CreateVendorContactInput,
  ctx?: AuditContext,
): Promise<VendorContact> {
  const data = createVendorContactInputSchema.parse(input);
  await lockVendor(tx, vendorId);

  if (data.isPrimary) {
    await clearOtherPrimaries(tx, vendorId, null);
  }

  const created = await tx.vendorContact.create({
    data: {
      vendorId,
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
    entityType: 'VendorContact',
    entityId: created.id,
    after: created,
    ctx,
  });
  return created;
}

export async function createVendorContact(
  db: PrismaClient,
  vendorId: string,
  input: CreateVendorContactInput,
  ctx?: AuditContext,
): Promise<VendorContact> {
  return db.$transaction((tx) => createVendorContactTx(tx, vendorId, input, ctx));
}

export async function updateVendorContact(
  db: PrismaClient,
  contactId: string,
  input: UpdateVendorContactInput,
  ctx?: AuditContext,
): Promise<VendorContact> {
  const data = updateVendorContactInputSchema.parse(input);
  return db.$transaction(async (tx) => {
    const before = await tx.vendorContact.findUnique({ where: { id: contactId } });
    if (!before) throw new Error(`VendorContact not found: ${contactId}`);
    if (before.deletedAt) throw new Error('VendorContact is soft-deleted');

    await lockVendor(tx, before.vendorId);

    const becomingPrimary = data.isPrimary === true && before.isPrimary === false;
    if (becomingPrimary) {
      await clearOtherPrimaries(tx, before.vendorId, before.id);
    }

    const updateData: Prisma.VendorContactUpdateInput = {};
    if (data.name !== undefined) updateData.name = data.name;
    if ('role' in data) updateData.role = data.role ?? null;
    if ('email' in data) updateData.email = data.email ?? null;
    if ('phone' in data) updateData.phone = data.phone ?? null;
    if ('mobile' in data) updateData.mobile = data.mobile ?? null;
    if (data.isPrimary !== undefined) updateData.isPrimary = data.isPrimary;

    const after = await tx.vendorContact.update({
      where: { id: contactId },
      data: updateData,
    });
    await audit(tx, {
      action: AuditAction.UPDATE,
      entityType: 'VendorContact',
      entityId: contactId,
      before,
      after,
      ctx,
    });
    return after;
  });
}

export async function softDeleteVendorContact(
  db: PrismaClient,
  contactId: string,
  ctx?: AuditContext,
): Promise<VendorContact> {
  return db.$transaction(async (tx) => {
    const before = await tx.vendorContact.findUnique({ where: { id: contactId } });
    if (!before) throw new Error(`VendorContact not found: ${contactId}`);
    if (before.deletedAt) throw new Error('VendorContact is already soft-deleted');

    await lockVendor(tx, before.vendorId);

    const after = await tx.vendorContact.update({
      where: { id: contactId },
      data: {
        deletedAt: new Date(),
        isPrimary: false,
      },
    });
    await audit(tx, {
      action: AuditAction.DELETE,
      entityType: 'VendorContact',
      entityId: contactId,
      before,
      after,
      ctx,
    });
    return after;
  });
}

export async function setPrimaryVendorContact(
  db: PrismaClient,
  contactId: string,
  ctx?: AuditContext,
): Promise<VendorContact> {
  return db.$transaction(async (tx) => {
    const before = await tx.vendorContact.findUnique({ where: { id: contactId } });
    if (!before) throw new Error(`VendorContact not found: ${contactId}`);
    if (before.deletedAt) throw new Error('VendorContact is soft-deleted');

    await lockVendor(tx, before.vendorId);
    await clearOtherPrimaries(tx, before.vendorId, before.id);

    const after = await tx.vendorContact.update({
      where: { id: contactId },
      data: { isPrimary: true },
    });
    await audit(tx, {
      action: AuditAction.UPDATE,
      entityType: 'VendorContact',
      entityId: contactId,
      before,
      after,
      ctx: { ...ctx, reason: 'set as primary contact' },
    });
    return after;
  });
}

export async function listVendorContacts(
  db: PrismaClient,
  vendorId: string,
): Promise<VendorContact[]> {
  return db.vendorContact.findMany({
    where: { vendorId, deletedAt: null },
    orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
  });
}
