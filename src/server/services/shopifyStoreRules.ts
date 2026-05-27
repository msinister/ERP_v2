import { AuditAction } from '@/generated/tenant';
import type {
  PrismaClient,
  ShopifyStoreRule,
  ShopifyStoreRuleType,
} from '@/generated/tenant';
import { audit, type AuditContext } from '@/lib/audit/audit';
import {
  shopifyStoreRulesReplaceSchema,
  type ShopifyStoreRulesReplaceInput,
} from '@/lib/validation/shopifyStores';

// =============================================================================
// Per-store routing rules. Each rule row is one INCLUDE/EXCLUDE clause keyed
// by vendor name, category name, or tag name — plus the special INCLUDE_ALL
// catch-all. Together a store's rules decide which ERP products are eligible
// to sync to / push inventory to that store.
//
// Evaluation semantics (see productMatchesStore):
//   - No rules         → no products eligible (explicit opt-in).
//   - INCLUDE_ALL      → every active product eligible (unless excluded).
//   - INCLUDE_*        → additive (union). A product matching any include is in.
//   - EXCLUDE_*        → wins over includes. A product matching any exclude is out.
//
// Vendor matching uses the product's primary VendorProduct row (isPrimary=true
// on any of its variants) — matches the "Vendor" shown on the product
// overview tab and what operators expect when they tag a vendor for routing.
//
// The rule editor wholesale-replaces the rule set per save (replaceRules),
// rather than per-row CRUD — simpler and avoids partial-update races between
// the visual rule builder and the eligibility check.
// =============================================================================

export async function listRules(
  db: PrismaClient,
  storeId: string,
): Promise<ShopifyStoreRule[]> {
  return db.shopifyStoreRule.findMany({
    where: { shopifyStoreId: storeId },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
  });
}

export async function replaceRules(
  db: PrismaClient,
  storeId: string,
  input: ShopifyStoreRulesReplaceInput,
  ctx?: AuditContext,
): Promise<ShopifyStoreRule[]> {
  const data = shopifyStoreRulesReplaceSchema.parse(input);
  return db.$transaction(async (tx) => {
    const before = await tx.shopifyStoreRule.findMany({
      where: { shopifyStoreId: storeId },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    await tx.shopifyStoreRule.deleteMany({ where: { shopifyStoreId: storeId } });
    const created: ShopifyStoreRule[] = [];
    for (let i = 0; i < data.rules.length; i++) {
      const r = data.rules[i];
      const row = await tx.shopifyStoreRule.create({
        data: {
          shopifyStoreId: storeId,
          ruleType: r.ruleType as ShopifyStoreRuleType,
          value: (r.value ?? '').trim(),
          sortOrder: r.sortOrder ?? i,
          createdBy: ctx?.userId ?? null,
          updatedBy: ctx?.userId ?? null,
        },
      });
      created.push(row);
    }
    await audit(tx, {
      action: AuditAction.UPDATE,
      entityType: 'ShopifyStoreRules',
      entityId: storeId,
      before: { rules: before },
      after: { rules: created },
      ctx,
    });
    return created;
  });
}

// ---------------------------------------------------------------------------
// Matching engine
// ---------------------------------------------------------------------------

type RuleSnapshot = {
  ruleType: ShopifyStoreRuleType;
  value: string;
};

type ProductFacts = {
  category: string | null;
  vendorNames: string[];
  tagNames: string[];
};

function normalize(s: string | null | undefined): string {
  return (s ?? '').trim().toLowerCase();
}

function evaluate(rules: RuleSnapshot[], facts: ProductFacts): boolean {
  if (rules.length === 0) return false;

  const norm = {
    category: normalize(facts.category),
    vendors: facts.vendorNames.map(normalize),
    tags: facts.tagNames.map(normalize),
  };

  let included = false;

  for (const r of rules) {
    if (r.ruleType === 'INCLUDE_ALL') {
      included = true;
      continue;
    }
    const v = normalize(r.value);
    switch (r.ruleType) {
      case 'INCLUDE_VENDOR':
        if (norm.vendors.includes(v)) included = true;
        break;
      case 'INCLUDE_CATEGORY':
        if (norm.category === v) included = true;
        break;
      case 'INCLUDE_TAG':
        if (norm.tags.includes(v)) included = true;
        break;
      case 'EXCLUDE_VENDOR':
        if (norm.vendors.includes(v)) return false;
        break;
      case 'EXCLUDE_CATEGORY':
        if (norm.category === v) return false;
        break;
      case 'EXCLUDE_TAG':
        if (norm.tags.includes(v)) return false;
        break;
    }
  }
  return included;
}

async function loadProductFacts(
  db: PrismaClient,
  productId: string,
): Promise<ProductFacts | null> {
  const product = await db.product.findUnique({
    where: { id: productId },
    select: {
      category: true,
      variants: {
        where: { deletedAt: null },
        select: {
          vendorProducts: {
            where: { isPrimary: true, deletedAt: null },
            select: { vendor: { select: { name: true } } },
          },
        },
      },
      tags: { select: { tag: { select: { name: true } } } },
    },
  });
  if (!product) return null;
  const vendorNames = new Set<string>();
  for (const v of product.variants) {
    for (const vp of v.vendorProducts) {
      if (vp.vendor?.name) vendorNames.add(vp.vendor.name);
    }
  }
  return {
    category: product.category,
    vendorNames: [...vendorNames],
    tagNames: product.tags.map((t) => t.tag.name),
  };
}

/**
 * Does this product match this store's rules? Returns true if the product
 * should be synced/pushed to the store, false otherwise.
 *
 * Loads the store's rules + the product's facts (category, primary vendors,
 * tags) and runs the matcher. Single product check — for full-sync / preview
 * counts, prefer matchingProductIds which batches.
 */
export async function productMatchesStore(
  db: PrismaClient,
  productId: string,
  storeId: string,
): Promise<boolean> {
  const [rules, facts] = await Promise.all([
    listRules(db, storeId),
    loadProductFacts(db, productId),
  ]);
  if (!facts) return false;
  return evaluate(rules, facts);
}

/**
 * Return the ids of every active product eligible for this store. Used for
 * the full-sync driver, push-all driver, and the live "matches X products"
 * preview count in the rule builder UI.
 *
 * Loads rules + relevant product facets in a single pass; evaluates the rule
 * set per product. Skips archived (deletedAt) and inactive products. Pilot
 * scale (<10k products) so we don't paginate — a single in-process scan is
 * fine. Promote to a streaming/iterator API if the dataset grows.
 */
export async function matchingProductIds(
  db: PrismaClient,
  storeId: string,
): Promise<string[]> {
  const rules = await listRules(db, storeId);
  if (rules.length === 0) return [];

  const products = await db.product.findMany({
    where: { active: true, deletedAt: null },
    select: {
      id: true,
      category: true,
      variants: {
        where: { deletedAt: null },
        select: {
          vendorProducts: {
            where: { isPrimary: true, deletedAt: null },
            select: { vendor: { select: { name: true } } },
          },
        },
      },
      tags: { select: { tag: { select: { name: true } } } },
    },
  });

  const out: string[] = [];
  for (const p of products) {
    const vendorNames = new Set<string>();
    for (const v of p.variants) {
      for (const vp of v.vendorProducts) {
        if (vp.vendor?.name) vendorNames.add(vp.vendor.name);
      }
    }
    const facts: ProductFacts = {
      category: p.category,
      vendorNames: [...vendorNames],
      tagNames: p.tags.map((t) => t.tag.name),
    };
    if (evaluate(rules, facts)) out.push(p.id);
  }
  return out;
}
