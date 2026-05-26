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
  getSecrets,
  recordSyncRun,
  type StoredSyncRun,
} from './shopifyConfig';

// =============================================================================
// Shopify → ERP product sync.
//
// Direction is one-way: Shopify is master for catalog data (name,
// description, images, vendor, category, tags, status). ERP is master
// for inventory, cost, WAC, and pricing — those fields are NEVER
// overwritten by this service.
//
// Variant model is FLAT: one Shopify variant → one ERP Product (+ one
// ProductVariant row). Sibling variants from the same Shopify product
// share ProductVariant.variantGroup = `shopify:{shopifyProductId}` so
// the UI can re-group them later if needed.
//
// Matching cascade for each incoming Shopify variant:
//   1. ERP Product where shopifyVariantId = <variant.id>
//   2. ERP Product where sku = <variant.sku>  (adopt existing manually-
//      created product into the sync; back-fill shopifyProductId +
//      shopifyVariantId)
//   3. No match → create.
//
// Full-sync runtime is INLINE per the pilot's ~40-SKU scale. When a
// tenant grows past a few thousand products, lift this onto Inngest
// (tech-stack listed; not wired) — the public function shapes are
// designed to map cleanly onto job handlers.
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
 *   - 'active' → upsert each variant; mark Product.active = true.
 *   - 'draft' / 'archived' → flip Product.active = false on every
 *     previously-synced sibling and return outcome='updated' for each
 *     (no creates). Does NOT soft-delete — that's reversible if the
 *     product flips back to active on Shopify.
 */
export async function upsertProductFromShopify(
  db: PrismaClient,
  sp: ShopifyProduct,
  ctx?: AuditContext,
): Promise<UpsertResult[]> {
  if (sp.status !== 'active') {
    return deactivateShopifyProduct(db, sp.id, ctx);
  }

  const vendor = sp.vendor
    ? await resolveVendor(db, sp.vendor, ctx)
    : null;
  const tagNames = parseTags(sp.tags);
  const variantGroup = `shopify:${sp.id}`;

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
    const res = await upsertVariant(db, {
      shopifyProduct: sp,
      shopifyVariant: variant,
      variantGroup,
      vendorId: vendor?.id ?? null,
      tagNames,
      ctx,
    });
    results.push(res);
  }
  return results;
}

/**
 * Walk all active Shopify products and upsert each. Records the run
 * summary to the Setting row so the admin UI can render "Last sync".
 */
export async function runFullSync(
  db: PrismaClient,
  ctx: AuditContext | undefined,
): Promise<StoredSyncRun> {
  const secrets = await getSecrets(db);
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
        const results = await upsertProductFromShopify(db, sp, ctx);
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
  await recordSyncRun(db, run, ctx?.userId ?? null);
  return run;
}

/**
 * Mark every previously-synced ERP Product for this Shopify product id
 * as inactive. Used by the products/delete webhook and by status
 * transitions to 'draft' / 'archived'.
 */
export async function deactivateShopifyProduct(
  db: PrismaClient,
  shopifyProductId: string,
  ctx?: AuditContext,
): Promise<UpsertResult[]> {
  const siblings = await db.product.findMany({
    where: { shopifyProductId, deletedAt: null },
    select: { id: true, sku: true, active: true },
  });
  const results: UpsertResult[] = [];
  for (const s of siblings) {
    if (!s.active) {
      results.push({ outcome: 'skipped', productId: s.id, sku: s.sku, reason: 'already inactive' });
      continue;
    }
    await db.product.update({
      where: { id: s.id },
      data: { active: false, shopifySyncedAt: new Date() },
    });
    await audit(db, {
      action: AuditAction.UPDATE,
      entityType: 'Product',
      entityId: s.id,
      before: { active: true },
      after: { active: false, source: 'shopify' },
      ctx,
    });
    results.push({ outcome: 'updated', productId: s.id, sku: s.sku });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Variant-level upsert (one Shopify variant ⇒ one ERP Product row).
// ---------------------------------------------------------------------------

type VariantUpsertArgs = {
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
  const { shopifyProduct: sp, shopifyVariant: sv, variantGroup, tagNames, ctx } = args;

  // Match cascade. Matching by sku adopts a manually-created ERP product
  // into the sync the first time Shopify sends it — the spec calls this
  // out as desired behavior.
  const byShopifyVariant = await db.product.findUnique({
    where: { shopifyVariantId: sv.id },
  });
  const existing =
    byShopifyVariant ??
    (await db.product.findUnique({ where: { sku: sv.sku } }));

  // Build the field set that Shopify owns. Cost / WAC / inventory /
  // basePrice are NOT in this map — ERP keeps those.
  const variantTitleSuffix = displayVariantSuffix(sv);
  const name = variantTitleSuffix ? `${sp.title} — ${variantTitleSuffix}` : sp.title;
  const shopifyOwnedFields = {
    name,
    longDescription: sp.body_html,
    brand: sp.vendor ?? null,
    category: sp.product_type ?? null,
    manufacturerPartNumber: sv.barcode ?? null,
    weight: sv.weight != null ? new Prisma.Decimal(sv.weight) : null,
    weightUnit: sv.weight_unit ?? null,
    shopifyProductId: sp.id,
    shopifyVariantId: sv.id,
    shopifySyncedAt: new Date(),
    active: true,
  } satisfies Partial<Product>;

  if (existing) {
    return db.$transaction(async (tx) => {
      const before = await tx.product.findUniqueOrThrow({
        where: { id: existing.id },
        select: {
          name: true,
          longDescription: true,
          brand: true,
          category: true,
          manufacturerPartNumber: true,
          weight: true,
          weightUnit: true,
          shopifyProductId: true,
          shopifyVariantId: true,
          active: true,
        },
      });
      await tx.product.update({
        where: { id: existing.id },
        data: shopifyOwnedFields,
      });
      await ensureVariantRow(tx, existing.id, sv.sku, variantGroup);
      await syncTags(tx, existing.id, tagNames, ctx);
      await syncImages(tx, existing.id, sp.images);
      await audit(tx, {
        action: AuditAction.UPDATE,
        entityType: 'Product',
        entityId: existing.id,
        before,
        after: { ...shopifyOwnedFields, source: 'shopify' },
        ctx,
      });
      return { outcome: 'updated' as const, productId: existing.id, sku: sv.sku };
    });
  }

  // Create path.
  return db.$transaction(async (tx) => {
    const created = await tx.product.create({
      data: {
        sku: sv.sku,
        ...shopifyOwnedFields,
      },
    });
    await ensureVariantRow(tx, created.id, sv.sku, variantGroup);
    await syncTags(tx, created.id, tagNames, ctx);
    await syncImages(tx, created.id, sp.images);
    await audit(tx, {
      action: AuditAction.CREATE,
      entityType: 'Product',
      entityId: created.id,
      after: {
        sku: created.sku,
        ...shopifyOwnedFields,
        source: 'shopify',
      },
      ctx,
    });
    return { outcome: 'created' as const, productId: created.id, sku: sv.sku };
  });
}

// ---------------------------------------------------------------------------
// Side-effect helpers
// ---------------------------------------------------------------------------

/**
 * Find a Vendor by case-insensitive name. Create one with type=STOCK and
 * an auto-generated code if absent. Conservative: never updates an
 * existing vendor's metadata.
 */
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

  // Code: SHOPIFY-<slug> with numeric suffix on collision. Keep it
  // short — vendor codes are referenced in UI columns.
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

// Ensure a ProductVariant row exists for the (productId, sku) pair and
// has the right variantGroup. The sync's flat model implies one variant
// row per product, so we upsert by productId.
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
  await tx.productVariant.create({
    data: { productId, sku, variantGroup, active: true },
  });
}

// Upsert tags: lazy-create new Tag rows, ensure ProductTag assignment,
// drop assignments no longer in the incoming set (Shopify is master for
// product tags, just like the rest of the catalog data).
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
  const currentNames = new Set(
    currentRows.map((r) => r.tag.name.toLowerCase()),
  );
  const wantNames = new Set(names.map((n) => n.toLowerCase()));

  // Add new.
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
  // Remove dropped.
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

// Image sync. We ONLY touch images carrying shopifyImageId — operator-
// added images (no shopifyImageId) are preserved. First Shopify image
// is marked primary unless an operator-added image already holds the
// primary slot.
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

  // Soft-delete any previously-synced images that Shopify no longer ships.
  for (const img of currentShopifyImages) {
    if (img.shopifyImageId && !incomingIds.has(img.shopifyImageId)) {
      await tx.productImage.update({
        where: { id: img.id },
        data: { deletedAt: new Date(), isPrimary: false },
      });
    }
  }

  // Upsert each Shopify image by shopifyImageId.
  for (let i = 0; i < shopifyImages.length; i++) {
    const img = shopifyImages[i];
    // First Shopify image is the primary candidate — but only when no
    // operator-added primary is already set.
    const wantPrimary = i === 0 && !operatorHasPrimary;
    const existing = currentShopifyImages.find(
      (e) => e.shopifyImageId === img.id,
    );
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

  // If we set a new primary, demote any other Shopify-sourced primary.
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
  // Shopify uses "Default Title" for products with no real options;
  // hide that from the ERP product name.
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
