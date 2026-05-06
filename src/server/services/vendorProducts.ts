import { AuditAction, Prisma } from '@/generated/tenant';
import type { PrismaClient, VendorProduct } from '@/generated/tenant';
import { audit, type AuditContext } from '@/lib/audit/audit';
import {
  createVendorProductInputSchema,
  updateVendorProductInputSchema,
  type CreateVendorProductInput,
  type UpdateVendorProductInput,
} from '@/lib/validation/vendors';

// Vendor product catalog service. Per-vendor per-variant rows recording
// vendor SKU + latest cost + pack size. Two singleton invariants:
//
//   1. (vendorId, variantId) unique among non-deleted rows — enforced by
//      partial unique index `vendorproduct_active_key`. Soft-deleted rows
//      can be replaced via the same upsert path.
//   2. At most one isPrimary=true per variantId among non-deleted rows —
//      enforced by partial unique index `vendorproduct_primary_idx`. Used
//      by the multi-vendor case where one product is sourced from several
//      vendors and PO suggestions need a tiebreaker.
//
// SERVICE-type vendors are blocked at the service layer (Q4 — refine
// at the service boundary). Spec line 7: "service vendors are AP only,
// no products."
//
// `latestCost` auto-update from receipt confirmation is a separate slice
// (writes from receipts.ts). This service only takes manual cost values
// from form input / CSV import.

async function lockVendor(
  tx: Prisma.TransactionClient,
  vendorId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT 1 FROM "Vendor" WHERE "id" = ${vendorId} FOR UPDATE`;
}

async function clearOtherPrimariesForVariant(
  tx: Prisma.TransactionClient,
  variantId: string,
  exceptId: string | null,
): Promise<void> {
  await tx.vendorProduct.updateMany({
    where: {
      variantId,
      isPrimary: true,
      deletedAt: null,
      ...(exceptId ? { NOT: { id: exceptId } } : {}),
    },
    data: { isPrimary: false },
  });
}

async function assertVendorAllowsProducts(
  tx: Prisma.TransactionClient,
  vendorId: string,
): Promise<void> {
  const v = await tx.vendor.findUnique({
    where: { id: vendorId },
    select: { id: true, type: true, deletedAt: true },
  });
  if (!v) throw new Error(`Vendor not found: ${vendorId}`);
  if (v.deletedAt) throw new Error('Vendor is soft-deleted');
  if (v.type === 'SERVICE') {
    throw new Error(
      'SERVICE-type vendors cannot have catalog rows; service vendors are AP-only per spec',
    );
  }
}

export async function createVendorProductTx(
  tx: Prisma.TransactionClient,
  vendorId: string,
  input: CreateVendorProductInput,
  ctx?: AuditContext,
): Promise<VendorProduct> {
  const data = createVendorProductInputSchema.parse(input);
  await lockVendor(tx, vendorId);
  await assertVendorAllowsProducts(tx, vendorId);

  // Reject if a non-deleted row already exists for (vendor, variant).
  // The partial unique index would also reject it, but a clean error
  // beats a Prisma constraint violation at the call site.
  const existing = await tx.vendorProduct.findFirst({
    where: { vendorId, variantId: data.variantId, deletedAt: null },
  });
  if (existing) {
    throw new Error(
      `VendorProduct already exists for (vendor=${vendorId}, variant=${data.variantId})`,
    );
  }

  if (data.isPrimary) {
    await clearOtherPrimariesForVariant(tx, data.variantId, null);
  }

  const created = await tx.vendorProduct.create({
    data: {
      vendorId,
      variantId: data.variantId,
      vendorSku: data.vendorSku ?? null,
      latestCost:
        data.latestCost != null ? new Prisma.Decimal(data.latestCost) : null,
      packSize: data.packSize != null ? new Prisma.Decimal(data.packSize) : null,
      isPrimary: data.isPrimary ?? false,
      active: data.active ?? true,
      notes: data.notes ?? null,
    },
  });
  await audit(tx, {
    action: AuditAction.CREATE,
    entityType: 'VendorProduct',
    entityId: created.id,
    after: created,
    ctx,
  });
  return created;
}

export async function createVendorProduct(
  db: PrismaClient,
  vendorId: string,
  input: CreateVendorProductInput,
  ctx?: AuditContext,
): Promise<VendorProduct> {
  return db.$transaction((tx) => createVendorProductTx(tx, vendorId, input, ctx));
}

export async function updateVendorProduct(
  db: PrismaClient,
  id: string,
  input: UpdateVendorProductInput,
  ctx?: AuditContext,
): Promise<VendorProduct> {
  const data = updateVendorProductInputSchema.parse(input);
  return db.$transaction(async (tx) => {
    const before = await tx.vendorProduct.findUnique({ where: { id } });
    if (!before) throw new Error(`VendorProduct not found: ${id}`);
    if (before.deletedAt) throw new Error('VendorProduct is soft-deleted');

    await lockVendor(tx, before.vendorId);

    const becomingPrimary = data.isPrimary === true && before.isPrimary === false;
    if (becomingPrimary) {
      await clearOtherPrimariesForVariant(tx, before.variantId, before.id);
    }

    const updateData: Prisma.VendorProductUpdateInput = {};
    if ('vendorSku' in data) updateData.vendorSku = data.vendorSku ?? null;
    if ('latestCost' in data) {
      updateData.latestCost =
        data.latestCost != null ? new Prisma.Decimal(data.latestCost) : null;
    }
    if ('packSize' in data) {
      updateData.packSize =
        data.packSize != null ? new Prisma.Decimal(data.packSize) : null;
    }
    if (data.isPrimary !== undefined) updateData.isPrimary = data.isPrimary;
    if (data.active !== undefined) updateData.active = data.active;
    if ('notes' in data) updateData.notes = data.notes ?? null;

    const after = await tx.vendorProduct.update({ where: { id }, data: updateData });
    await audit(tx, {
      action: AuditAction.UPDATE,
      entityType: 'VendorProduct',
      entityId: id,
      before,
      after,
      ctx,
    });
    return after;
  });
}

export async function softDeleteVendorProduct(
  db: PrismaClient,
  id: string,
  ctx?: AuditContext,
): Promise<VendorProduct> {
  return db.$transaction(async (tx) => {
    const before = await tx.vendorProduct.findUnique({ where: { id } });
    if (!before) throw new Error(`VendorProduct not found: ${id}`);
    if (before.deletedAt) throw new Error('VendorProduct is already soft-deleted');

    await lockVendor(tx, before.vendorId);

    const after = await tx.vendorProduct.update({
      where: { id },
      data: {
        deletedAt: new Date(),
        // Clear flags atomically with soft-delete so a row never sits in
        // primary+deleted state.
        isPrimary: false,
        active: false,
      },
    });
    await audit(tx, {
      action: AuditAction.DELETE,
      entityType: 'VendorProduct',
      entityId: id,
      before,
      after,
      ctx,
    });
    return after;
  });
}

export async function setPrimaryVendorForVariant(
  db: PrismaClient,
  vendorProductId: string,
  ctx?: AuditContext,
): Promise<VendorProduct> {
  return db.$transaction(async (tx) => {
    const before = await tx.vendorProduct.findUnique({ where: { id: vendorProductId } });
    if (!before) throw new Error(`VendorProduct not found: ${vendorProductId}`);
    if (before.deletedAt) throw new Error('VendorProduct is soft-deleted');

    await lockVendor(tx, before.vendorId);
    await clearOtherPrimariesForVariant(tx, before.variantId, before.id);

    const after = await tx.vendorProduct.update({
      where: { id: vendorProductId },
      data: { isPrimary: true },
    });
    await audit(tx, {
      action: AuditAction.UPDATE,
      entityType: 'VendorProduct',
      entityId: vendorProductId,
      before,
      after,
      ctx: { ...ctx, reason: 'set as primary vendor for variant' },
    });
    return after;
  });
}

export async function listVendorProducts(
  db: PrismaClient,
  vendorId: string,
): Promise<VendorProduct[]> {
  return db.vendorProduct.findMany({
    where: { vendorId, deletedAt: null },
    orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
  });
}

export async function listVendorsForVariant(
  db: PrismaClient,
  variantId: string,
): Promise<VendorProduct[]> {
  return db.vendorProduct.findMany({
    where: { variantId, deletedAt: null },
    orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
  });
}
