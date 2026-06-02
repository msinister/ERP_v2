import { AuditAction, CustomerActivityKind, Prisma } from '@/generated/tenant';
import type {
  Customer,
  CustomerType as CustomerTypeEnum,
  PrismaClient,
} from '@/generated/tenant';
import { audit, type AuditContext } from '@/lib/audit/audit';
import { getNextSequence } from '@/lib/sequences/sequences';
import {
  createCustomerInputSchema,
  updateCustomerInputSchema,
  type CreateCustomerInput,
  type UpdateCustomerInput,
} from '@/lib/validation/customers';
import { addAddressTx } from '@/server/services/customerAddresses';
import { createContactTx } from '@/server/services/customerContacts';

// Customer master service. Replaces the SO-slice stub.
//
// docs/03-customers.md drives the shape: required customer ID + display
// name + type + sales rep + payment term + billing address + (default)
// ship-to. Composite create writes everything in one transaction so a
// half-built customer is impossible.
//
// Two writes-on-sensitive-changes intentionally:
//   - AuditLog       — security/compliance ledger; tamper-evident, retained
//   - CustomerActivity — customer-facing timeline a salesperson reads
//                        on the customer page. detailJson on AUTO entries
//                        follows { field, from, to } per the schema doc.

const CUSTOMER_SEQUENCE_NAME = 'customer';
const CUSTOMER_PREFIX = 'CUST';

// Fields whose changes are surfaced in the customer-facing activity log.
// Updates to OTHER fields still write to AuditLog (every state change is
// tracked there) but don't pollute the customer timeline.
const ACTIVITY_TRACKED_FIELDS = [
  'creditLimit',
  'arHoldDays',
  'taxExempt',
  'salesRepId',
  'paymentTermId',
  'type',
] as const;

export type CustomerWithRelations = Customer & {
  addresses?: Array<{ id: string; kind: string; isDefault: boolean }>;
  contacts?: Array<{ id: string; isPrimary: boolean }>;
};

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export async function createCustomer(
  db: PrismaClient,
  input: CreateCustomerInput,
  ctx?: AuditContext,
): Promise<Customer> {
  const data = createCustomerInputSchema.parse(input);
  return db.$transaction(async (tx) => {
    // Allocate CUST-YYYY-NNNNN unless the caller explicitly supplied a
    // code (used by the migration importer / manual fixtures).
    let code = data.code;
    if (!code) {
      const seq = await getNextSequence(tx, {
        name: CUSTOMER_SEQUENCE_NAME,
        prefix: CUSTOMER_PREFIX,
        useYear: true,
      });
      code = seq.formatted;
    }

    const customer = await tx.customer.create({
      data: {
        code,
        name: data.name,
        type: data.type ?? 'WHOLESALE_REGULAR',
        salesRep: { connect: { id: data.salesRepId } },
        paymentTerm: { connect: { id: data.paymentTermId } },
        creditLimit:
          data.creditLimit != null ? new Prisma.Decimal(data.creditLimit) : null,
        arHoldDays: data.arHoldDays ?? null,
        taxExempt: data.taxExempt ?? false,
        resaleCertNumber: data.resaleCertNumber ?? null,
        primaryPhone: data.primaryPhone ?? null,
        primaryEmail: data.primaryEmail ?? null,
        internalNotes: data.internalNotes ?? null,
        costPlusPercent:
          data.costPlusPercent != null
            ? new Prisma.Decimal(data.costPlusPercent)
            : null,
        active: data.active ?? true,
      },
    });

    // Composite payload — write addresses + contacts inside the same tx
    // via the *Tx variants so the singleton invariants (one default per
    // kind, one primary contact) are enforced atomically. Billing
    // address is optional; operator can add one later from the detail
    // page.
    if (data.billingAddress) {
      await addAddressTx(tx, customer.id, data.billingAddress, ctx);
    }
    if (data.defaultShippingAddress) {
      await addAddressTx(
        tx,
        customer.id,
        // Force isDefault=true on the explicit "default ship-to" slot.
        { ...data.defaultShippingAddress, isDefault: true },
        ctx,
      );
    }
    if (data.additionalShippingAddresses) {
      for (const addr of data.additionalShippingAddresses) {
        await addAddressTx(tx, customer.id, addr, ctx);
      }
    }
    if (data.contacts) {
      for (const contact of data.contacts) {
        await createContactTx(tx, customer.id, contact, ctx);
      }
    }
    if (data.tagLabels) {
      for (const label of data.tagLabels) {
        const tag = await tx.customerTag.upsert({
          where: { label },
          create: { label },
          update: {},
        });
        await tx.customerTagAssignment.upsert({
          where: { customerId_tagId: { customerId: customer.id, tagId: tag.id } },
          create: { customerId: customer.id, tagId: tag.id },
          update: {},
        });
      }
    }
    if (data.categoryIds) {
      for (const categoryId of data.categoryIds) {
        await tx.customerCategoryAssignment.upsert({
          where: {
            customerId_categoryId: { customerId: customer.id, categoryId },
          },
          create: { customerId: customer.id, categoryId },
          update: {},
        });
      }
    }

    await audit(tx, {
      action: AuditAction.CREATE,
      entityType: 'Customer',
      entityId: customer.id,
      after: customer,
      ctx: {
        userId: ctx?.userId ?? data.createdById ?? null,
        ipAddress: ctx?.ipAddress,
        reason: ctx?.reason,
      },
    });
    // Seed activity row so the customer page has a non-empty timeline.
    await tx.customerActivity.create({
      data: {
        customerId: customer.id,
        kind: CustomerActivityKind.AUTO,
        summary: 'customer_created',
        createdById: ctx?.userId ?? data.createdById ?? null,
      },
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

    const updateData: Prisma.CustomerUpdateInput = {};
    if (data.name !== undefined) updateData.name = data.name;
    if (data.type !== undefined) updateData.type = data.type;
    if (data.salesRepId !== undefined) {
      updateData.salesRep = { connect: { id: data.salesRepId } };
    }
    if (data.paymentTermId !== undefined) {
      updateData.paymentTerm = { connect: { id: data.paymentTermId } };
    }
    if ('creditLimit' in data) {
      updateData.creditLimit =
        data.creditLimit != null ? new Prisma.Decimal(data.creditLimit) : null;
    }
    if ('arHoldDays' in data) updateData.arHoldDays = data.arHoldDays ?? null;
    if (data.taxExempt !== undefined) updateData.taxExempt = data.taxExempt;
    if ('resaleCertNumber' in data) updateData.resaleCertNumber = data.resaleCertNumber ?? null;
    if ('primaryPhone' in data) updateData.primaryPhone = data.primaryPhone ?? null;
    if ('primaryEmail' in data) updateData.primaryEmail = data.primaryEmail ?? null;
    if ('internalNotes' in data) updateData.internalNotes = data.internalNotes ?? null;
    if ('costPlusPercent' in data) {
      updateData.costPlusPercent =
        data.costPlusPercent != null ? new Prisma.Decimal(data.costPlusPercent) : null;
    }
    if (data.active !== undefined) updateData.active = data.active;

    const after = await tx.customer.update({ where: { id }, data: updateData });

    // AuditLog row first — every state change is in the security ledger.
    await audit(tx, {
      action: AuditAction.UPDATE,
      entityType: 'Customer',
      entityId: id,
      before,
      after,
      ctx,
    });

    // Then a CustomerActivity AUTO row per tracked field that actually
    // changed. Both writes are intentional — see module-header comment.
    for (const field of ACTIVITY_TRACKED_FIELDS) {
      const fromVal = serializeFieldValue((before as Record<string, unknown>)[field]);
      const toVal = serializeFieldValue((after as Record<string, unknown>)[field]);
      if (!shallowEqual(fromVal, toVal)) {
        await tx.customerActivity.create({
          data: {
            customerId: id,
            kind: CustomerActivityKind.AUTO,
            summary: `${field}_changed`,
            detailJson: { field, from: fromVal, to: toVal },
            createdById: ctx?.userId ?? null,
          },
        });
      }
    }

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

    const liveSoCount = await tx.salesOrder.count({
      where: { customerId: id, deletedAt: null },
    });
    if (liveSoCount > 0) {
      throw new Error(
        `Cannot soft-delete Customer: ${liveSoCount} non-deleted sales order(s) reference it; soft-delete those first or move them to another customer`,
      );
    }

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
  // Optional data-scope fragment (lib/permissions/scope.customerScopeWhere).
  // When the customer falls outside the actor's scope this returns null —
  // detail pages render not-found. Omitted by unscoped/internal callers.
  scope?: Prisma.CustomerWhereInput,
): Promise<Customer | null> {
  return db.customer.findFirst({
    where: { AND: [{ id, deletedAt: null }, scope ?? {}] },
  });
}

// ---------------------------------------------------------------------------
// Queries / list
// ---------------------------------------------------------------------------

export type CustomerListFilters = {
  active?: boolean;
  type?: CustomerTypeEnum;
  salesRepId?: string;
  tagId?: string;
  categoryId?: string;
  q?: string; // case-insensitive substring on display name (citext)
  // Data-scope fragment from lib/permissions/scope.customerScopeWhere.
  // ANDed into the where so a "view own" actor only sees their reps'
  // customers; a "view all" actor passes {} (no restriction).
  scope?: Prisma.CustomerWhereInput;
  skip?: number;
  take?: number;
};

// Internal where-clause builder shared by listCustomers + listCustomersPaged
// so the two stay byte-identical on filter semantics.
function customerWhere(
  filters: Omit<CustomerListFilters, 'skip' | 'take'>,
): Prisma.CustomerWhereInput {
  const { active, type, salesRepId, tagId, categoryId, q, scope } = filters;
  const base: Prisma.CustomerWhereInput = {
    deletedAt: null,
    ...(active !== undefined ? { active } : {}),
    ...(type ? { type } : {}),
    ...(salesRepId ? { salesRepId } : {}),
    ...(tagId ? { tags: { some: { tagId } } } : {}),
    ...(categoryId ? { categories: { some: { categoryId } } } : {}),
    // CITEXT is only case-insensitive for equality, not LIKE; use Prisma's
    // mode: 'insensitive' which produces ILIKE on Postgres.
    ...(q ? { name: { contains: q, mode: 'insensitive' as const } } : {}),
  };
  // AND (not spread) so the scope can't be clobbered by an explicit
  // salesRepId filter — both must hold.
  return scope ? { AND: [base, scope] } : base;
}

export async function listCustomers(
  db: PrismaClient,
  filters: CustomerListFilters = {},
): Promise<Customer[]> {
  const { skip = 0, take = 100, ...rest } = filters;
  return db.customer.findMany({
    where: customerWhere(rest),
    orderBy: { createdAt: 'desc' },
    skip,
    take,
  });
}

/**
 * Paginated variant. Returns the page of rows plus the unfiltered-by-
 * pagination total so callers can render "X of Y" + page links without
 * a second round-trip. Same filter semantics as listCustomers.
 *
 * Each row includes the most recent SO that carries an explicit rep
 * override so the list page can display the effective rep (SO-level
 * override beats account-level default).
 */
export async function listCustomersPaged(
  db: PrismaClient,
  filters: CustomerListFilters = {},
) {
  const { skip = 0, take = 100, ...rest } = filters;
  const where = customerWhere(rest);
  const [rows, total] = await Promise.all([
    db.customer.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take,
      include: {
        salesOrders: {
          where: { salesRepId: { not: null }, deletedAt: null },
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { salesRepId: true },
        },
      },
    }),
    db.customer.count({ where }),
  ]);
  return { rows, total };
}

/**
 * Duplicate-detection helper for the create-customer form. Returns up
 * to 5 candidates whose display name CONTAINS the input (citext
 * substring match — case-insensitive); within those, customers whose
 * default ship-to is in the same city sort first.
 *
 * Per refinement #4: this is name-AND-city-prioritized, NOT name-OR-
 * city. Matching by city alone would flag every Dallas business as a
 * duplicate of every other Dallas business.
 */
export async function findDuplicateCandidates(
  db: PrismaClient,
  args: { name: string; city?: string | null; limit?: number },
): Promise<Array<Customer & { defaultShipCity: string | null }>> {
  const limit = Math.min(args.limit ?? 5, 50);
  const matches = await db.customer.findMany({
    where: {
      deletedAt: null,
      // CITEXT only overrides equality; use ILIKE via mode:'insensitive'
      // for substring matching.
      name: { contains: args.name, mode: 'insensitive' },
    },
    include: {
      addresses: {
        where: { kind: 'SHIPPING', isDefault: true, deletedAt: null },
        take: 1,
        select: { city: true },
      },
    },
    take: limit * 4, // overfetch so we can prioritize same-city after
  });

  const wantedCity = args.city?.trim().toLowerCase() ?? null;
  const decorated = matches.map((c) => {
    const defaultShipCity = c.addresses[0]?.city ?? null;
    const sameCity =
      wantedCity && defaultShipCity && defaultShipCity.toLowerCase() === wantedCity;
    // Strip the addresses array — the public shape only exposes the
    // single defaultShipCity scalar to the caller.
    const { addresses: _addresses, ...rest } = c;
    return { ...rest, defaultShipCity, _sameCity: sameCity ? 1 : 0 };
  });

  decorated.sort((a, b) => {
    if (a._sameCity !== b._sameCity) return b._sameCity - a._sameCity;
    return a.name.localeCompare(b.name);
  });

  return decorated.slice(0, limit).map(({ _sameCity, ...rest }) => {
    void _sameCity;
    return rest;
  });
}

/**
 * Documents whose `expiresOn` falls within the next N days. Used by
 * the "documents expiring in 30 days" dashboard widget per
 * docs/03-customers.md. Excludes soft-deleted documents.
 */
export async function documentsExpiringWithin(
  db: PrismaClient,
  days: number,
): Promise<
  Array<{
    id: string;
    customerId: string;
    customerName: string;
    kind: string;
    expiresOn: Date;
  }>
> {
  if (days < 0) throw new Error('days must be >= 0');
  const now = new Date();
  const cutoff = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  const docs = await db.customerDocument.findMany({
    where: {
      deletedAt: null,
      expiresOn: { gte: now, lte: cutoff },
    },
    include: { customer: { select: { name: true } } },
    orderBy: { expiresOn: 'asc' },
  });
  return docs.map((d) => ({
    id: d.id,
    customerId: d.customerId,
    customerName: d.customer.name,
    kind: d.kind,
    expiresOn: d.expiresOn!,
  }));
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

// Make Decimal / Date / null comparable as JSON for activity logs.
function serializeFieldValue(v: unknown): string | number | boolean | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object' && v !== null && 'toString' in v) {
    // Prisma.Decimal lands here
    return (v as { toString(): string }).toString();
  }
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
    return v;
  }
  return String(v);
}

function shallowEqual(a: unknown, b: unknown): boolean {
  return a === b;
}
