import { AuditAction, Prisma } from '@/generated/tenant';
import type {
  CustomerPaymentMethod,
  PrismaClient,
} from '@/generated/tenant';
import { audit, type AuditContext } from '@/lib/audit/audit';
import {
  createPaymentMethodInputSchema,
  updatePaymentMethodInputSchema,
  type CreatePaymentMethodInput,
  type UpdatePaymentMethodInput,
} from '@/lib/validation/customers';

// Customer payment methods. Authorize.Net CIM tokens ONLY — this service
// must NEVER accept, log, or persist a PAN. The validation layer
// (createPaymentMethodInputSchema) is the gate that rejects PAN-shaped
// strings outright; this layer trusts validation but treats CIM token
// IDs themselves as sensitive enough to warrant audit-row redaction
// (see redactForAudit below). See CLAUDE.md non-negotiable rules.

// Invariant: exactly one isPreferred=true per customer among non-deleted
// rows — also enforced by the partial unique index
// `customerpaymentmethod_preferred_idx`. Service-layer maintenance
// uses SELECT ... FOR UPDATE on the parent customer row + clear-others
// -then-set, mirroring the address default / contact primary patterns.

async function lockCustomer(
  tx: Prisma.TransactionClient,
  customerId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT 1 FROM "Customer" WHERE "id" = ${customerId} FOR UPDATE`;
}

async function clearOtherPreferred(
  tx: Prisma.TransactionClient,
  customerId: string,
  exceptId: string | null,
): Promise<void> {
  await tx.customerPaymentMethod.updateMany({
    where: {
      customerId,
      isPreferred: true,
      deletedAt: null,
      ...(exceptId ? { NOT: { id: exceptId } } : {}),
    },
    data: { isPreferred: false },
  });
}

/**
 * Redact CIM identifiers in a payment-method record before it lands in
 * the audit log. The full token IDs are sensitive — even though they
 * are not PANs, leaking them gives an attacker a useful pivot. We keep
 * only the last 4 characters of authorizeNetPaymentProfileId for the
 * audit JSON; everything else (id, customerId, brand, last4, exp,
 * preferred flag, timestamps) stays as-is so the audit row remains
 * useful for incident investigation.
 */
function redactForAudit(row: CustomerPaymentMethod): Record<string, unknown> {
  const tail = (s: string) => (s.length > 4 ? `…${s.slice(-4)}` : '****');
  return {
    ...row,
    authorizeNetPaymentProfileId: tail(row.authorizeNetPaymentProfileId),
  };
}

// ---------------------------------------------------------------------------
// CRUD + lifecycle
// ---------------------------------------------------------------------------

export async function createPaymentMethod(
  db: PrismaClient,
  customerId: string,
  input: CreatePaymentMethodInput,
  ctx?: AuditContext,
): Promise<CustomerPaymentMethod> {
  const data = createPaymentMethodInputSchema.parse(input);
  return db.$transaction(async (tx) => {
    await lockCustomer(tx, customerId);
    if (data.isPreferred) {
      await clearOtherPreferred(tx, customerId, null);
    }
    const created = await tx.customerPaymentMethod.create({
      data: {
        customerId,
        authorizeNetCustomerProfileId: data.authorizeNetCustomerProfileId,
        authorizeNetPaymentProfileId: data.authorizeNetPaymentProfileId,
        brand: data.brand ?? null,
        last4: data.last4 ?? null,
        expirationMonth: data.expirationMonth ?? null,
        expirationYear: data.expirationYear ?? null,
        isPreferred: data.isPreferred ?? false,
        active: data.active ?? true,
      },
    });
    await audit(tx, {
      action: AuditAction.CREATE,
      entityType: 'CustomerPaymentMethod',
      entityId: created.id,
      after: redactForAudit(created),
      ctx,
    });
    return created;
  });
}

export async function updatePaymentMethod(
  db: PrismaClient,
  id: string,
  input: UpdatePaymentMethodInput,
  ctx?: AuditContext,
): Promise<CustomerPaymentMethod> {
  const data = updatePaymentMethodInputSchema.parse(input);
  return db.$transaction(async (tx) => {
    const before = await tx.customerPaymentMethod.findUnique({ where: { id } });
    if (!before) throw new Error(`CustomerPaymentMethod not found: ${id}`);
    if (before.deletedAt) throw new Error('CustomerPaymentMethod is soft-deleted');

    await lockCustomer(tx, before.customerId);

    const becomingPreferred = data.isPreferred === true && before.isPreferred === false;
    if (becomingPreferred) {
      await clearOtherPreferred(tx, before.customerId, before.id);
    }

    const updateData: Prisma.CustomerPaymentMethodUpdateInput = {};
    if ('brand' in data) updateData.brand = data.brand ?? null;
    if ('last4' in data) updateData.last4 = data.last4 ?? null;
    if ('expirationMonth' in data) updateData.expirationMonth = data.expirationMonth ?? null;
    if ('expirationYear' in data) updateData.expirationYear = data.expirationYear ?? null;
    if (data.isPreferred !== undefined) updateData.isPreferred = data.isPreferred;
    if (data.active !== undefined) updateData.active = data.active;

    const after = await tx.customerPaymentMethod.update({ where: { id }, data: updateData });

    await audit(tx, {
      action: AuditAction.UPDATE,
      entityType: 'CustomerPaymentMethod',
      entityId: id,
      before: redactForAudit(before),
      after: redactForAudit(after),
      ctx,
    });
    return after;
  });
}

/**
 * Soft-delete a payment method. If the row has isPreferred=true, the
 * flag is cleared in the SAME transaction — same rationale as
 * softDeleteAddress / softDeleteContact: avoids a "ghost preferred"
 * deleted row, and frees the singleton slot so a new preferred can be
 * set immediately without colliding with the partial unique index.
 */
export async function softDeletePaymentMethod(
  db: PrismaClient,
  id: string,
  ctx?: AuditContext,
): Promise<CustomerPaymentMethod> {
  return db.$transaction(async (tx) => {
    const before = await tx.customerPaymentMethod.findUnique({ where: { id } });
    if (!before) throw new Error(`CustomerPaymentMethod not found: ${id}`);
    if (before.deletedAt) throw new Error('CustomerPaymentMethod is already soft-deleted');

    await lockCustomer(tx, before.customerId);

    const after = await tx.customerPaymentMethod.update({
      where: { id },
      data: { deletedAt: new Date(), isPreferred: false },
    });

    await audit(tx, {
      action: AuditAction.DELETE,
      entityType: 'CustomerPaymentMethod',
      entityId: id,
      before: redactForAudit(before),
      after: redactForAudit(after),
      ctx,
    });
    return after;
  });
}

export async function setPreferred(
  db: PrismaClient,
  id: string,
  ctx?: AuditContext,
): Promise<CustomerPaymentMethod> {
  return db.$transaction(async (tx) => {
    const before = await tx.customerPaymentMethod.findUnique({ where: { id } });
    if (!before) throw new Error(`CustomerPaymentMethod not found: ${id}`);
    if (before.deletedAt) throw new Error('CustomerPaymentMethod is soft-deleted');

    await lockCustomer(tx, before.customerId);
    await clearOtherPreferred(tx, before.customerId, before.id);

    const after = await tx.customerPaymentMethod.update({
      where: { id },
      data: { isPreferred: true },
    });
    await audit(tx, {
      action: AuditAction.UPDATE,
      entityType: 'CustomerPaymentMethod',
      entityId: id,
      before: redactForAudit(before),
      after: redactForAudit(after),
      ctx: { ...ctx, reason: 'set as preferred payment method' },
    });
    return after;
  });
}

export async function getPaymentMethod(
  db: PrismaClient,
  id: string,
): Promise<CustomerPaymentMethod | null> {
  return db.customerPaymentMethod.findFirst({
    where: { id, deletedAt: null },
  });
}

export async function listPaymentMethodsForCustomer(
  db: PrismaClient,
  customerId: string,
): Promise<CustomerPaymentMethod[]> {
  return db.customerPaymentMethod.findMany({
    where: { customerId, deletedAt: null },
    orderBy: [{ isPreferred: 'desc' }, { createdAt: 'desc' }],
  });
}

/**
 * Cards expiring within the next N days (where "expiring" means the
 * card's last valid month is at or before the cutoff month). Used by
 * the dashboard widget per docs/03-customers.md ("card expiring in 30
 * days"). Excludes soft-deleted rows. Returned shape includes the
 * customer name for the widget but redacts the CIM payment-profile id.
 */
export async function findPaymentMethodsExpiringWithin(
  db: PrismaClient,
  days: number,
  now: Date = new Date(),
): Promise<
  Array<{
    id: string;
    customerId: string;
    customerName: string;
    brand: string | null;
    last4: string | null;
    expirationMonth: number;
    expirationYear: number;
  }>
> {
  if (days < 0) throw new Error('days must be >= 0');
  const cutoff = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  const cutoffYM = cutoff.getUTCFullYear() * 12 + cutoff.getUTCMonth() + 1;
  const nowYM = now.getUTCFullYear() * 12 + now.getUTCMonth() + 1;

  // Pull candidates whose expiration year is in range, then filter by
  // year*12+month to handle the across-year boundary cleanly. The
  // composite index (expirationYear, expirationMonth) keeps this fast.
  const candidates = await db.customerPaymentMethod.findMany({
    where: {
      deletedAt: null,
      expirationYear: { not: null, gte: now.getUTCFullYear(), lte: cutoff.getUTCFullYear() },
      expirationMonth: { not: null },
    },
    include: { customer: { select: { name: true } } },
    orderBy: [{ expirationYear: 'asc' }, { expirationMonth: 'asc' }],
  });
  return candidates
    .filter((p) => {
      const ym = (p.expirationYear ?? 0) * 12 + (p.expirationMonth ?? 0);
      return ym >= nowYM && ym <= cutoffYM;
    })
    .map((p) => ({
      id: p.id,
      customerId: p.customerId,
      customerName: p.customer.name,
      brand: p.brand,
      last4: p.last4,
      expirationMonth: p.expirationMonth!,
      expirationYear: p.expirationYear!,
    }));
}
