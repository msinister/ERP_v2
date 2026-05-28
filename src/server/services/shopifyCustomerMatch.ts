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
//   1. ShopifyCustomerLink(storeId, shopifyCustomerId) match → use that customer.
//      Store-scoped so the same Shopify account can map to different ERP billing
//      entities on different stores (multi-location B2B with shared email).
//   2. Email match (single ERP customer, no link for this store yet) →
//      auto-create the link and use that customer.
//   3. Email match (single ERP customer, but DIFFERENT shopifyCustomerId already
//      linked for this store) → AMBIGUOUS. Queue a PendingOrderReview.
//   4. Email match (multiple ERP customers) → AMBIGUOUS. Queue a
//      PendingOrderReview.
//   5. No match anywhere → create a new ERP customer using the store's
//      defaults (salesRep / paymentTerm / customerType / warehouse) and
//      create the link.
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
      reason:
        | 'EMAIL_MATCH_DIFFERENT_ID'
        | 'MULTIPLE_EMAIL_MATCHES'
        // Email matched exactly one ERP customer but no store-scoped link
        // exists yet. Queued for operator review so they can confirm the
        // match ("use existing") or create a separate billing account
        // ("create new") — important for B2B customers with multiple
        // store locations sharing one email address.
        | 'EMAIL_MATCH_NO_STORE_LINK';
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
 * to import-or-queue. The ShopifyCustomerLink auto-create side effect
 * still fires on an email match when no link exists for this store yet.
 */
export async function matchCustomerForShopifyOrder(
  db: PrismaClient,
  order: ShopifyOrder,
  storeId: string,
): Promise<CustomerMatchResult | { kind: 'no_match' }> {
  const shopifyCustomerId = order.customer?.id?.toString();

  // Step 1: store-scoped link lookup — cheapest, most precise.
  if (shopifyCustomerId) {
    const link = await db.shopifyCustomerLink.findUnique({
      where: {
        shopifyStoreId_shopifyCustomerId: {
          shopifyStoreId: storeId,
          shopifyCustomerId,
        },
      },
      select: { customerId: true },
    });
    if (link) return { kind: 'matched', customerId: link.customerId };
  }

  // Step 2: email match — normalize to lowercase.
  const email = (order.customer?.email ?? order.email ?? '').trim();
  if (!email) return { kind: 'no_match' };

  const byEmail = await db.customer.findMany({
    where: {
      primaryEmail: { equals: email, mode: 'insensitive' },
      deletedAt: null,
    },
    select: { id: true },
  });

  if (byEmail.length === 0) return { kind: 'no_match' };

  if (byEmail.length > 1) {
    return {
      kind: 'ambiguous',
      reason: 'MULTIPLE_EMAIL_MATCHES',
      matchedCustomerId: null,
    };
  }

  // Exactly one email match. Check whether this store already has a link
  // for a DIFFERENT Shopify customer on this ERP customer.
  const sole = byEmail[0]!;

  // Look for any existing link for this store on the matched customer.
  const existingLinkForStore = await db.shopifyCustomerLink.findFirst({
    where: {
      shopifyStoreId: storeId,
      customerId: sole.id,
    },
    select: { shopifyCustomerId: true },
  });

  if (existingLinkForStore == null) {
    // No store-scoped link exists yet. For B2B wholesale, an email match
    // alone is not enough — the same email can represent different billing
    // accounts at different store locations. Queue a PendingOrderReview so
    // the operator can confirm the match ("use existing") or create a
    // separate ERP billing account ("create new"). The link is created only
    // after the operator resolves the review.
    return {
      kind: 'ambiguous',
      reason: 'EMAIL_MATCH_NO_STORE_LINK',
      matchedCustomerId: sole.id,
    };
  }

  if (existingLinkForStore.shopifyCustomerId === shopifyCustomerId) {
    // The link already exists and agrees — matched.
    return { kind: 'matched', customerId: sole.id };
  }

  // Email matches but this store already links a DIFFERENT Shopify
  // customer to this ERP customer — ambiguous, needs operator review.
  return {
    kind: 'ambiguous',
    reason: 'EMAIL_MATCH_DIFFERENT_ID',
    matchedCustomerId: sole.id,
  };
}

/**
 * Auto-create an ERP customer from a Shopify order payload using the
 * store's configured defaults, then create the ShopifyCustomerLink so
 * future orders from the same Shopify account short-circuit at step 1.
 * Throws StoreNotConfiguredForOrderSyncError if required defaults aren't set.
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

  // Display-name priority: company → "First Last" → email → fallback.
  const candidate =
    company || fullName || email || `Shopify customer ${c?.id ?? 'unknown'}`;
  const name = await uniqueDisplayName(db, candidate);

  const customer = await createCustomer(
    db,
    {
      name,
      type: store.defaultCustomerType!,
      salesRepId: store.defaultSalesRepId!,
      paymentTermId: store.defaultPaymentTermId!,
      primaryPhone: (c?.phone ?? order.phone ?? billing?.phone ?? '').trim() || undefined,
      primaryEmail: email || undefined,
      billingAddress: billing
        ? toBillingAddressInput(billing)
        : undefined,
      defaultShippingAddress: shipping
        ? toShippingAddressInput(shipping, true)
        : undefined,
      createdById: ctx?.userId ?? undefined,
    },
    ctx,
  );

  // Create the store-scoped link so future orders from this Shopify
  // customer go straight to step 1 of the matching cascade.
  const shopifyCustomerId = c?.id ? String(c.id) : null;
  if (shopifyCustomerId) {
    await db.shopifyCustomerLink.upsert({
      where: {
        shopifyStoreId_shopifyCustomerId: {
          shopifyStoreId: store.id,
          shopifyCustomerId,
        },
      },
      create: { shopifyStoreId: store.id, shopifyCustomerId, customerId: customer.id },
      update: {}, // already linked — leave it alone
    });
  }

  return customer;
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
  for (let i = 2; i < 50; i++) {
    const next = `${base} (${i})`;
    const hit = await db.customer.findFirst({
      where: { name: { equals: next, mode: 'insensitive' } },
      select: { id: true },
    });
    if (!hit) return next;
  }
  return `${base} (${Date.now()})`;
}

// Normalise a Shopify country value to a 2-letter ISO code.
// Prefers country_code (already ISO) over the full country name.
function normalizeCountry(
  code: string | null | undefined,
  name: string | null | undefined,
): string {
  const c = (code ?? '').trim().toUpperCase().slice(0, 2);
  if (c.length === 2) return c;
  // Fallback: first two letters of the country name, or 'US'
  const n = (name ?? '').trim().toUpperCase().slice(0, 2);
  return n.length === 2 ? n : 'US';
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
      [a.first_name, a.last_name].filter(Boolean).join(' ').trim() || undefined,
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
      [a.first_name, a.last_name].filter(Boolean).join(' ').trim() || undefined,
    phone: a.phone?.trim() || undefined,
  };
}
