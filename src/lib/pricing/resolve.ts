import { CustomerType, Prisma, PriceResolutionRule } from '@/generated/tenant';
import {
  SETTING_KEYS,
  tierDiscountPercentagesValueSchema,
  type TierDiscountPercentagesOnDisk,
} from '@/lib/validation/settings';

export type ResolvePriceInput = {
  variantId: string;
  customerId: string;
  qty: Prisma.Decimal;
  // When provided, the line is treated as a manual override and recorded as
  // MANUAL_OVERRIDE regardless of any other rule. Audit-friendly: callers
  // always know which rule fired.
  manualUnitPrice?: Prisma.Decimal | null;
};

export type ResolvedPrice = {
  unitPrice: Prisma.Decimal;
  rule: PriceResolutionRule;
  // Pre-filled discount % from a tier-discount lookup. Non-null only
  // when the resolver fires the TIER_DISCOUNT branch. Operator-typed
  // line discounts always win at the call site (see salesOrders.ts).
  discountPercent: Prisma.Decimal | null;
};

// Pricing resolver. The spec (docs/05-sales-orders.md) ultimately wants:
// "system runs all applicable rules, picks lowest, logs which rule fired."
//
// Today we wire four branches in priority order:
//   1. MANUAL_OVERRIDE   — caller supplied a unitPrice (any non-negative)
//   2. CUSTOMER_SPECIFIC — non-deleted CustomerPriceOverride for (customer, variant)
//   3. TIER_DISCOUNT     — BASE_PRICE + pre-filled discount % from the
//                          tier_discount_percentages Setting (matched on
//                          customer.type). If the setting is missing or
//                          the tier % is 0, falls through to BASE_PRICE.
//   4. BASE_PRICE        — fall back to the variant's parent product basePrice
//
// MANUAL_OVERRIDE always wins. CUSTOMER_SPECIFIC overrides any tier
// discount (operator-set per-customer is the final word). TIER_DISCOUNT
// is BASE_PRICE + a pre-filled discount %, not a separate price source —
// the unitPrice is identical to the BASE_PRICE branch.
//
// TODO: lowest-of-all-applicable behavior. The remaining rules
// (QTY_BREAK, PROMO, COST_PLUS) land in their own slices. When at
// least two of those are wired, switch this from priority-order to
// "evaluate every applicable rule, return the lowest, record which
// rule fired" per the spec — the call signature won't change.
//
// The resolver is intentionally side-effect-free. The audit trail of
// which rule fired is recorded by the SO line creation site
// (server/services/salesOrders.ts) via SalesOrderLine.priceRule.
export async function resolvePrice(
  tx: Prisma.TransactionClient,
  input: ResolvePriceInput,
): Promise<ResolvedPrice> {
  // 1. MANUAL_OVERRIDE
  if (input.manualUnitPrice != null) {
    if (input.manualUnitPrice.lessThan(0)) {
      throw new Error(
        `Manual unit price cannot be negative: ${input.manualUnitPrice.toString()}`,
      );
    }
    return {
      unitPrice: new Prisma.Decimal(input.manualUnitPrice),
      rule: PriceResolutionRule.MANUAL_OVERRIDE,
      discountPercent: null,
    };
  }

  // 2. CUSTOMER_SPECIFIC — single findFirst on the (customerId, variantId,
  //    deletedAt=null) tuple. The partial unique index
  //    `customerpriceoverride_active_key` guarantees at most one match.
  //    Soft-deleted overrides are treated as absent — the resolver falls
  //    through to BASE_PRICE on the same call.
  const override = await tx.customerPriceOverride.findFirst({
    where: {
      customerId: input.customerId,
      variantId: input.variantId,
      deletedAt: null,
    },
  });
  if (override) {
    return {
      unitPrice: new Prisma.Decimal(override.unitPrice),
      rule: PriceResolutionRule.CUSTOMER_SPECIFIC,
      discountPercent: null,
    };
  }

  // 3 / 4. BASE_PRICE (with optional TIER_DISCOUNT pre-fill).
  const [variant, customer, tierMap] = await Promise.all([
    tx.productVariant.findUnique({
      where: { id: input.variantId },
      select: { id: true, product: { select: { basePrice: true } } },
    }),
    tx.customer.findUnique({
      where: { id: input.customerId },
      select: { type: true },
    }),
    loadTierDiscountMap(tx),
  ]);
  if (!variant) {
    throw new Error(`Variant not found: ${input.variantId}`);
  }
  const basePrice = variant.product.basePrice;
  if (basePrice == null) {
    throw new Error(
      `No price could be resolved for variant ${input.variantId}: product has no basePrice and no manual override was supplied`,
    );
  }

  // TIER_DISCOUNT only fires when (a) the setting exists, (b) the
  // customer record exists with a type, and (c) the looked-up % is
  // strictly > 0. Zero / missing / customer-not-found falls through
  // to plain BASE_PRICE so audit trail records the right rule.
  const tierPct = pickTierPercent(tierMap, customer?.type ?? null);
  if (tierPct != null && tierPct.greaterThan(0)) {
    return {
      unitPrice: new Prisma.Decimal(basePrice),
      rule: PriceResolutionRule.TIER_DISCOUNT,
      discountPercent: tierPct,
    };
  }

  return {
    unitPrice: new Prisma.Decimal(basePrice),
    rule: PriceResolutionRule.BASE_PRICE,
    discountPercent: null,
  };
}

// Read tier_discount_percentages directly off the Setting table.
// Returns null when the row is missing (graceful no-op per audit
// doc Q6) OR when the row's value fails schema validation (corrupt
// data shouldn't crash every SO line — a future admin-side
// validate-on-read sweep can surface these). All other read errors
// propagate (DB unreachable etc.).
async function loadTierDiscountMap(
  tx: Prisma.TransactionClient,
): Promise<TierDiscountPercentagesOnDisk | null> {
  const row = await tx.setting.findUnique({
    where: { key: SETTING_KEYS.TIER_DISCOUNT_PERCENTAGES },
  });
  if (!row) return null;
  const parsed = tierDiscountPercentagesValueSchema.safeParse(row.value);
  return parsed.success ? parsed.data : null;
}

function pickTierPercent(
  map: TierDiscountPercentagesOnDisk | null,
  type: CustomerType | null,
): Prisma.Decimal | null {
  if (map == null || type == null) return null;
  const raw = map[type];
  if (raw == null) return null;
  return new Prisma.Decimal(raw);
}
