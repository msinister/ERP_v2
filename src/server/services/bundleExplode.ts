import {
  PriceResolutionRule,
  Prisma,
  ProductType,
} from '@/generated/tenant';
import type { SalesOrderLineInput } from '@/lib/validation/sales';

// =============================================================================
// Bundle explode — turns a single SO line input referencing a BUNDLE
// product into N component-line inputs with allocated prices, a shared
// bundleGroupId, and a "Part of [Bundle SKU] bundle" customer note.
//
// Called by createSalesOrder + addSalesOrderLines before the regular
// per-line creation loop. Non-bundle inputs pass through unchanged.
//
// Allocation formula (qty-weighted):
//   weight_i        = component_i.basePrice * component_i.qtyRequiredPerUnit
//   bundle_total    = bundle_price * bundle_qty
//   share_i         = bundle_total * (weight_i / sum_of_weights)
//   unitPrice_i     = share_i / (component_i.qtyRequiredPerUnit * bundle_qty)
//
// The last component absorbs any residual from Decimal rounding so that
// SUM(component qty × unitPrice) === bundle_total to the last cent.
// =============================================================================

export type ExpandedLineInput = SalesOrderLineInput & {
  // Always set on bundle-exploded rows; null/undefined for non-bundle
  // rows passing through.
  _bundleGroupId?: string;
  _bundleSourceProductId?: string;
  // When set, the explode pre-computed the price and the caller should
  // NOT re-run the resolver. priceRule on the resulting SO line will
  // be BUNDLE_ALLOCATED. Inline edit later flips it to MANUAL_OVERRIDE
  // via the existing updateSalesOrderLineFields path.
  _allocatedUnitPrice?: string;
};

/**
 * Expand an array of SO line inputs, exploding any that reference a
 * BUNDLE product into their component lines.
 *
 * Errors thrown:
 *   - BUNDLE with no BOM lines defined
 *   - BUNDLE with all-zero component weights (cannot allocate)
 *   - BUNDLE component whose basePrice is null (cannot allocate
 *     deterministically — operator must set a price)
 *   - Nested bundles (a BUNDLE's BOM contains a BUNDLE component)
 */
export async function expandBundleLinesInTx(
  tx: Prisma.TransactionClient,
  inputLines: SalesOrderLineInput[],
  defaultWarehouseId: string,
): Promise<ExpandedLineInput[]> {
  // Pre-fetch every input variant + its parent product in one query.
  // Bundle products are detected by product.type === BUNDLE.
  const variantIds = Array.from(new Set(inputLines.map((l) => l.variantId)));
  const variants = await tx.productVariant.findMany({
    where: { id: { in: variantIds } },
    include: { product: true },
  });
  const variantById = new Map(variants.map((v) => [v.id, v]));

  const expanded: ExpandedLineInput[] = [];
  for (const line of inputLines) {
    const variant = variantById.get(line.variantId);
    if (!variant) {
      throw new Error(`Variant not found: ${line.variantId}`);
    }
    if (variant.product.type !== ProductType.BUNDLE) {
      // Pass through unchanged.
      expanded.push(line);
      continue;
    }
    // Bundle path. Bundle qty = the original line's qtyOrdered.
    const bundleQty = new Prisma.Decimal(line.qtyOrdered);
    if (bundleQty.lessThanOrEqualTo(0)) {
      throw new Error(
        `Bundle qty must be > 0 (got ${bundleQty.toString()}) for ${variant.product.sku}`,
      );
    }

    // Bundle unit price priority: caller's manualUnitPrice override
    // first, then the bundle product's basePrice.
    const bundleUnitPrice: Prisma.Decimal | null =
      line.manualUnitPrice != null
        ? new Prisma.Decimal(line.manualUnitPrice)
        : variant.product.basePrice;
    if (bundleUnitPrice == null) {
      throw new Error(
        `Bundle ${variant.product.sku} has no basePrice and the caller did not supply manualUnitPrice — cannot allocate`,
      );
    }

    const bomLines = await tx.bomLine.findMany({
      where: { parentProductId: variant.product.id, deletedAt: null },
      include: {
        componentVariant: { include: { product: true } },
      },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    if (bomLines.length === 0) {
      throw new Error(
        `Bundle ${variant.product.sku} has no components defined — cannot explode`,
      );
    }

    // Reject nested bundles. The pilot doesn't support a Bundle whose
    // BOM contains another Bundle (would need recursive allocation).
    for (const bl of bomLines) {
      if (bl.componentVariant.product.type === ProductType.BUNDLE) {
        throw new Error(
          `Bundle ${variant.product.sku} contains a nested bundle component (${bl.componentVariant.sku}); nested bundles are not supported`,
        );
      }
    }

    // Compute weights — qty-weighted (basePrice × qtyRequiredPerUnit).
    // null basePrice on a component is a hard error; the spec says
    // "regular price" of the component must drive allocation. Asking
    // the operator to set a price beats silently allocating zero.
    type Weight = {
      bomLineComponentVariantId: string;
      qtyRequiredPerUnit: Prisma.Decimal;
      basePrice: Prisma.Decimal;
      warehouseId: string;
      weight: Prisma.Decimal;
      note: string | null;
    };
    const weights: Weight[] = bomLines.map((bl) => {
      if (bl.componentVariant.product.basePrice == null) {
        throw new Error(
          `Bundle component ${bl.componentVariant.sku} has no basePrice — set one before adding the bundle to a sales order`,
        );
      }
      const w = bl.componentVariant.product.basePrice.times(bl.qtyRequired);
      return {
        bomLineComponentVariantId: bl.componentVariantId,
        qtyRequiredPerUnit: bl.qtyRequired,
        basePrice: bl.componentVariant.product.basePrice,
        // Components stay in the SO's default warehouse (single-
        // warehouse pilot). BomLine doesn't store warehouseId — it's
        // a product-level template — so we default here.
        warehouseId: line.warehouseId ?? defaultWarehouseId,
        weight: w,
        note: bl.notes,
      };
    });
    const totalWeight = weights.reduce(
      (acc, w) => acc.plus(w.weight),
      new Prisma.Decimal(0),
    );
    if (totalWeight.lessThanOrEqualTo(0)) {
      throw new Error(
        `Bundle ${variant.product.sku}: components have zero total weight (sum of basePrice × qty) — cannot allocate`,
      );
    }

    const bundleTotal = bundleUnitPrice.times(bundleQty);
    const groupId =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const bundleSku = variant.product.sku;

    // Allocate to all but the last component, rounding each per-unit
    // price to the storage precision (Decimal(18,5)) so the
    // accumulator tracks what Postgres will actually store. The last
    // component absorbs the residual = bundleTotal - SUM(rounded line
    // totals), guaranteeing the stored sum ties out exactly when the
    // last component's qty * unitPrice fits cleanly at 5dp. (Pathological
    // cases with non-divisible last-qty can leave <$0.00001 residual
    // below the column's storage precision — acceptable for pilot.)
    const STORAGE_DP = 5;
    let allocatedSoFar = new Prisma.Decimal(0);
    for (let i = 0; i < weights.length; i++) {
      const w = weights[i];
      const isLast = i === weights.length - 1;
      const totalComponentQty = w.qtyRequiredPerUnit.times(bundleQty);

      let unitPrice: Prisma.Decimal;
      if (isLast) {
        // Residual line total = whatever's needed to close the gap.
        const residualLineTotal = bundleTotal.minus(allocatedSoFar);
        unitPrice = residualLineTotal
          .dividedBy(totalComponentQty)
          .toDecimalPlaces(STORAGE_DP);
      } else {
        const componentTotal = bundleTotal
          .times(w.weight)
          .dividedBy(totalWeight);
        unitPrice = componentTotal
          .dividedBy(totalComponentQty)
          .toDecimalPlaces(STORAGE_DP);
        allocatedSoFar = allocatedSoFar.plus(
          unitPrice.times(totalComponentQty),
        );
      }

      const componentLine: ExpandedLineInput = {
        variantId: w.bomLineComponentVariantId,
        warehouseId: w.warehouseId,
        qtyOrdered: totalComponentQty.toString(),
        // manualUnitPrice is the operator-visible price-override
        // channel; the BUNDLE allocation isn't a manual override but
        // the resolver needs to be told "don't touch this". We pass
        // the allocated price via the _allocatedUnitPrice escape hatch
        // (see caller) and leave manualUnitPrice unset so the resolver
        // wouldn't pick it up if it were called.
        customerNote: `Part of ${bundleSku} bundle`,
        _bundleGroupId: groupId,
        _bundleSourceProductId: variant.product.id,
        _allocatedUnitPrice: unitPrice.toString(),
      };
      // Preserve original line's internalNote/discount fields? The
      // bundle's input is treated as a wrapper; line-level discounts
      // / internal notes don't propagate to children. If we want
      // them later we can add them, but it's cleaner not to silently
      // duplicate.
      expanded.push(componentLine);
    }
  }
  return expanded;
}
