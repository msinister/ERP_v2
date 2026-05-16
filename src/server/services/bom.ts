import { AuditAction, Prisma, ProductType } from '@/generated/tenant';
import type {
  BomLine,
  PrismaClient,
  Product,
  ProductVariant,
} from '@/generated/tenant';
import { audit, type AuditContext } from '@/lib/audit/audit';
import {
  setProductBomInputSchema,
  type SetProductBomInput,
} from '@/lib/validation/product';

// =============================================================================
// BOM (Bill of Materials) service. A BOM is the collection of BomLine
// rows for a given parent product, plus an optional flat-dollar labor
// cost stored on Product.bomLaborCost. It's a template — actual builds
// (Work Order, future phase B) reference the template at build time and
// snapshot the cost rollup into FIFO layers.
//
// BOMs are valid only on products with type SIMPLE or ASSEMBLED.
// DROP_SHIP holds no inventory and SERVICE isn't built — both reject.
//
// `setProductBom` is wholesale-replace: prior lines are soft-deleted
// and the new lines created fresh. This matches the PO update pattern
// and keeps the BOM-edit UI simple (no per-line PATCH dance needed).
// =============================================================================

export type BomLineWithComponent = BomLine & {
  componentVariant: ProductVariant & { product: Product };
};

export type ProductBom = {
  productId: string;
  productType: ProductType;
  laborCost: Prisma.Decimal | null;
  lines: BomLineWithComponent[];
};

/**
 * Load a product's BOM (lines + labor cost). Returns null if the
 * product doesn't exist or is soft-deleted. Returns an empty `lines`
 * array when the product exists but has no BOM defined yet.
 */
export async function getProductBom(
  db: PrismaClient,
  productId: string,
): Promise<ProductBom | null> {
  const product = await db.product.findFirst({
    where: { id: productId, deletedAt: null },
    select: { id: true, type: true, bomLaborCost: true },
  });
  if (!product) return null;

  const lines = await db.bomLine.findMany({
    where: { parentProductId: productId, deletedAt: null },
    include: {
      componentVariant: { include: { product: true } },
    },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
  });

  return {
    productId: product.id,
    productType: product.type,
    laborCost: product.bomLaborCost,
    lines,
  };
}

/**
 * Wholesale-replace the BOM for `productId`. Soft-deletes all prior
 * lines and creates the new set in one transaction. Empty `lines` is
 * a valid input — it clears the BOM. `laborCost` is independently
 * controllable: pass `undefined` to leave it untouched, `null` to
 * clear it, or a string to set it.
 *
 * Status gates:
 *   - Product must exist + not be soft-deleted.
 *   - Product.type must be SIMPLE or ASSEMBLED. DROP_SHIP and SERVICE
 *     reject (no inventory to build into / not buildable).
 *
 * Component checks:
 *   - Every componentVariantId must reference an active variant
 *     belonging to a non-deleted product.
 *   - Self-reference is rejected: a BOM cannot consume one of the
 *     parent product's own variants (would create an infinite build
 *     loop and is almost always a typo).
 *
 * Audit: one UPDATE row on Product covering the line-count + labor
 * cost diff and the new line ids. Per-line audit rows are skipped to
 * keep the trail readable — the wholesale-replace semantic means
 * "this is the entire new state".
 */
export async function setProductBom(
  db: PrismaClient,
  productId: string,
  input: SetProductBomInput,
  ctx?: AuditContext,
): Promise<ProductBom> {
  const data = setProductBomInputSchema.parse(input);
  return db.$transaction(async (tx) => {
    const product = await tx.product.findUnique({
      where: { id: productId },
      select: {
        id: true,
        type: true,
        bomLaborCost: true,
        deletedAt: true,
        variants: { where: { deletedAt: null }, select: { id: true } },
      },
    });
    if (!product || product.deletedAt != null) {
      throw new Error(`Product not found: ${productId}`);
    }
    if (
      product.type !== ProductType.SIMPLE &&
      product.type !== ProductType.ASSEMBLED &&
      product.type !== ProductType.BUNDLE
    ) {
      throw new Error(
        `Cannot set BOM on Product with type ${product.type} — only SIMPLE, ASSEMBLED, and BUNDLE products support BOMs`,
      );
    }

    // Reject self-reference: parent product's own variants can't be
    // components. Cheap set lookup against the included variant ids.
    const ownVariantIds = new Set(product.variants.map((v) => v.id));
    for (const l of data.lines) {
      if (ownVariantIds.has(l.componentVariantId)) {
        throw new Error(
          `Component variant ${l.componentVariantId} belongs to the parent product — a BOM cannot consume its own variants`,
        );
      }
    }

    // Validate every componentVariantId is real + live. One findMany
    // beats N findUnique calls; the resulting Set powers per-line
    // membership checks below.
    if (data.lines.length > 0) {
      const componentIds = Array.from(
        new Set(data.lines.map((l) => l.componentVariantId)),
      );
      const componentRows = await tx.productVariant.findMany({
        where: { id: { in: componentIds }, deletedAt: null },
        select: { id: true, product: { select: { deletedAt: true } } },
      });
      const liveIds = new Set(
        componentRows
          .filter((r) => r.product.deletedAt == null)
          .map((r) => r.id),
      );
      const missing = componentIds.filter((id) => !liveIds.has(id));
      if (missing.length > 0) {
        throw new Error(
          `Unknown or soft-deleted component variant(s): ${missing.join(', ')}`,
        );
      }
    }

    // Soft-delete existing lines. Hard-delete would break audit
    // continuity if anything ever references them; soft-delete keeps
    // the prior template visible in history.
    const priorLineCount = await tx.bomLine.count({
      where: { parentProductId: productId, deletedAt: null },
    });
    if (priorLineCount > 0) {
      await tx.bomLine.updateMany({
        where: { parentProductId: productId, deletedAt: null },
        data: { deletedAt: new Date() },
      });
    }

    // Create the new set. sortOrder falls back to the input position so
    // the UI's row order survives a round-trip even if the operator
    // didn't explicitly set sortOrder per line.
    const createdLines: BomLine[] = [];
    for (let i = 0; i < data.lines.length; i++) {
      const l = data.lines[i];
      const created = await tx.bomLine.create({
        data: {
          parentProductId: productId,
          componentVariantId: l.componentVariantId,
          qtyRequired: new Prisma.Decimal(l.qtyRequired),
          sortOrder: l.sortOrder ?? i,
          notes: l.notes,
        },
      });
      createdLines.push(created);
    }

    // Labor cost: independently controllable. `undefined` = no change;
    // `null` = clear; string = set. Capture before/after for the audit
    // diff so the trail reflects exactly what changed.
    let newLaborCost: Prisma.Decimal | null = product.bomLaborCost;
    if (data.laborCost !== undefined) {
      newLaborCost =
        data.laborCost === null ? null : new Prisma.Decimal(data.laborCost);
      await tx.product.update({
        where: { id: productId },
        data: { bomLaborCost: newLaborCost },
      });
    }

    await audit(tx, {
      action: AuditAction.UPDATE,
      entityType: 'Product',
      entityId: productId,
      before: {
        bomLineCount: priorLineCount,
        bomLaborCost: product.bomLaborCost,
      },
      after: {
        bomLineCount: createdLines.length,
        bomLaborCost: newLaborCost,
        bomLineIds: createdLines.map((l) => l.id),
      },
      ctx,
    });

    // Re-fetch via getProductBom so the caller gets the same shape as
    // the read path (include + ordering identical).
    const fresh = await getProductBomInTx(tx, productId);
    if (!fresh) {
      // Shouldn't happen — we just verified the product exists.
      throw new Error(`Product not found after BOM update: ${productId}`);
    }
    return fresh;
  });
}

// Same as getProductBom but accepts a transaction client. Internal —
// used by setProductBom for the post-update re-read.
async function getProductBomInTx(
  tx: Prisma.TransactionClient,
  productId: string,
): Promise<ProductBom | null> {
  const product = await tx.product.findFirst({
    where: { id: productId, deletedAt: null },
    select: { id: true, type: true, bomLaborCost: true },
  });
  if (!product) return null;
  const lines = await tx.bomLine.findMany({
    where: { parentProductId: productId, deletedAt: null },
    include: {
      componentVariant: { include: { product: true } },
    },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
  });
  return {
    productId: product.id,
    productType: product.type,
    laborCost: product.bomLaborCost,
    lines,
  };
}
