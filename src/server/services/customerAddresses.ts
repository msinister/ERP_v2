import { AuditAction, Prisma } from '@/generated/tenant';
import type {
  AddressKind,
  CustomerAddress,
  PrismaClient,
} from '@/generated/tenant';
import { audit, type AuditContext } from '@/lib/audit/audit';
import {
  addressInputSchema,
  updateAddressInputSchema,
  type AddressInput,
  type UpdateAddressInput,
} from '@/lib/validation/customers';

// Customer address service. Maintains the invariant "exactly one
// isDefault=true row per (customerId, kind) among non-deleted rows" —
// also enforced by the partial unique index
// `customeraddress_default_per_kind_idx`.
//
// All write paths take a SELECT ... FOR UPDATE on the parent customer
// row inside the transaction. Two parallel setDefault calls against the
// same (customer, kind) thus serialize on the customer row, so neither
// can race past the "clear the old default" step before the other runs
// its insert/update.

type AddressLockMode = 'lock' | 'no-lock';

async function lockCustomer(
  tx: Prisma.TransactionClient,
  customerId: string,
  mode: AddressLockMode = 'lock',
): Promise<void> {
  if (mode === 'no-lock') return;
  await tx.$executeRaw`SELECT 1 FROM "Customer" WHERE "id" = ${customerId} FOR UPDATE`;
}

async function clearOtherDefaults(
  tx: Prisma.TransactionClient,
  customerId: string,
  kind: AddressKind,
  exceptAddressId: string | null,
): Promise<void> {
  await tx.customerAddress.updateMany({
    where: {
      customerId,
      kind,
      isDefault: true,
      deletedAt: null,
      ...(exceptAddressId ? { NOT: { id: exceptAddressId } } : {}),
    },
    data: { isDefault: false },
  });
}

// ---------------------------------------------------------------------------
// Tx variants — used by the customer service's composite create.
// ---------------------------------------------------------------------------

export async function addAddressTx(
  tx: Prisma.TransactionClient,
  customerId: string,
  input: AddressInput,
  ctx?: AuditContext,
): Promise<CustomerAddress> {
  const data = addressInputSchema.parse(input);
  await lockCustomer(tx, customerId);

  // For BILLING the spec is "one billing address per customer"; we
  // enforce that here by treating any newly-created billing address as
  // the (only) default and clearing prior defaults of the same kind.
  // For SHIPPING the caller chooses isDefault explicitly.
  const willBeDefault =
    data.kind === 'BILLING'
      ? true
      : 'isDefault' in data && data.isDefault === true;

  if (willBeDefault) {
    await clearOtherDefaults(tx, customerId, data.kind, null);
  }

  const created = await tx.customerAddress.create({
    data: {
      customerId,
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
    entityType: 'CustomerAddress',
    entityId: created.id,
    after: created,
    ctx,
  });
  return created;
}

// ---------------------------------------------------------------------------
// Public wrappers
// ---------------------------------------------------------------------------

export async function addAddress(
  db: PrismaClient,
  customerId: string,
  input: AddressInput,
  ctx?: AuditContext,
): Promise<CustomerAddress> {
  return db.$transaction((tx) => addAddressTx(tx, customerId, input, ctx));
}

export async function updateAddress(
  db: PrismaClient,
  addressId: string,
  input: UpdateAddressInput,
  ctx?: AuditContext,
): Promise<CustomerAddress> {
  const data = updateAddressInputSchema.parse(input);
  return db.$transaction(async (tx) => {
    const before = await tx.customerAddress.findUnique({ where: { id: addressId } });
    if (!before) throw new Error(`CustomerAddress not found: ${addressId}`);
    if (before.deletedAt) throw new Error('CustomerAddress is soft-deleted');

    await lockCustomer(tx, before.customerId);

    const becomingDefault = data.isDefault === true && before.isDefault === false;
    if (becomingDefault) {
      await clearOtherDefaults(tx, before.customerId, before.kind, before.id);
    }

    const updateData: Prisma.CustomerAddressUpdateInput = {};
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

    const after = await tx.customerAddress.update({
      where: { id: addressId },
      data: updateData,
    });

    await audit(tx, {
      action: AuditAction.UPDATE,
      entityType: 'CustomerAddress',
      entityId: addressId,
      before,
      after,
      ctx,
    });
    return after;
  });
}

/**
 * Soft-delete an address. If the address has isDefault=true, the flag is
 * cleared in the SAME transaction — otherwise the row would still occupy
 * the "default for (customer, kind)" slot from the application's point
 * of view, blocking a new default from being set, and leaving a "ghost
 * default" where the partial unique index would also disagree (the
 * index ignores deleted rows so it'd still allow a new default — but
 * the inconsistency between in-DB state and observable state would
 * surface as confusing reads).
 */
export async function softDeleteAddress(
  db: PrismaClient,
  addressId: string,
  ctx?: AuditContext,
): Promise<CustomerAddress> {
  return db.$transaction(async (tx) => {
    const before = await tx.customerAddress.findUnique({ where: { id: addressId } });
    if (!before) throw new Error(`CustomerAddress not found: ${addressId}`);
    if (before.deletedAt) throw new Error('CustomerAddress is already soft-deleted');

    await lockCustomer(tx, before.customerId);

    const after = await tx.customerAddress.update({
      where: { id: addressId },
      data: {
        deletedAt: new Date(),
        // Clear the flag atomically with the soft-delete so the row
        // doesn't sit in a default+deleted state.
        isDefault: false,
      },
    });

    await audit(tx, {
      action: AuditAction.DELETE,
      entityType: 'CustomerAddress',
      entityId: addressId,
      before,
      after,
      ctx,
    });
    return after;
  });
}

export async function setDefaultAddress(
  db: PrismaClient,
  addressId: string,
  ctx?: AuditContext,
): Promise<CustomerAddress> {
  return db.$transaction(async (tx) => {
    const before = await tx.customerAddress.findUnique({ where: { id: addressId } });
    if (!before) throw new Error(`CustomerAddress not found: ${addressId}`);
    if (before.deletedAt) throw new Error('CustomerAddress is soft-deleted');

    await lockCustomer(tx, before.customerId);
    await clearOtherDefaults(tx, before.customerId, before.kind, before.id);

    const after = await tx.customerAddress.update({
      where: { id: addressId },
      data: { isDefault: true },
    });

    await audit(tx, {
      action: AuditAction.UPDATE,
      entityType: 'CustomerAddress',
      entityId: addressId,
      before,
      after,
      ctx: { ...ctx, reason: 'set as default for kind' },
    });
    return after;
  });
}

export async function listAddresses(
  db: PrismaClient,
  customerId: string,
  filters: { kind?: AddressKind } = {},
): Promise<CustomerAddress[]> {
  return db.customerAddress.findMany({
    where: {
      customerId,
      deletedAt: null,
      ...(filters.kind ? { kind: filters.kind } : {}),
    },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
  });
}
