-- Migration: add_shopify_stores_and_rules
--
-- Multi-store Shopify integration. Adds ShopifyStore + ShopifyStoreRule
-- tables, attaches ProductShopifyVariant to a store, caches inventoryItemId
-- on the junction, and migrates the legacy single-store config (Setting
-- row 'shopify.config') into a single ShopifyStore row with an INCLUDE_ALL
-- rule so existing behavior is preserved.
--
-- Steps:
--   1. Create the ShopifyStoreRuleType enum.
--   2. Create ShopifyStore + ShopifyStoreRule tables.
--   3. Add nullable shopifyStoreId + inventoryItemId to ProductShopifyVariant.
--   4. Migrate the legacy Setting row into one ShopifyStore + INCLUDE_ALL
--      rule, then backfill every existing junction row to that store.
--   5. SET NOT NULL on shopifyStoreId, swap unique constraints, add
--      indexes + the FK.
--   6. Delete the legacy 'shopify.config' Setting row.

-- 1. Enum.
CREATE TYPE "ShopifyStoreRuleType" AS ENUM (
  'INCLUDE_ALL',
  'INCLUDE_VENDOR',
  'EXCLUDE_VENDOR',
  'INCLUDE_CATEGORY',
  'EXCLUDE_CATEGORY',
  'INCLUDE_TAG',
  'EXCLUDE_TAG'
);

-- 2. ShopifyStore + ShopifyStoreRule tables.
CREATE TABLE "ShopifyStore" (
    "id"                     TEXT NOT NULL,
    "name"                   TEXT NOT NULL,
    "storeUrl"               TEXT NOT NULL,
    "accessToken"            JSONB,
    "webhookSecret"          JSONB,
    "syncEnabled"            BOOLEAN NOT NULL DEFAULT false,
    "inventoryPushEnabled"   BOOLEAN NOT NULL DEFAULT false,
    "shopifyLocationId"      TEXT,
    "lastProductSyncAt"      TIMESTAMP(3),
    "lastInventoryPushAt"    TIMESTAMP(3),
    "lastSyncResult"         JSONB,
    "lastPushResult"         JSONB,
    "webhookSubscriptionIds" JSONB,
    "sortOrder"              INTEGER NOT NULL DEFAULT 0,
    "active"                 BOOLEAN NOT NULL DEFAULT true,
    "deletedAt"              TIMESTAMP(3),
    "createdAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy"              TEXT,
    "updatedBy"              TEXT,

    CONSTRAINT "ShopifyStore_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ShopifyStore_storeUrl_key" ON "ShopifyStore"("storeUrl");
CREATE INDEX "ShopifyStore_active_idx"    ON "ShopifyStore"("active");
CREATE INDEX "ShopifyStore_deletedAt_idx" ON "ShopifyStore"("deletedAt");

CREATE TABLE "ShopifyStoreRule" (
    "id"             TEXT NOT NULL,
    "shopifyStoreId" TEXT NOT NULL,
    "ruleType"       "ShopifyStoreRuleType" NOT NULL,
    "value"          TEXT NOT NULL DEFAULT '',
    "sortOrder"      INTEGER NOT NULL DEFAULT 0,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy"      TEXT,
    "updatedBy"      TEXT,

    CONSTRAINT "ShopifyStoreRule_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ShopifyStoreRule_shopifyStoreId_sortOrder_idx"
    ON "ShopifyStoreRule"("shopifyStoreId", "sortOrder");

ALTER TABLE "ShopifyStoreRule"
    ADD CONSTRAINT "ShopifyStoreRule_shopifyStoreId_fkey"
    FOREIGN KEY ("shopifyStoreId") REFERENCES "ShopifyStore"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- 3. Junction additions — nullable for now, backfilled in step 4.
ALTER TABLE "ProductShopifyVariant"
    ADD COLUMN "shopifyStoreId"  TEXT,
    ADD COLUMN "inventoryItemId" TEXT;

-- 4. Migrate the legacy Setting row.
--    The 'shopify.config' value is a JSON blob — we lift the relevant
--    fields into a single ShopifyStore row, drop in one INCLUDE_ALL rule,
--    and point every existing junction row at the new store. The whole
--    block runs in this migration's implicit transaction; if the Setting
--    row is missing (fresh install / dev DB before single-store was used),
--    we just skip — no rows to backfill.
DO $$
DECLARE
  cfg_value   JSONB;
  new_store_id TEXT;
  store_url_value TEXT;
BEGIN
  SELECT "value"::jsonb INTO cfg_value
  FROM "Setting"
  WHERE "key" = 'shopify.config';

  IF cfg_value IS NOT NULL THEN
    store_url_value := COALESCE(cfg_value->>'storeUrl', '');

    -- Only migrate if we have a non-empty storeUrl AND there are junction
    -- rows to attach (empty config row = nothing useful to carry over).
    IF store_url_value <> '' THEN
      new_store_id := 'mig_' || md5(random()::text || clock_timestamp()::text || store_url_value);

      INSERT INTO "ShopifyStore" (
        "id", "name", "storeUrl",
        "accessToken", "webhookSecret",
        "syncEnabled", "inventoryPushEnabled",
        "shopifyLocationId",
        "lastProductSyncAt", "lastInventoryPushAt",
        "lastSyncResult", "lastPushResult",
        "webhookSubscriptionIds",
        "sortOrder", "active",
        "createdAt", "updatedAt"
      ) VALUES (
        new_store_id,
        'Default',
        store_url_value,
        cfg_value->'accessToken',
        cfg_value->'webhookSecret',
        COALESCE((cfg_value->>'syncEnabled')::boolean, false),
        false,
        NULL,
        NULLIF(cfg_value->>'lastFullSyncAt', '')::timestamp,
        NULL,
        cfg_value->'lastSync',
        NULL,
        cfg_value->'webhookSubscriptions',
        0,
        true,
        NOW(),
        NOW()
      );

      -- INCLUDE_ALL so behavior matches the legacy single-store config.
      INSERT INTO "ShopifyStoreRule" (
        "id", "shopifyStoreId", "ruleType", "value", "sortOrder", "createdAt", "updatedAt"
      ) VALUES (
        'mig_' || md5(random()::text || clock_timestamp()::text || new_store_id || 'rule'),
        new_store_id,
        'INCLUDE_ALL',
        '',
        0,
        NOW(),
        NOW()
      );

      -- Attach every existing junction row to the migrated store.
      UPDATE "ProductShopifyVariant"
         SET "shopifyStoreId" = new_store_id
       WHERE "shopifyStoreId" IS NULL;
    END IF;
  END IF;
END $$;

-- 5. SET NOT NULL, swap constraints, add FK + indexes.
--
-- Safety check: if any junction rows remain unattached (e.g. the Setting
-- row was missing but junction rows exist somehow), the SET NOT NULL will
-- fail loudly — better than silently dropping rows.
ALTER TABLE "ProductShopifyVariant"
    ALTER COLUMN "shopifyStoreId" SET NOT NULL;

-- Drop the old global-unique on shopifyVariantId; replace with composite
-- (shopifyStoreId, shopifyVariantId) — different Shopify tenants have
-- independent id namespaces, so global uniqueness was incorrect anyway.
DROP INDEX IF EXISTS "ProductShopifyVariant_shopifyVariantId_key";
DROP INDEX IF EXISTS "ProductShopifyVariant_shopifyProductId_idx";

CREATE UNIQUE INDEX "ProductShopifyVariant_shopifyStoreId_shopifyVariantId_key"
    ON "ProductShopifyVariant"("shopifyStoreId", "shopifyVariantId");

CREATE INDEX "ProductShopifyVariant_shopifyStoreId_shopifyProductId_idx"
    ON "ProductShopifyVariant"("shopifyStoreId", "shopifyProductId");

ALTER TABLE "ProductShopifyVariant"
    ADD CONSTRAINT "ProductShopifyVariant_shopifyStoreId_fkey"
    FOREIGN KEY ("shopifyStoreId") REFERENCES "ShopifyStore"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- 6. Retire the legacy Setting row — all data has moved to ShopifyStore.
DELETE FROM "Setting" WHERE "key" = 'shopify.config';
