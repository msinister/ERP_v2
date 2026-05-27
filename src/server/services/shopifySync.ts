import {
  AuditAction,
  Prisma,
  ProductType,
  VendorType,
  type PrismaClient,
  type Product,
} from '@/generated/tenant';
import { audit, type AuditContext } from '@/lib/audit/audit';
import { ShopifyClient } from '@/lib/integrations/shopify/client';
import type {
  ShopifyCreateImageInput,
  ShopifyCreateProductInput,
  ShopifyCreateVariantInput,
  ShopifyProduct,
  ShopifyVariant,
} from '@/lib/integrations/shopify/types';
import {
  getSecretsForStore,
  recordSyncRun,
  type StoredSyncRun,
} from './shopifyStores';
import {
  matchingProductIds,
  productMatchesStore,
} from './shopifyStoreRules';
import { pushInventoryForProduct } from './shopifyInventoryPush';

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

// =============================================================================
// ERP → Shopify product push (inverse of upsertProductFromShopify).
//
// Creates a brand-new Shopify product from ERP catalog data and registers
// every returned Shopify variant as a primary ProductShopifyVariant junction
// row (isPrimary=true — this store has no other listing for this product
// yet). Skips when junction rows already exist for (storeId, productId): a
// product is "already listed" on this store and re-pushing would create a
// duplicate.
//
// Routing-rule + sync-flag gates:
//   - store.syncEnabled = false → skipped, reason 'sync disabled'.
//   - product fails productMatchesStore → skipped, reason 'does not match
//     routing rules'. (Operator can adjust rules and retry.)
//
// Variant pricing: ERP keeps a single Product.basePrice that applies to all
// of a product's variants (per-variant pricing is not in the schema).
// Every Shopify variant in the create payload carries the same basePrice;
// per-customer / tier pricing is an ERP-side concern that doesn't transit
// to Shopify.
//
// Inventory: after the product is created we call pushInventoryForProduct
// once to seed Shopify's stock counters — best-effort; an inventory-push
// failure does NOT roll back the product create (the listing is already
// up and a subsequent inventory push will heal).
// =============================================================================

export type PushProductOutcome = 'created' | 'updated' | 'skipped' | 'error';

export type PushProductResult = {
  outcome: PushProductOutcome;
  productId: string;
  shopifyProductId?: string;
  reason?: string;
};

// Bulk-run summary written via recordSyncRun. Reuses the existing
// StoredSyncRun shape (created / updated / skipped / errors); `updated`
// counts products with an existing primary junction that we PUT to
// Shopify, `created` counts products without one that we POSTed.

// Narrow input shape for buildShopifyCreateInput — declared independently
// of Prisma's deep payload type so fixtures (and the production caller)
// can both satisfy it without the test having to mock every scalar on the
// VendorProduct / ProductVariant relations. The Prisma payload returned
// by loadProductForPush is a structural subtype.
export type BuildShopifyCreateInputProduct = {
  name: string;
  longDescription: string | null;
  brand: string | null;
  category: string | null;
  type: ProductType;
  basePrice: Prisma.Decimal | null;
  weight: Prisma.Decimal | null;
  weightUnit: string | null;
  variants: Array<{
    sku: string;
    imageUrl: string | null;
    vendorProducts: Array<{ vendor: { name: string } | null }>;
  }>;
  tags: Array<{ tag: { name: string } }>;
  // Gallery — operator-uploaded + Shopify-synced images. Filtered to
  // deletedAt=null at load time. Sort order: isPrimary desc, sortOrder
  // asc, createdAt asc (mirrors the product detail thumbnail picker).
  images: Array<{
    url: string;
    altText: string | null;
    isPrimary: boolean;
    sortOrder: number;
    createdAt: Date;
  }>;
};

async function loadProductForPush(db: PrismaClient, productId: string) {
  return db.product.findUnique({
    where: { id: productId },
    include: {
      variants: {
        where: { deletedAt: null, active: true },
        orderBy: { createdAt: 'asc' },
        include: {
          vendorProducts: {
            where: { isPrimary: true, deletedAt: null },
            include: { vendor: { select: { name: true, type: true } } },
          },
        },
      },
      tags: {
        include: { tag: { select: { name: true } } },
      },
      images: {
        where: { deletedAt: null },
        orderBy: [
          { isPrimary: 'desc' },
          { sortOrder: 'asc' },
          { createdAt: 'asc' },
        ],
      },
    },
  });
}

// Plan output: the images array to send to Shopify (in send-order, which
// also dictates response position 1..N) plus a SKU → 1-based position
// map so the caller can look up image_id for each variant after the
// create round-trip. Variant images that aren't already in the product
// gallery are appended (dedup by url).
export type ShopifyImagePlan = {
  images: ShopifyCreateImageInput[];
  variantImagePositionBySku: Map<string, number>;
};

export function buildShopifyImagePlan(
  product: BuildShopifyCreateInputProduct,
): ShopifyImagePlan {
  // Gallery in send-order. ProductImages first (already sorted by the
  // loader: primary, then sortOrder, then createdAt), then variant-only
  // images that aren't already represented.
  const images: ShopifyCreateImageInput[] = [];
  const urlToPosition = new Map<string, number>();

  for (const img of product.images) {
    if (urlToPosition.has(img.url)) continue;
    images.push({
      src: img.url,
      alt: img.altText ?? undefined,
    });
    urlToPosition.set(img.url, images.length); // 1-based
  }

  const variantImagePositionBySku = new Map<string, number>();
  for (const v of product.variants) {
    if (!v.imageUrl) continue;
    let position = urlToPosition.get(v.imageUrl);
    if (position == null) {
      images.push({ src: v.imageUrl });
      position = images.length;
      urlToPosition.set(v.imageUrl, position);
    }
    variantImagePositionBySku.set(v.sku, position);
  }

  return { images, variantImagePositionBySku };
}

// Build the Shopify create-product payload from a loaded ERP product.
// Pure function — no db / no client access — so the unit test can verify
// payload shape without mocking either.
export function buildShopifyCreateInput(
  product: BuildShopifyCreateInputProduct,
): ShopifyCreateProductInput {
  // Pick the first primary VendorProduct across any variant — matches the
  // "primary vendor on any variant" semantics already used by routing
  // rules.productMatchesStore. Falls back to Product.brand (Shopify-side
  // vendor field is free-text; an operator-set brand is fine).
  let vendorName: string | null = null;
  for (const v of product.variants) {
    const vp = v.vendorProducts[0];
    if (vp?.vendor?.name) {
      vendorName = vp.vendor.name;
      break;
    }
  }
  if (!vendorName && product.brand) vendorName = product.brand;

  const tags = product.tags
    .map((t) => t.tag.name.trim())
    .filter((n) => n.length > 0)
    .join(', ');

  // SERVICE products never ship; everything else does. Mirrors how the
  // pull side treats SERVICE for tax/shipping decisions.
  const requiresShipping = product.type !== ProductType.SERVICE;

  // basePrice is the only price field on Product; share across variants.
  // Round to 2 decimals at the boundary — Shopify expects "12.99" not
  // "12.99000". Use Prisma.Decimal.toFixed(2) so we don't round-trip
  // through float.
  const priceStr =
    product.basePrice != null ? product.basePrice.toFixed(2) : '0.00';

  // Weight unit comes from Product.weightUnit (free-text "lb"|"kg"|"oz"|"g"
  // in our schema, defaults to "lb"). Anything we don't recognize falls
  // back to "lb" — Shopify rejects unknown units.
  const weightUnit = normalizeWeightUnit(product.weightUnit);
  const weight =
    product.weight != null ? Number(product.weight.toString()) : null;

  const variants: ShopifyCreateVariantInput[] = product.variants.map((v) => {
    const base: ShopifyCreateVariantInput = {
      sku: v.sku,
      price: priceStr,
      inventory_management: 'shopify',
      fulfillment_service: 'manual',
      requires_shipping: requiresShipping,
    };
    if (weight != null && Number.isFinite(weight)) {
      base.weight = weight;
      base.weight_unit = weightUnit;
    }
    return base;
  });

  const payload: ShopifyCreateProductInput = {
    title: product.name,
    status: 'active',
    variants,
  };

  // Attach the same image plan used for variant→image_id mapping. We
  // re-derive it here rather than threading it through callers because
  // it's cheap and keeps buildShopifyCreateInput's contract a single
  // return value. pushProductToShopify calls buildShopifyImagePlan
  // independently to get the position map.
  const { images } = buildShopifyImagePlan(product);
  if (images.length > 0) payload.images = images;

  if (product.longDescription) payload.body_html = product.longDescription;
  if (vendorName) payload.vendor = vendorName;
  if (product.category) payload.product_type = product.category;
  if (tags) payload.tags = tags;
  return payload;
}

function normalizeWeightUnit(
  u: string | null,
): 'lb' | 'kg' | 'oz' | 'g' {
  if (u === 'kg' || u === 'oz' || u === 'g') return u;
  return 'lb';
}

/**
 * Push one ERP product to Shopify. Idempotent + bi-directional:
 *
 *   - No primary ProductShopifyVariant junction in this store → POST
 *     /products.json (CREATE) and write fresh junction rows.
 *   - Primary junction exists → PUT /products/{id}.json (UPDATE) — refreshes
 *     title / description / vendor / category / tags / images / variant
 *     pricing on the existing Shopify listing. Variants that exist on
 *     Shopify are matched by SKU and re-sent with their existing
 *     shopifyVariantId so Shopify updates in place; new ERP variants are
 *     sent without `id` and Shopify creates fresh Shopify variants.
 *
 * Both paths trigger the same post-write side effects: best-effort per-
 * variant image_id assignment (image ids change on PUT because the image
 * set is replaced wholesale), Product.shopifySyncedAt stamp, and an
 * inventory push so stock counters land on the new listings.
 *
 * Gates short-circuit before any network call: sync disabled, routing
 * rules don't match, product missing / archived / inactive / no active
 * variants. A Shopify API error returns outcome='error' with the message;
 * no rollback (the create/update is the atomic Shopify operation).
 */
export async function pushProductToShopify(
  db: PrismaClient,
  storeId: string,
  productId: string,
): Promise<PushProductResult> {
  // Gate 1: store must have sync enabled.
  const secrets = await getSecretsForStore(db, storeId);
  if (!secrets.syncEnabled) {
    return {
      outcome: 'skipped',
      productId,
      reason: 'sync disabled for this store',
    };
  }

  // Gate 2: product must match this store's routing rules. Don't bypass —
  // operators set rules deliberately, and pushing a non-matching product
  // would create / update a listing the rules say shouldn't exist.
  const matches = await productMatchesStore(db, productId, storeId);
  if (!matches) {
    return {
      outcome: 'skipped',
      productId,
      reason: 'product does not match this store\'s routing rules',
    };
  }

  // Find the existing PRIMARY junction(s) for this (storeId, productId).
  // If any exist they share the same shopifyProductId (it's a single
  // Shopify product with N variants). We don't touch SECONDARY junctions
  // here — those are deal/bundle listings with their own catalog data and
  // a different Shopify product id.
  const existingPrimary = await db.productShopifyVariant.findMany({
    where: { productId, shopifyStoreId: storeId, isPrimary: true },
    select: {
      id: true,
      shopifyProductId: true,
      shopifyVariantId: true,
      inventoryItemId: true,
    },
  });
  const isUpdate = existingPrimary.length > 0;
  const existingShopifyProductId = isUpdate
    ? existingPrimary[0].shopifyProductId
    : null;

  // Load + validate the ERP product (same checks for create + update).
  const product = await loadProductForPush(db, productId);
  if (!product) {
    return { outcome: 'skipped', productId, reason: 'product not found' };
  }
  if (product.deletedAt != null) {
    return { outcome: 'skipped', productId, reason: 'product is archived' };
  }
  if (!product.active) {
    return { outcome: 'skipped', productId, reason: 'product is inactive' };
  }
  if (product.variants.length === 0) {
    return {
      outcome: 'skipped',
      productId,
      reason: 'product has no active variants',
    };
  }

  const payload = buildShopifyCreateInput(product);
  const client = new ShopifyClient({
    storeUrl: secrets.storeUrl,
    accessToken: secrets.accessToken,
  });

  // For UPDATE: include existing Shopify variant IDs on each variant in
  // the payload so Shopify updates in place rather than recreating. We
  // round-trip via getProduct to learn the current SKU → shopifyVariantId
  // mapping, since the junction rows don't carry SKU. New ERP variants
  // (no Shopify counterpart by SKU) are sent without `id` and Shopify
  // creates them on the same product. Failure to fetch the current
  // product falls back to no-id variants — the resulting churn is loud
  // but not catastrophic.
  if (isUpdate && existingShopifyProductId) {
    try {
      const current = await client.getProduct(existingShopifyProductId);
      const shopifyVariantIdBySku = new Map<string, string>();
      for (const v of current.variants) {
        if (v.sku) shopifyVariantIdBySku.set(v.sku, v.id);
      }
      for (const v of payload.variants) {
        const id = shopifyVariantIdBySku.get(v.sku);
        if (id) v.id = id;
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(
        '[pushProductToShopify] failed to fetch current product on update — variant ids may be recreated',
        existingShopifyProductId,
        e,
      );
    }
  }

  let shopify;
  try {
    shopify = isUpdate && existingShopifyProductId
      ? await client.updateProduct(existingShopifyProductId, payload)
      : await client.createProduct(payload);
  } catch (e) {
    return {
      outcome: 'error',
      productId,
      reason: e instanceof Error ? e.message : 'unknown shopify error',
    };
  }

  // Upsert junction rows. On CREATE every response variant is new; on
  // UPDATE most response variants already have junction rows that we just
  // refresh (inventoryItemId and syncedAt), and any new Shopify variants
  // (e.g. an ERP variant added since last push) get fresh junction rows.
  const existingJunctionByShopifyVariantId = new Map(
    existingPrimary.map((row) => [row.shopifyVariantId, row]),
  );
  const now = new Date();
  for (const sv of shopify.variants) {
    if (!sv.sku) continue;
    const existing = existingJunctionByShopifyVariantId.get(sv.id);
    if (existing) {
      // Same variant — refresh denorms in case anything shifted.
      await db.productShopifyVariant.update({
        where: { id: existing.id },
        data: {
          inventoryItemId: sv.inventory_item_id,
          syncedAt: now,
        },
      });
    } else {
      await db.productShopifyVariant.create({
        data: {
          productId: product.id,
          shopifyStoreId: storeId,
          shopifyProductId: shopify.id,
          shopifyVariantId: sv.id,
          inventoryItemId: sv.inventory_item_id,
          isPrimary: true,
          syncedAt: now,
        },
      });
    }
  }

  // Best-effort per-variant image assignment. Image ids change on both
  // CREATE (didn't exist before) and UPDATE (PUT /products.json replaces
  // the image set), so the same PUT-per-variant dance applies. A single
  // failed PUT logs + continues.
  const { variantImagePositionBySku } = buildShopifyImagePlan(product);
  if (variantImagePositionBySku.size > 0 && shopify.images.length > 0) {
    const imageByPosition = new Map(
      shopify.images.map((img) => [img.position, img]),
    );
    for (const sv of shopify.variants) {
      if (!sv.sku) continue;
      const position = variantImagePositionBySku.get(sv.sku);
      if (position == null) continue;
      const image = imageByPosition.get(position);
      if (!image) continue;
      try {
        await client.updateVariantImage(sv.id, image.id);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error(
          '[pushProductToShopify] variant image assignment failed',
          { variantId: sv.id, sku: sv.sku, imageId: image.id },
          e,
        );
      }
    }
  }

  await db.product.update({
    where: { id: product.id },
    data: { shopifySyncedAt: now },
  });

  // Best-effort: push current inventory so the new/updated listings get
  // fresh stock counts. A failure here is logged but does NOT flip the
  // outcome — the Shopify product is already in the right shape, and the
  // next movement-driven push (or manual push) will heal.
  try {
    await pushInventoryForProduct(db, product.id);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(
      '[pushProductToShopify] post-write inventory push failed for product',
      product.id,
      e,
    );
  }

  return {
    outcome: isUpdate ? 'updated' : 'created',
    productId: product.id,
    shopifyProductId: shopify.id,
  };
}

/**
 * Iterate every product matching this store's routing rules and create a
 * Shopify listing for each (when not already listed). Per-product failure
 * isolation: one Shopify error doesn't abort the run. Writes a
 * StoredSyncRun summary to ShopifyStore.lastSyncResult so the admin UI's
 * Last sync panel reflects the most recent push activity.
 *
 * NOTE: shares the lastSyncResult slot with runFullSync (catalog pull). A
 * future schema split (lastProductPushResult) would let the UI render
 * push vs. pull separately — out of scope here.
 */
export async function pushAllMatchingProducts(
  db: PrismaClient,
  storeId: string,
  ctx?: AuditContext,
): Promise<StoredSyncRun> {
  const startedAt = new Date();
  let created = 0;
  let updated = 0;
  let skipped = 0;
  const errors: StoredSyncRun['errors'] = [];

  // Gate the bulk action on syncEnabled up front — saves a no-op walk over
  // matchingProductIds when the store is paused. The per-product function
  // also gates, but doing it here lets the audit row reflect intent
  // accurately.
  const storeSecrets = await getSecretsForStore(db, storeId);
  if (!storeSecrets.syncEnabled) {
    const run: StoredSyncRun = {
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      created: 0,
      updated: 0,
      skipped: 0,
      errors: [
        {
          shopifyId: '',
          message: 'sync disabled for this store — enable it first',
        },
      ],
    };
    await recordSyncRun(db, storeId, run);
    return run;
  }

  const productIds = await matchingProductIds(db, storeId);

  for (const productId of productIds) {
    try {
      const result = await pushProductToShopify(db, storeId, productId);
      if (result.outcome === 'created') created++;
      else if (result.outcome === 'updated') updated++;
      else if (result.outcome === 'skipped') skipped++;
      else
        errors.push({
          shopifyId: result.shopifyProductId ?? '',
          message: `${productId}: ${result.reason ?? 'unknown'}`,
        });
    } catch (e) {
      errors.push({
        shopifyId: '',
        message: `${productId}: ${e instanceof Error ? e.message : 'unknown'}`,
      });
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

  // Audit the bulk run. Per-product creates/updates are not separately
  // audited; the StoredSyncRun summary captures the counts + errors for
  // review.
  await audit(db, {
    action: AuditAction.CREATE,
    entityType: 'ShopifyProductPushRun',
    entityId: storeId,
    after: {
      storeId,
      created,
      updated,
      skipped,
      errors: errors.length,
      durationMs:
        new Date(run.finishedAt).getTime() -
        new Date(run.startedAt).getTime(),
    },
    ctx,
  });

  return run;
}
