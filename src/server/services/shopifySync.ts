import {
  AuditAction,
  Prisma,
  VendorType,
  type PrismaClient,
  type Product,
} from '@/generated/tenant';
import { audit, type AuditContext } from '@/lib/audit/audit';
import { ShopifyClient } from '@/lib/integrations/shopify/client';
import type {
  ShopifyProduct,
  ShopifyVariant,
} from '@/lib/integrations/shopify/types';
import {
  getSecretsForStore,
  recordSyncRun,
  type StoredSyncRun,
} from './shopifyStores';

// =============================================================================
// Shopify → ERP product sync. Multi-store aware: every entry point takes a
// `storeId` and all junction lookups / writes are scoped to that store.
//
// Direction is one-way: Shopify is master for catalog data (name,
// description, images, vendor, category, tags, status). ERP is master
// for inventory, cost, WAC, and pricing — those fields are NEVER
// overwritten by this service.
//
// Variant model is FLAT: one physical SKU → one ERP Product. Shopify
// variant IDs are stored in ProductShopifyVariant (junction), which
// lets one ERP product link to multiple Shopify listings:
//
//   Primary listing   — isPrimary=true. Drives catalog fields (name,
//                       description, images, tags). Typically the
//                       dedicated product listing.
//   Secondary listing — isPrimary=false. Deal / bundle / mix-and-match
//                       products that sell the same physical SKU at a
//                       different price. Registered for future inventory-
//                       push fan-out; never overwrite catalog fields.
//
// Multi-store: primary vs. secondary is per-store. An ERP product can be
// primary in Store A AND primary in Store B simultaneously — each store
// has its own catalog ownership chain.
//
// Match cascade for each incoming Shopify variant (within `storeId`):
//   1. Junction row where (storeId, shopifyVariantId) = (this store, variant.id)
//      → already registered; update primary or touch secondary syncedAt.
//   2. ERP Product where sku = <variant.sku>
//      → existing product matched by SKU.
//        a. Product has a primary junction row IN THIS STORE from a DIFFERENT
//           Shopify product → this is a secondary listing for this store;
//           add junction row, skip catalog writes.
//        b. Product has no primary junction row in this store → adopt as
//           primary for this store; write catalog fields.
//   3. No match → create ERP Product + primary junction row in this store.
// =============================================================================

export type UpsertOutcome = 'created' | 'updated' | 'skipped';

export type UpsertResult = {
  outcome: UpsertOutcome;
  productId: string;
  sku: string;
  reason?: string; // populated when outcome = 'skipped'
};

/**
 * Upsert ONE Shopify product (with all its variants) into ERP. Returns
 * one UpsertResult per variant. Idempotent — safe to re-call for the
 * same product without side effects.
 *
 * Behavior on Shopify status:
 *   - 'active' → upsert each variant.
 *   - 'draft' / 'archived' → remove this store's junction rows for the
 *     product; if a removed row was primary in this store, deactivate the
 *     ERP product (unless it's primary in another store still).
 */
export async function upsertProductFromShopify(
  db: PrismaClient,
  storeId: string,
  sp: ShopifyProduct,
  ctx?: AuditContext,
): Promise<UpsertResult[]> {
  if (sp.status !== 'active') {
    return deactivateShopifyProduct(db, storeId, sp.id, ctx);
  }

  const vendor = sp.vendor ? await resolveVendor(db, sp.vendor, ctx) : null;
  const tagNames = parseTags(sp.tags);
  const variantGroup = `shopify:${storeId}:${sp.id}`;

  const results: UpsertResult[] = [];
  for (const variant of sp.variants ?? []) {
    if (!variant.sku || variant.sku.trim() === '') {
      results.push({
        outcome: 'skipped',
        productId: '',
        sku: '',
        reason: `Variant ${variant.id} has no SKU — Shopify variants must have a SKU to sync`,
      });
      continue;
    }
    try {
      const res = await upsertVariant(db, {
        storeId,
        shopifyProduct: sp,
        shopifyVariant: variant,
        variantGroup,
        vendorId: vendor?.id ?? null,
        tagNames,
        ctx,
      });
      results.push(res);
    } catch (e) {
      results.push({
        outcome: 'skipped',
        productId: '',
        sku: variant.sku,
        reason: e instanceof Error ? e.message : 'unknown error',
      });
    }
  }
  return results;
}

/**
 * Walk all active Shopify products for one store and upsert each. Records the
 * run summary to the ShopifyStore row so the admin UI can render "Last sync".
 */
export async function runFullSync(
  db: PrismaClient,
  storeId: string,
  ctx: AuditContext | undefined,
): Promise<StoredSyncRun> {
  const secrets = await getSecretsForStore(db, storeId);
  const client = new ShopifyClient({
    storeUrl: secrets.storeUrl,
    accessToken: secrets.accessToken,
  });

  const startedAt = new Date();
  let created = 0;
  let updated = 0;
  let skipped = 0;
  const errors: StoredSyncRun['errors'] = [];

  for await (const batch of client.iterateActiveProducts(250)) {
    for (const sp of batch) {
      try {
        const results = await upsertProductFromShopify(db, storeId, sp, ctx);
        for (const r of results) {
          if (r.outcome === 'created') created++;
          else if (r.outcome === 'updated') updated++;
          else skipped++;
        }
      } catch (e) {
        errors.push({
          shopifyId: sp.id,
          message: e instanceof Error ? e.message : 'unknown',
        });
      }
    }
  }

  const run: StoredSyncRun = {
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    created,
    updated,
    skipped,
    errors,
  };
  await recordSyncRun(db, storeId, run);
  return run;
}

/**
 * Remove every junction row for the given (store, Shopify product):
 *   - Primary rows   → if no other store still lists this ERP product as
 *     primary, mark the ERP product inactive.
 *   - Secondary rows → just remove the junction row (ERP product stays
 *     active; its primary listings elsewhere are intact).
 *
 * Used by the products/delete webhook and by status transitions to
 * 'draft' / 'archived'.
 */
export async function deactivateShopifyProduct(
  db: PrismaClient,
  storeId: string,
  shopifyProductId: string,
  ctx?: AuditContext,
): Promise<UpsertResult[]> {
  const junctionRows = await db.productShopifyVariant.findMany({
    where: { shopifyStoreId: storeId, shopifyProductId },
    select: { id: true, productId: true, isPrimary: true },
  });

  const results: UpsertResult[] = [];

  for (const row of junctionRows) {
    const product = await db.product.findUnique({
      where: { id: row.productId },
      select: { id: true, sku: true, active: true, deletedAt: true },
    });

    await db.productShopifyVariant.delete({ where: { id: row.id } });

    if (!product || product.deletedAt) {
      results.push({
        outcome: 'skipped',
        productId: row.productId,
        sku: product?.sku ?? '',
        reason: 'product not found or already deleted',
      });
      continue;
    }

    if (!row.isPrimary) {
      // Secondary listing removed in this store — ERP product unaffected.
      results.push({
        outcome: 'updated',
        productId: product.id,
        sku: product.sku,
        reason: 'secondary junction row removed',
      });
      continue;
    }

    // Primary listing removed in this store — only deactivate the ERP
    // product if no OTHER store still owns it as primary.
    const otherPrimary = await db.productShopifyVariant.findFirst({
      where: { productId: product.id, isPrimary: true },
      select: { id: true },
    });
    if (otherPrimary) {
      results.push({
        outcome: 'updated',
        productId: product.id,
        sku: product.sku,
        reason: 'primary in this store removed; remains primary elsewhere',
      });
      continue;
    }

    if (!product.active) {
      results.push({
        outcome: 'skipped',
        productId: product.id,
        sku: product.sku,
        reason: 'already inactive',
      });
      continue;
    }

    await db.product.update({
      where: { id: product.id },
      data: { active: false, shopifySyncedAt: new Date() },
    });
    await audit(db, {
      action: AuditAction.UPDATE,
      entityType: 'Product',
      entityId: product.id,
      before: { active: true },
      after: { active: false, source: 'shopify' },
      ctx,
    });
    results.push({ outcome: 'updated', productId: product.id, sku: product.sku });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Variant-level upsert (one Shopify variant ⇒ one ERP Product row).
// ---------------------------------------------------------------------------

type VariantUpsertArgs = {
  storeId: string;
  shopifyProduct: ShopifyProduct;
  shopifyVariant: ShopifyVariant;
  variantGroup: string;
  vendorId: string | null;
  tagNames: string[];
  ctx?: AuditContext;
};

async function upsertVariant(
  db: PrismaClient,
  args: VariantUpsertArgs,
): Promise<UpsertResult> {
  const {
    storeId,
    shopifyProduct: sp,
    shopifyVariant: sv,
    variantGroup,
    tagNames,
    ctx,
  } = args;

  // ── Step 1: look up by (storeId, shopifyVariantId) in junction table ───
  const existingJunction = await db.productShopifyVariant.findUnique({
    where: {
      shopifyStoreId_shopifyVariantId: {
        shopifyStoreId: storeId,
        shopifyVariantId: sv.id,
      },
    },
    select: { id: true, productId: true, isPrimary: true },
  });

  if (existingJunction) {
    return db.$transaction(async (tx) => {
      if (existingJunction.isPrimary) {
        const product = await tx.product.findUniqueOrThrow({
          where: { id: existingJunction.productId },
        });
        const shopifyOwnedFields = buildShopifyOwnedFields(sp, sv);
        const before = extractAuditBefore(product);
        await tx.product.update({
          where: { id: product.id },
          data: { ...shopifyOwnedFields, shopifySyncedAt: new Date() },
        });
        await tx.productShopifyVariant.update({
          where: { id: existingJunction.id },
          data: { syncedAt: new Date() },
        });
        await ensureVariantRow(tx, product.id, sv.sku, variantGroup);
        await syncTags(tx, product.id, tagNames, ctx);
        await syncImages(tx, product.id, sp.images);
        await audit(tx, {
          action: AuditAction.UPDATE,
          entityType: 'Product',
          entityId: product.id,
          before,
          after: { ...shopifyOwnedFields, source: 'shopify' },
          ctx,
        });
        return { outcome: 'updated' as const, productId: product.id, sku: sv.sku };
      } else {
        // Secondary listing — touch syncedAt only; never overwrite catalog.
        await tx.productShopifyVariant.update({
          where: { id: existingJunction.id },
          data: { syncedAt: new Date() },
        });
        return {
          outcome: 'updated' as const,
          productId: existingJunction.productId,
          sku: sv.sku,
        };
      }
    });
  }

  // ── Step 2: look up by SKU ─────────────────────────────────────────────
  const bySkuProduct = await db.product.findUnique({ where: { sku: sv.sku } });

  if (bySkuProduct) {
    // Within THIS STORE, does this product already have a primary junction
    // row from a different Shopify product? If so, this is a secondary
    // listing for this store.
    const existingPrimary = await db.productShopifyVariant.findFirst({
      where: { productId: bySkuProduct.id, isPrimary: true, shopifyStoreId: storeId },
      select: { id: true, shopifyProductId: true },
    });

    if (existingPrimary && existingPrimary.shopifyProductId !== sp.id) {
      // ── 2a: Secondary listing (this store) ──────────────────────────
      await db.productShopifyVariant.create({
        data: {
          productId: bySkuProduct.id,
          shopifyStoreId: storeId,
          shopifyProductId: sp.id,
          shopifyVariantId: sv.id,
          isPrimary: false,
          syncedAt: new Date(),
        },
      });
      return {
        outcome: 'updated' as const,
        productId: bySkuProduct.id,
        sku: sv.sku,
        reason: `registered as secondary listing under shopify:${sp.id}`,
      };
    }

    // ── 2b: Adopt as primary in this store ──────────────────────────────
    return db.$transaction(async (tx) => {
      const shopifyOwnedFields = buildShopifyOwnedFields(sp, sv);
      const before = extractAuditBefore(bySkuProduct);
      await tx.product.update({
        where: { id: bySkuProduct.id },
        data: { ...shopifyOwnedFields, shopifySyncedAt: new Date() },
      });
      if (existingPrimary) {
        await tx.productShopifyVariant.update({
          where: { id: existingPrimary.id },
          data: { shopifyVariantId: sv.id, syncedAt: new Date() },
        });
      } else {
        await tx.productShopifyVariant.create({
          data: {
            productId: bySkuProduct.id,
            shopifyStoreId: storeId,
            shopifyProductId: sp.id,
            shopifyVariantId: sv.id,
            isPrimary: true,
            syncedAt: new Date(),
          },
        });
      }
      await ensureVariantRow(tx, bySkuProduct.id, sv.sku, variantGroup);
      await syncTags(tx, bySkuProduct.id, tagNames, ctx);
      await syncImages(tx, bySkuProduct.id, sp.images);
      await audit(tx, {
        action: AuditAction.UPDATE,
        entityType: 'Product',
        entityId: bySkuProduct.id,
        before,
        after: { ...shopifyOwnedFields, source: 'shopify' },
        ctx,
      });
      return { outcome: 'updated' as const, productId: bySkuProduct.id, sku: sv.sku };
    });
  }

  // ── Step 3: Create new ERP product + primary junction row in this store ─
  return db.$transaction(async (tx) => {
    const shopifyOwnedFields = buildShopifyOwnedFields(sp, sv);
    const created = await tx.product.create({
      data: {
        sku: sv.sku,
        ...shopifyOwnedFields,
        shopifySyncedAt: new Date(),
      },
    });
    await tx.productShopifyVariant.create({
      data: {
        productId: created.id,
        shopifyStoreId: storeId,
        shopifyProductId: sp.id,
        shopifyVariantId: sv.id,
        isPrimary: true,
        syncedAt: new Date(),
      },
    });
    await ensureVariantRow(tx, created.id, sv.sku, variantGroup);
    await syncTags(tx, created.id, tagNames, ctx);
    await syncImages(tx, created.id, sp.images);
    await audit(tx, {
      action: AuditAction.CREATE,
      entityType: 'Product',
      entityId: created.id,
      after: { sku: created.sku, ...shopifyOwnedFields, source: 'shopify' },
      ctx,
    });
    return { outcome: 'created' as const, productId: created.id, sku: sv.sku };
  });
}

// ---------------------------------------------------------------------------
// Field builders
// ---------------------------------------------------------------------------

function buildShopifyOwnedFields(sp: ShopifyProduct, sv: ShopifyVariant) {
  const variantTitleSuffix = displayVariantSuffix(sv);
  const name = variantTitleSuffix ? `${sp.title} — ${variantTitleSuffix}` : sp.title;
  return {
    name,
    longDescription: sp.body_html,
    brand: sp.vendor ?? null,
    category: sp.product_type ?? null,
    manufacturerPartNumber: sv.barcode ?? null,
    weight: sv.weight != null ? new Prisma.Decimal(sv.weight) : null,
    weightUnit: sv.weight_unit ?? null,
    active: true,
  } satisfies Partial<Product>;
}

function extractAuditBefore(product: Product) {
  return {
    name: product.name,
    longDescription: product.longDescription,
    brand: product.brand,
    category: product.category,
    manufacturerPartNumber: product.manufacturerPartNumber,
    weight: product.weight,
    weightUnit: product.weightUnit,
    active: product.active,
  };
}

// ---------------------------------------------------------------------------
// Side-effect helpers
// ---------------------------------------------------------------------------

async function resolveVendor(
  db: PrismaClient,
  name: string,
  ctx?: AuditContext,
): Promise<{ id: string; name: string }> {
  const trimmed = name.trim();
  const existing = await db.vendor.findFirst({
    where: { name: { equals: trimmed, mode: 'insensitive' }, deletedAt: null },
    select: { id: true, name: true },
  });
  if (existing) return existing;

  const baseCode = `SHOPIFY-${slugify(trimmed).slice(0, 24).toUpperCase()}`;
  let code = baseCode;
  let suffix = 1;
  while (await db.vendor.findFirst({ where: { code } })) {
    suffix++;
    code = `${baseCode}-${suffix}`;
  }
  const created = await db.vendor.create({
    data: { name: trimmed, code, type: VendorType.STOCK, active: true },
    select: { id: true, name: true },
  });
  await audit(db, {
    action: AuditAction.CREATE,
    entityType: 'Vendor',
    entityId: created.id,
    after: { name: trimmed, code, source: 'shopify' },
    ctx,
  });
  return created;
}

async function ensureVariantRow(
  tx: Prisma.TransactionClient,
  productId: string,
  sku: string,
  variantGroup: string,
): Promise<void> {
  const existing = await tx.productVariant.findFirst({
    where: { productId, deletedAt: null },
    select: { id: true, variantGroup: true, sku: true },
  });
  if (existing) {
    if (existing.variantGroup !== variantGroup || existing.sku !== sku) {
      await tx.productVariant.update({
        where: { id: existing.id },
        data: { variantGroup, sku },
      });
    }
    return;
  }

  const orphaned = await tx.productVariant.findFirst({
    where: { sku },
    select: { id: true },
  });
  if (orphaned) {
    await tx.productVariant.update({
      where: { id: orphaned.id },
      data: { productId, variantGroup, deletedAt: null, active: true },
    });
    return;
  }

  await tx.productVariant.create({
    data: { productId, sku, variantGroup, active: true },
  });
}

async function syncTags(
  tx: Prisma.TransactionClient,
  productId: string,
  names: string[],
  ctx?: AuditContext,
): Promise<void> {
  const currentRows = await tx.productTag.findMany({
    where: { productId },
    include: { tag: true },
  });
  const currentNames = new Set(currentRows.map((r) => r.tag.name.toLowerCase()));
  const wantNames = new Set(names.map((n) => n.toLowerCase()));

  for (const name of names) {
    if (currentNames.has(name.toLowerCase())) continue;
    const tag = await tx.tag.upsert({
      where: { name },
      create: { name },
      update: {},
    });
    await tx.productTag.create({ data: { productId, tagId: tag.id } });
    await audit(tx, {
      action: AuditAction.CREATE,
      entityType: 'ProductTag',
      entityId: `${productId}:${tag.id}`,
      after: { productId, tagId: tag.id, name: tag.name, source: 'shopify' },
      ctx,
    });
  }
  for (const row of currentRows) {
    if (wantNames.has(row.tag.name.toLowerCase())) continue;
    await tx.productTag.delete({ where: { id: row.id } });
    await audit(tx, {
      action: AuditAction.DELETE,
      entityType: 'ProductTag',
      entityId: `${productId}:${row.tagId}`,
      before: { productId, tagId: row.tagId, name: row.tag.name, source: 'shopify' },
      ctx,
    });
  }
}

async function syncImages(
  tx: Prisma.TransactionClient,
  productId: string,
  shopifyImages: ShopifyProduct['images'],
): Promise<void> {
  const currentShopifyImages = await tx.productImage.findMany({
    where: { productId, shopifyImageId: { not: null }, deletedAt: null },
  });
  const operatorHasPrimary = await tx.productImage.findFirst({
    where: { productId, isPrimary: true, shopifyImageId: null, deletedAt: null },
    select: { id: true },
  });

  const incomingIds = new Set(shopifyImages.map((i) => i.id));

  for (const img of currentShopifyImages) {
    if (img.shopifyImageId && !incomingIds.has(img.shopifyImageId)) {
      await tx.productImage.update({
        where: { id: img.id },
        data: { deletedAt: new Date(), isPrimary: false },
      });
    }
  }

  for (let i = 0; i < shopifyImages.length; i++) {
    const img = shopifyImages[i];
    const wantPrimary = i === 0 && !operatorHasPrimary;
    const existing = currentShopifyImages.find((e) => e.shopifyImageId === img.id);
    if (existing) {
      await tx.productImage.update({
        where: { id: existing.id },
        data: {
          url: img.src,
          altText: img.alt,
          sortOrder: img.position,
          isPrimary: wantPrimary ? true : existing.isPrimary,
          deletedAt: null,
        },
      });
    } else {
      await tx.productImage.create({
        data: {
          productId,
          url: img.src,
          altText: img.alt,
          sortOrder: img.position,
          isPrimary: wantPrimary,
          shopifyImageId: img.id,
        },
      });
    }
  }

  if (!operatorHasPrimary && shopifyImages.length > 0) {
    const firstId = shopifyImages[0].id;
    await tx.productImage.updateMany({
      where: {
        productId,
        isPrimary: true,
        shopifyImageId: { not: null },
        NOT: { shopifyImageId: firstId },
      },
      data: { isPrimary: false },
    });
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function parseTags(raw: string): string[] {
  return raw
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
}

function displayVariantSuffix(v: ShopifyVariant): string | null {
  if (v.title && v.title !== 'Default Title') return v.title;
  const parts = [v.option1, v.option2, v.option3].filter(
    (o): o is string => !!o && o !== 'Default Title',
  );
  return parts.length > 0 ? parts.join(' / ') : null;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
