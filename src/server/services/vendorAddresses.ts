import { AuditAction, Prisma } from '@/generated/tenant';
import type {
  PrismaClient,
  VendorAddress,
  VendorAddressKind,
} from '@/generated/tenant';
import { audit, type AuditContext } from '@/lib/audit/audit';
import {
  vendorAddressInputSchema,
  updateVendorAddressInputSchema,
  type VendorAddressInput,
  type UpdateVendorAddressInput,
} from '@/lib/validation/vendors';

// Vendor address service. Maintains the invariant "exactly one
// isDefault=true row per (vendorId, kind) among non-deleted rows" —
// also enforced by the partial unique index
// `vendoraddress_default_per_kind_idx`. Every write path takes a
// SELECT ... FOR UPDATE on the parent vendor row inside the transaction
// so concurrent setDefault calls serialize.

async function lockVendor(
  tx: Prisma.TransactionClient,
  vendorId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT 1 FROM "Vendor" WHERE "id" = ${vendorId} FOR UPDATE`;
}

async function clearOtherDefaults(
  tx: Prisma.TransactionClient,
  vendorId: string,
  kind: VendorAddressKind,
  exceptAddressId: string | null,
): Promise<void> {
  await tx.vendorAddress.updateMany({
    where: {
      vendorId,
      kind,
      isDefault: true,
      deletedAt: null,
      ...(exceptAddressId ? { NOT: { id: exceptAddressId } } : {}),
    },
    data: { isDefault: false },
  });
}

export async function addVendorAddressTx(
  tx: Prisma.TransactionClient,
  vendorId: string,
  input: VendorAddressInput,
  ctx?: AuditContext,
): Promise<VendorAddress> {
  const data = vendorAddressInputSchema.parse(input);
  await lockVendor(tx, vendorId);

  // REMIT_TO is the canonical AP destination — the first one created
  // becomes the default automatically; subsequent ones explicitly opt in
  // via isDefault. SHIPPING and BILLING are caller-driven (rare kinds).
  const willBeDefault = data.isDefault === true;

  if (willBeDefault) {
    await clearOtherDefaults(tx, vendorId, data.kind, null);
  }

  const created = await tx.vendorAddress.create({
    data: {
      vendorId,
      kind: data.kind,
      isDefault: willBeDefault,
      label: data.label ?? null,
      line1: data.line1,
      line2: data.line2 ?? null,
      city: data.city,
      region: data.region,
      postalCode: data.postalCode,
      country: data.country ?? 'US',
      attention: data.attention ?? null,
      phone: data.phone ?? null,
    },
  });
  await audit(tx, {
    action: AuditAction.CREATE,
    entityType: 'VendorAddress',
    entityId: created.id,
    after: created,
    ctx,
  });
  return created;
}

export async function addVendorAddress(
  db: PrismaClient,
  vendorId: string,
  input: VendorAddressInput,
  ctx?: AuditContext,
): Promise<VendorAddress> {
  return db.$transaction((tx) => addVendorAddressTx(tx, vendorId, input, ctx));
}

export async function updateVendorAddress(
  db: PrismaClient,
  addressId: string,
  input: UpdateVendorAddressInput,
  ctx?: AuditContext,
): Promise<VendorAddress> {
  const data = updateVendorAddressInputSchema.parse(input);
  return db.$transaction(async (tx) => {
    const before = await tx.vendorAddress.findUnique({ where: { id: addressId } });
    if (!before) throw new Error(`VendorAddress not found: ${addressId}`);
    if (before.deletedAt) throw new Error('VendorAddress is soft-deleted');

    await lockVendor(tx, before.vendorId);

    const becomingDefault = data.isDefault === true && before.isDefault === false;
    if (becomingDefault) {
      await clearOtherDefaults(tx, before.vendorId, before.kind, before.id);
    }

    const updateData: Prisma.VendorAddressUpdateInput = {};
    if (data.line1 !== undefined) updateData.line1 = data.line1;
    if ('line2' in data) updateData.line2 = data.line2 ?? null;
    if (data.city !== undefined) updateData.city = data.city;
    if (data.region !== undefined) updateData.region = data.region;
    if (data.postalCode !== undefined) updateData.postalCode = data.postalCode;
    if (data.country !== undefined) updateData.country = data.country;
    if ('label' in data) updateData.label = data.label ?? null;
    if ('attention' in data) updateData.attention = data.attention ?? null;
    if ('phone' in data) updateData.phone = data.phone ?? null;
    if (data.isDefault !== undefined) updateData.isDefault = data.isDefault;

    const after = await tx.vendorAddress.update({
      where: { id: addressId },
      data: updateData,
    });
    await audit(tx, {
      action: AuditAction.UPDATE,
      entityType: 'VendorAddress',
      entityId: addressId,
      before,
      after,
      ctx,
    });
    return after;
  });
}

export async function softDeleteVendorAddress(
  db: PrismaClient,
  addressId: string,
  ctx?: AuditContext,
): Promise<VendorAddress> {
  return db.$transaction(async (tx) => {
    const before = await tx.vendorAddress.findUnique({ where: { id: addressId } });
    if (!before) throw new Error(`VendorAddress not found: ${addressId}`);
    if (before.deletedAt) throw new Error('VendorAddress is already soft-deleted');

    await lockVendor(tx, before.vendorId);

    const after = await tx.vendorAddress.update({
      where: { id: addressId },
      data: {
        deletedAt: new Date(),
        isDefault: false,
      },
    });
    await audit(tx, {
      action: AuditAction.DELETE,
      entityType: 'VendorAddress',
      entityId: addressId,
      before,
      after,
      ctx,
    });
    return after;
  });
}

export async function setDefaultVendorAddress(
  db: PrismaClient,
  addressId: string,
  ctx?: AuditContext,
): Promise<VendorAddress> {
  return db.$transaction(async (tx) => {
    const before = await tx.vendorAddress.findUnique({ where: { id: addressId } });
    if (!before) throw new Error(`VendorAddress not found: ${addressId}`);
    if (before.deletedAt) throw new Error('VendorAddress is soft-deleted');

    await lockVendor(tx, before.vendorId);
    await clearOtherDefaults(tx, before.vendorId, before.kind, before.id);

    const after = await tx.vendorAddress.update({
      where: { id: addressId },
      data: { isDefault: true },
    });
    await audit(tx, {
      action: AuditAction.UPDATE,
      entityType: 'VendorAddress',
      entityId: addressId,
      before,
      after,
      ctx: { ...ctx, reason: 'set as default for kind' },
    });
    return after;
  });
}

export async function listVendorAddresses(
  db: PrismaClient,
  vendorId: string,
  filters: { kind?: VendorAddressKind } = {},
): Promise<VendorAddress[]> {
  return db.vendorAddress.findMany({
    where: {
      vendorId,
      deletedAt: null,
      ...(filters.kind ? { kind: filters.kind } : {}),
    },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
  });
}
