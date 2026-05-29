import { AuditAction, Prisma } from '@/generated/tenant';
import type {
  PrismaClient,
  Vendor,
  VendorType as VendorTypeEnum,
} from '@/generated/tenant';
import { audit, type AuditContext } from '@/lib/audit/audit';
import { getNextSequence } from '@/lib/sequences/sequences';
import {
  createVendorInputSchema,
  updateVendorInputSchema,
  type CreateVendorInput,
  type UpdateVendorInput,
} from '@/lib/validation/vendors';
import { addVendorAddressTx } from '@/server/services/vendorAddresses';
import { createVendorContactTx } from '@/server/services/vendorContacts';

// Vendor master service. Replaces the stub Vendor model used by PO and
// Receipt slices. docs/04-vendors-purchasing.md drives the shape:
// auto-issued code (manual override allowed), display name, type, and
// payment term — composite create writes addresses + contacts in one tx
// so a half-built vendor is impossible.
//
// Pilot scope: drop-ship commission and payment-method records are
// deferred. `defaultCommissionRate` is accepted (schema room) but no
// service logic in pilot.

const VENDOR_SEQUENCE_NAME = 'vendor';
const VENDOR_PREFIX = 'VEND';

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export async function createVendor(
  db: PrismaClient,
  input: CreateVendorInput,
  ctx?: AuditContext,
): Promise<Vendor> {
  return db.$transaction((tx) => createVendorTx(tx, input, ctx));
}

// Tx-composable core. Runs inside a caller-supplied transaction so flows
// like logExpense can find-or-create a vendor atomically alongside the
// bill create + confirm + payment. createVendor is the standalone wrapper.
export async function createVendorTx(
  tx: Prisma.TransactionClient,
  input: CreateVendorInput,
  ctx?: AuditContext,
): Promise<Vendor> {
  const data = createVendorInputSchema.parse(input);
  let code = data.code;
  if (!code) {
    const seq = await getNextSequence(tx, {
      name: VENDOR_SEQUENCE_NAME,
      prefix: VENDOR_PREFIX,
      useYear: true,
    });
    code = seq.formatted;
  }

  const vendor = await tx.vendor.create({
    data: {
      code,
      name: data.name,
      type: data.type ?? 'STOCK',
      paymentTerm: { connect: { id: data.paymentTermId } },
      defaultCurrency: data.defaultCurrency ?? 'USD',
      minimumOrderAmount:
        data.minimumOrderAmount != null
          ? new Prisma.Decimal(data.minimumOrderAmount)
          : null,
      costChangeAlertPct:
        data.costChangeAlertPct != null
          ? new Prisma.Decimal(data.costChangeAlertPct)
          : null,
      defaultCommissionRate:
        data.defaultCommissionRate != null
          ? new Prisma.Decimal(data.defaultCommissionRate)
          : null,
      notes: data.notes ?? null,
      active: data.active ?? true,
    },
  });

  if (data.remitToAddress) {
    await addVendorAddressTx(tx, vendor.id, data.remitToAddress, ctx);
  }
  if (data.contacts) {
    for (const contact of data.contacts) {
      await createVendorContactTx(tx, vendor.id, contact, ctx);
    }
  }

  await audit(tx, {
    action: AuditAction.CREATE,
    entityType: 'Vendor',
    entityId: vendor.id,
    after: vendor,
    ctx,
  });
  return vendor;
}

export async function updateVendor(
  db: PrismaClient,
  id: string,
  input: UpdateVendorInput,
  ctx?: AuditContext,
): Promise<Vendor> {
  const data = updateVendorInputSchema.parse(input);
  return db.$transaction(async (tx) => {
    const before = await tx.vendor.findUnique({ where: { id } });
    if (!before) throw new Error(`Vendor not found: ${id}`);
    if (before.deletedAt) throw new Error('Vendor is soft-deleted');

    const updateData: Prisma.VendorUpdateInput = {};
    if (data.name !== undefined) updateData.name = data.name;
    if (data.type !== undefined) updateData.type = data.type;
    if (data.paymentTermId !== undefined) {
      updateData.paymentTerm = { connect: { id: data.paymentTermId } };
    }
    if ('defaultCurrency' in data) {
      updateData.defaultCurrency = data.defaultCurrency ?? null;
    }
    if ('minimumOrderAmount' in data) {
      updateData.minimumOrderAmount =
        data.minimumOrderAmount != null
          ? new Prisma.Decimal(data.minimumOrderAmount)
          : null;
    }
    if ('costChangeAlertPct' in data) {
      updateData.costChangeAlertPct =
        data.costChangeAlertPct != null
          ? new Prisma.Decimal(data.costChangeAlertPct)
          : null;
    }
    if ('defaultCommissionRate' in data) {
      updateData.defaultCommissionRate =
        data.defaultCommissionRate != null
          ? new Prisma.Decimal(data.defaultCommissionRate)
          : null;
    }
    if ('notes' in data) updateData.notes = data.notes ?? null;
    if (data.active !== undefined) updateData.active = data.active;

    const after = await tx.vendor.update({ where: { id }, data: updateData });
    await audit(tx, {
      action: AuditAction.UPDATE,
      entityType: 'Vendor',
      entityId: id,
      before,
      after,
      ctx,
    });
    return after;
  });
}

/**
 * Soft-delete a vendor. Blocked if the vendor has non-deleted purchase
 * orders or receipts — same dependents-check pattern as
 * softDeleteCustomer. The caller must soft-delete those first.
 */
export async function softDeleteVendor(
  db: PrismaClient,
  id: string,
  ctx?: AuditContext,
): Promise<Vendor> {
  return db.$transaction(async (tx) => {
    const before = await tx.vendor.findUnique({ where: { id } });
    if (!before) throw new Error(`Vendor not found: ${id}`);
    if (before.deletedAt) throw new Error('Vendor is already soft-deleted');

    const livePoCount = await tx.purchaseOrder.count({
      where: { vendorId: id, deletedAt: null },
    });
    if (livePoCount > 0) {
      throw new Error(
        `Cannot soft-delete Vendor: ${livePoCount} non-deleted purchase order(s) reference it; soft-delete those first or move them to another vendor`,
      );
    }
    const liveReceiptCount = await tx.receipt.count({
      where: { vendorId: id, deletedAt: null },
    });
    if (liveReceiptCount > 0) {
      throw new Error(
        `Cannot soft-delete Vendor: ${liveReceiptCount} non-deleted receipt(s) reference it; soft-delete those first`,
      );
    }

    const after = await tx.vendor.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    await audit(tx, {
      action: AuditAction.DELETE,
      entityType: 'Vendor',
      entityId: id,
      before,
      after,
      ctx,
    });
    return after;
  });
}

export async function getVendor(
  db: PrismaClient,
  id: string,
): Promise<Vendor | null> {
  return db.vendor.findFirst({ where: { id, deletedAt: null } });
}

// ---------------------------------------------------------------------------
// Queries / list
// ---------------------------------------------------------------------------

export type VendorListFilters = {
  active?: boolean;
  type?: VendorTypeEnum;
  q?: string;
  // PO vendor picker only: exclude SERVICE-only utility vendors (HEB Gas,
  // etc.) so the dropdown stays focused on vendors that actually supply
  // product. Includes any vendor whose type is STOCK / DROP_SHIP, OR
  // any vendor with at least one non-deleted VendorProduct row (covers
  // mis-typed vendors that nonetheless have catalog rows). SERVICE
  // vendors can't have catalog rows (see vendorProducts.ts), so in
  // practice this matches "type ∈ {STOCK, DROP_SHIP}".
  productVendorsOnly?: boolean;
  skip?: number;
  take?: number;
};

function vendorWhere(
  filters: Omit<VendorListFilters, 'skip' | 'take'>,
): Prisma.VendorWhereInput {
  const { active, type, q, productVendorsOnly } = filters;
  // Build the extra OR'd predicates as AND'd children so two
  // independent ORs (product-vendor filter + q search) don't clobber
  // each other when both are set.
  const and: Prisma.VendorWhereInput[] = [];
  if (productVendorsOnly) {
    and.push({
      OR: [
        { type: { in: ['STOCK', 'DROP_SHIP'] as VendorTypeEnum[] } },
        { products: { some: { deletedAt: null } } },
      ],
    });
  }
  // q matches against either the display name or the auto-issued code
  // (e.g. "VEND-2026-00012") so operators can paste either into search.
  if (q) {
    and.push({
      OR: [
        { name: { contains: q, mode: 'insensitive' as const } },
        { code: { contains: q, mode: 'insensitive' as const } },
      ],
    });
  }
  return {
    deletedAt: null,
    ...(active !== undefined ? { active } : {}),
    ...(type ? { type } : {}),
    ...(and.length ? { AND: and } : {}),
  };
}

export async function listVendors(
  db: PrismaClient,
  filters: VendorListFilters = {},
): Promise<Vendor[]> {
  const { skip = 0, take = 100, ...rest } = filters;
  return db.vendor.findMany({
    where: vendorWhere(rest),
    orderBy: { createdAt: 'desc' },
    skip,
    take,
  });
}

/**
 * Paginated variant. Returns the page of rows plus the unfiltered-by-
 * pagination total so callers can render "X of Y" + page links without
 * a second round-trip. Same filter semantics as listVendors.
 */
export async function listVendorsPaged(
  db: PrismaClient,
  filters: VendorListFilters = {},
): Promise<{ rows: Vendor[]; total: number }> {
  const { skip = 0, take = 100, ...rest } = filters;
  const where = vendorWhere(rest);
  const [rows, total] = await Promise.all([
    db.vendor.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    }),
    db.vendor.count({ where }),
  ]);
  return { rows, total };
}
