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

// Pilot scaffold for the pricing resolver. Today only two branches are wired:
//   1. MANUAL_OVERRIDE — caller supplied a unitPrice (any non-negative value)
//   2. BASE_PRICE      — fall back to the variant's parent product basePrice
//
// The remaining rules from docs/02-products-inventory.md and docs/05-sales
// -orders.md (CUSTOMER_SPECIFIC, QTY_BREAK, TIER_DISCOUNT, PROMO, COST_PLUS)
// land alongside the customer master + promo + qty-break + cost-plus slices.
// They slot in here without changing the call site, which is why every
// callers route through this single function — never read basePrice directly.
export async function resolvePrice(
  tx: Prisma.TransactionClient,
  input: ResolvePriceInput,
): Promise<ResolvedPrice> {
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
