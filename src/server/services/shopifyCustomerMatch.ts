import type {
  Customer,
  PrismaClient,
  ShopifyStore,
} from '@/generated/tenant';
import type {
  ShopifyAddress,
  ShopifyOrder,
} from '@/lib/integrations/shopify/types';
import { createCustomer } from '@/server/services/customers';
import type { AuditContext } from '@/lib/audit/audit';

// =============================================================================
// Customer matching for Shopify order import.
//
// Resolution cascade per the order-sync spec:
//   1. shopifyCustomerId match → use that customer.
//   2. Email match (single ERP customer, no shopifyCustomerId yet) →
//      auto-link the id onto the customer and use it.
//   3. Email match (single ERP customer, but a DIFFERENT shopifyCustomerId
//      is already set) → AMBIGUOUS. Queue a PendingOrderReview.
//   4. Email match (multiple ERP customers) → AMBIGUOUS. Queue a
//      PendingOrderReview.
//   5. No match anywhere → create a new ERP customer using the store's
//      defaults (salesRep / paymentTerm / customerType / warehouse).
//
// Returns either { kind: 'matched', customerId } when the order can
// proceed straight to importShopifyOrder, or { kind: 'ambiguous',
// reason, matchedCustomerId? } when the caller should park a review
// instead of importing. The caller is responsible for creating the
// PendingOrderReview row — keeping that out of here means the matching
// logic stays unit-testable in isolation.
// =============================================================================

export type CustomerMatchResult =
  | { kind: 'matched'; customerId: string }
  | {
      kind: 'ambiguous';
      reason: 'EMAIL_MATCH_DIFFERENT_ID' | 'MULTIPLE_EMAIL_MATCHES';
      matchedCustomerId: string | null;
    };

type StoreDefaults = Pick<
  ShopifyStore,
  | 'defaultWarehouseId'
  | 'defaultSalesRepId'
  | 'defaultPaymentTermId'
  | 'defaultCustomerType'
>;

export class StoreNotConfiguredForOrderSyncError extends Error {
  constructor(storeId: string, missing: string[]) {
    super(
      `ShopifyStore ${storeId} is missing required order-sync defaults: ${missing.join(', ')}. Set them on the store edit page before importing orders.`,
    );
    this.name = 'StoreNotConfiguredForOrderSyncError';
  }
}

/**
 * Run the matching cascade WITHOUT auto-creating a new customer. Used by
 * the importer when it wants to peek at the match result before deciding
 * to import-or-queue. Email auto-link side effect still fires when a
 * single ERP customer matches by email and has no shopifyCustomerId.
 */
export async function matchCustomerForShopifyOrder(
  db: PrismaClient,
  order: ShopifyOrder,
): Promise<CustomerMatchResult | { kind: 'no_match' }> {
  // Shopify id match — cheap point lookup.
  const shopifyCustomerId = order.customer?.id?.toString();
  if (shopifyCustomerId) {
    const byId = await db.customer.findFirst({
      where: { shopifyCustomerId, deletedAt: null },
      select: { id: true },
    });
    if (byId) return { kind: 'matched', customerId: byId.id };
  }

  // Email match — normalize to lowercase for the lookup. Shopify
  // sometimes lowercases emails, sometimes not; ERP primaryEmail is
  // case-preserved.
  const email = (order.customer?.email ?? order.email ?? '').trim();
  if (!email) return { kind: 'no_match' };
  const byEmail = await db.customer.findMany({
    where: {
      primaryEmail: { equals: email, mode: 'insensitive' },
      deletedAt: null,
    },
    select: { id: true, shopifyCustomerId: true },
  });

  if (byEmail.length === 0) return { kind: 'no_match' };

  if (byEmail.length > 1) {
    return {
      kind: 'ambiguous',
      reason: 'MULTIPLE_EMAIL_MATCHES',
      matchedCustomerId: null,
    };
  }

  // Exactly one email match.
  const sole = byEmail[0]!;
  if (sole.shopifyCustomerId == null && shopifyCustomerId) {
    // Auto-link the missing id and proceed. Side effect of the matching
    // call — same semantics the spec calls for. Idempotent: a re-run
    // would find this customer via the shopifyCustomerId branch above.
    await db.customer.update({
      where: { id: sole.id },
      data: { shopifyCustomerId },
    });
    return { kind: 'matched', customerId: sole.id };
  }
  if (sole.shopifyCustomerId == null && !shopifyCustomerId) {
    // Email matches, but Shopify gave us no customer id at all
    // (uncommon — guest checkout sometimes does this). Safe to proceed
    // under that single customer; no link to record.
    return { kind: 'matched', customerId: sole.id };
  }
  if (sole.shopifyCustomerId === shopifyCustomerId) {
    return { kind: 'matched', customerId: sole.id };
  }
  // Email match + a DIFFERENT shopifyCustomerId already on the customer.
  return {
    kind: 'ambiguous',
    reason: 'EMAIL_MATCH_DIFFERENT_ID',
    matchedCustomerId: sole.id,
  };
}

/**
 * Auto-create an ERP customer from a Shopify order payload using the
 * store's configured defaults. Throws StoreNotConfiguredForOrderSyncError
 * if the required defaults aren't set. Wraps createCustomer so the
 * standard audit + activity rows happen.
 */
export async function createCustomerFromShopifyOrder(
  db: PrismaClient,
  order: ShopifyOrder,
  store: StoreDefaults & { id: string },
  ctx?: AuditContext,
): Promise<Customer> {
  const missing: string[] = [];
  if (!store.defaultSalesRepId) missing.push('defaultSalesRepId');
  if (!store.defaultPaymentTermId) missing.push('defaultPaymentTermId');
  if (!store.defaultCustomerType) missing.push('defaultCustomerType');
  if (missing.length > 0) {
    throw new StoreNotConfiguredForOrderSyncError(store.id, missing);
  }

  const c = order.customer;
  const billing = order.billing_address ?? c?.default_address ?? null;
  const shipping = order.shipping_address ?? null;

  const first = c?.first_name?.trim() ?? billing?.first_name?.trim() ?? '';
  const last = c?.last_name?.trim() ?? billing?.last_name?.trim() ?? '';
  const fullName = [first, last].filter(Boolean).join(' ').trim();
  const email = (c?.email ?? order.email ?? '').trim();
  const company = billing?.company?.trim() ?? '';

  // Display-name priority: company → "First Last" → email → fallback. We
  // also append a uniqueness suffix when the chosen name collides — the
  // Customer model has a citext-unique constraint on `name`.
  const candidate =
    company || fullName || email || `Shopify customer ${c?.id ?? 'unknown'}`;
  const name = await uniqueDisplayName(db, candidate);

  return createCustomer(
    db,
    {
      name,
      type: store.defaultCustomerType!,
      salesRepId: store.defaultSalesRepId!,
      paymentTermId: store.defaultPaymentTermId!,
      primaryPhone: (c?.phone ?? order.phone ?? billing?.phone ?? '').trim() || undefined,
      primaryEmail: email || undefined,
      shopifyCustomerId: c?.id ? String(c.id) : undefined,
      billingAddress: billing
        ? toBillingAddressInput(billing)
        : undefined,
      defaultShippingAddress: shipping
        ? toShippingAddressInput(shipping, true)
        : undefined,
      // No additional ship-tos on initial create; subsequent orders to a
      // different address use the "add as new address" resolve action.
      createdById: ctx?.userId ?? undefined,
    },
    ctx,
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function uniqueDisplayName(
  db: PrismaClient,
  candidate: string,
): Promise<string> {
  const base = candidate.slice(0, 240);
  const existing = await db.customer.findFirst({
    where: { name: { equals: base, mode: 'insensitive' } },
    select: { id: true },
  });
  if (!existing) return base;
  // Collision → append a short numeric suffix until we land on a free
  // slot. Bounded loop with a generous cap; one or two iterations covers
  // every realistic case.
  for (let i = 2; i < 50; i++) {
    const next = `${base} (${i})`;
    const hit = await db.customer.findFirst({
      where: { name: { equals: next, mode: 'insensitive' } },
      select: { id: true },
    });
    if (!hit) return next;
  }
  // Fall back to a timestamp suffix — practically never hit, but it
  // guarantees the create won't throw on the unique index.
  return `${base} (${Date.now()})`;
}

function toBillingAddressInput(a: ShopifyAddress) {
  return {
    kind: 'BILLING' as const,
    line1: (a.address1 ?? '').trim() || '(no street)',
    line2: a.address2?.trim() || undefined,
    city: (a.city ?? '').trim() || '(no city)',
    region: (a.province_code ?? a.province ?? '').trim() || 'XX',
    postalCode: (a.zip ?? '').trim() || '00000',
    country: normalizeCountry(a.country_code, a.country),
    attention:
      [a.first_name, a.last_name].filter(Boolean).join(' ').trim() ||
      undefined,
    phone: a.phone?.trim() || undefined,
  };
}

function toShippingAddressInput(a: ShopifyAddress, isDefault: boolean) {
  return {
    kind: 'SHIPPING' as const,
    isDefault,
    label: 'Shopify ship-to',
    line1: (a.address1 ?? '').trim() || '(no street)',
    line2: a.address2?.trim() || undefined,
    city: (a.city ?? '').trim() || '(no city)',
    region: (a.province_code ?? a.province ?? '').trim() || 'XX',
    postalCode: (a.zip ?? '').trim() || '00000',
    country: normalizeCountry(a.country_code, a.country),
    attention:
      [a.first_name, a.last_name].filter(Boolean).join(' ').trim() ||
      undefined,
    phone: a.phone?.trim() || undefined,
  };
}

function normalizeCountry(code: string | null, name: string | null): string {
  const c = (code ?? '').trim().toUpperCase();
  if (c.length === 2) return c;
  // Shopify usually sets country_code; if not, fall back to "US" rather
  // than try to map full names. The operator can edit the customer
  // post-import if the country was wrong.
  if (name && name.toLowerCase().includes('united states')) return 'US';
  return 'US';
}

