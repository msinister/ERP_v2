import { Prisma, PriceResolutionRule } from '@/generated/tenant';

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
};

// Pricing resolver. The spec (docs/05-sales-orders.md) ultimately wants:
// "system runs all applicable rules, picks lowest, logs which rule fired."
//
// Today we wire three branches in priority order:
//   1. MANUAL_OVERRIDE   — caller supplied a unitPrice (any non-negative)
//   2. CUSTOMER_SPECIFIC — non-deleted CustomerPriceOverride for (customer, variant)
//   3. BASE_PRICE        — fall back to the variant's parent product basePrice
//
// MANUAL_OVERRIDE always wins (it's the explicit human decision on the line).
// CUSTOMER_SPECIFIC wins over BASE_PRICE. Soft-deleted CustomerPriceOverride
// rows are treated as if they don't exist — the resolver falls through to
// BASE_PRICE.
//
// TODO: lowest-of-all-applicable behavior. The remaining rules
// (QTY_BREAK, TIER_DISCOUNT, PROMO, COST_PLUS) land in their own slices.
// When at least two of those are wired, switch this from priority-order
// to "evaluate every applicable rule, return the lowest, record which
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
    };
  }

  // 2. CUSTOMER_SPECIFIC — single findUnique on the (customerId, variantId)
  //    composite unique. Soft-deleted overrides are treated as absent so
  //    the resolver falls through to BASE_PRICE on the same call.
  const override = await tx.customerPriceOverride.findUnique({
    where: {
      customerId_variantId: {
        customerId: input.customerId,
        variantId: input.variantId,
      },
    },
  });
  if (override && override.deletedAt == null) {
    return {
      unitPrice: new Prisma.Decimal(override.unitPrice),
      rule: PriceResolutionRule.CUSTOMER_SPECIFIC,
    };
  }

  // 3. BASE_PRICE
  const variant = await tx.productVariant.findUnique({
    where: { id: input.variantId },
    select: {
      id: true,
      product: { select: { basePrice: true } },
    },
  });
  if (!variant) {
    throw new Error(`Variant not found: ${input.variantId}`);
  }
  const basePrice = variant.product.basePrice;
  if (basePrice == null) {
    throw new Error(
      `No price could be resolved for variant ${input.variantId}: product has no basePrice and no manual override was supplied`,
    );
  }
  return {
    unitPrice: new Prisma.Decimal(basePrice),
    rule: PriceResolutionRule.BASE_PRICE,
  };
}
