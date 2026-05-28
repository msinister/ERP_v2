import { z } from 'zod';

// =============================================================================
// Multi-store Shopify integration — admin form inputs. Each ShopifyStore row
// carries connection settings + sync/push flags; ShopifyStoreRule rows carry
// the routing logic that decides which products are eligible for that store.
//
// Secrets (accessToken, webhookSecret) are optional on update — empty/absent
// means "leave the currently-stored value alone" so an admin can toggle
// syncEnabled without re-typing tokens. The service layer handles the
// preserve-vs-replace logic.
// =============================================================================

// Bare-host form: "mystore.myshopify.com" — no protocol, no path. The
// ShopifyClient prepends https:// + /admin/api/...; keeping the stored value
// canonical avoids URL surprises if the field is ever echoed to logs.
const STORE_URL_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i;

// Mirrors the CustomerType enum in the tenant schema. Kept inline (not
// imported from @/generated/tenant) so this validation file stays
// importable from edge / client bundles that can't reach the Prisma
// runtime.
const CUSTOMER_TYPE = z.enum([
  'WHOLESALE_REGULAR',
  'WHOLESALE_PREFERRED',
  'WHOLESALE_DISTRIBUTOR',
  'WHOLESALE_MASTER_DISTRIBUTOR',
  'RETAIL',
]);

export const shopifyStoreCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  storeUrl: z
    .string()
    .trim()
    .toLowerCase()
    .regex(STORE_URL_RE, 'Must look like "mystore.myshopify.com"'),
  accessToken: z.string().trim().min(1).max(512).optional(),
  webhookSecret: z.string().trim().min(1).max(512).optional(),
  syncEnabled: z.boolean().default(false),
  inventoryPushEnabled: z.boolean().default(false),
  orderSyncEnabled: z.boolean().default(false),
  shopifyLocationId: z.string().trim().min(1).max(64).optional(),
  // Order-import defaults — every one is required before order sync can
  // actually run, but the service accepts them piecemeal so an operator
  // can stand up the store first and fill these in afterwards. The
  // importer throws StoreNotConfiguredForOrderSyncError when one is
  // missing at import time.
  defaultWarehouseId: z.string().min(1).optional(),
  defaultSalesRepId: z.string().min(1).optional(),
  defaultPaymentTermId: z.string().min(1).optional(),
  defaultCustomerType: CUSTOMER_TYPE.optional(),
  // Omitted on create → service computes max(sortOrder) + 10 so new stores
  // append to the end of the list without disturbing existing order.
  sortOrder: z.number().int().min(0).optional(),
  active: z.boolean().default(true),
});

export const shopifyStoreUpdateSchema = shopifyStoreCreateSchema.partial().extend({
  // Allow explicit null on the update path so an operator can clear a
  // default they previously set. The service maps null → Prisma.DbNull.
  defaultWarehouseId: z.string().min(1).nullable().optional(),
  defaultSalesRepId: z.string().min(1).nullable().optional(),
  defaultPaymentTermId: z.string().min(1).nullable().optional(),
  defaultCustomerType: CUSTOMER_TYPE.nullable().optional(),
});

export type ShopifyStoreCreateInput = z.infer<typeof shopifyStoreCreateSchema>;
export type ShopifyStoreUpdateInput = z.infer<typeof shopifyStoreUpdateSchema>;

// One rule row. The `value` field is empty for INCLUDE_ALL and required for
// every typed variant. Matching is case-insensitive at evaluation time, so we
// don't force casing here — we just trim.
export const shopifyStoreRuleInputSchema = z
  .object({
    ruleType: z.enum([
      'INCLUDE_ALL',
      'INCLUDE_VENDOR',
      'EXCLUDE_VENDOR',
      'INCLUDE_CATEGORY',
      'EXCLUDE_CATEGORY',
      'INCLUDE_TAG',
      'EXCLUDE_TAG',
    ]),
    value: z.string().trim().max(255).optional(),
    sortOrder: z.number().int().min(0).default(0),
  })
  .superRefine((data, ctx) => {
    if (data.ruleType !== 'INCLUDE_ALL') {
      if (!data.value || data.value === '') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['value'],
          message: 'value is required for this rule type',
        });
      }
    }
  });

// Wholesale-replace payload — POST/PUT the full ruleset for a store, the
// service deletes existing rows and inserts these. Simpler than per-row
// CRUD; matches how the admin UI rule builder works.
export const shopifyStoreRulesReplaceSchema = z.object({
  rules: z.array(shopifyStoreRuleInputSchema),
});

export type ShopifyStoreRuleInput = z.infer<typeof shopifyStoreRuleInputSchema>;
export type ShopifyStoreRulesReplaceInput = z.infer<
  typeof shopifyStoreRulesReplaceSchema
>;
