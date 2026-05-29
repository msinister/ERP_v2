-- Migration: add_product_shopify_variant_junction
--
-- Replaces the flat shopifyProductId / shopifyVariantId columns on the
-- Product table with a proper junction table (ProductShopifyVariant).
-- This lets one ERP product map to multiple Shopify listings — the
-- "primary" listing drives catalog fields; secondary listings (deal /
-- bundle / mix-and-match) just register their variant IDs for future
-- inventory-push fan-out without creating duplicate ERP products.
--
-- Steps:
--   1. Create the junction table.
--   2. Populate it from every Product row that already has a
--      shopifyVariantId — all become isPrimary = true.
--   3. Drop the now-redundant columns from Product.

-- 1. Create junction table.
CREATE TABLE "ProductShopifyVariant" (
    "id"               TEXT NOT NULL,
    "productId"        TEXT NOT NULL,
    "shopifyProductId" TEXT NOT NULL,
    "shopifyVariantId" TEXT NOT NULL,
    "isPrimary"        BOOLEAN NOT NULL DEFAULT false,
    "syncedAt"         TIMESTAMP(3) NOT NULL,
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductShopifyVariant_pkey" PRIMARY KEY ("id")
);

-- Unique: one Shopify variant → one ERP product.
CREATE UNIQUE INDEX "ProductShopifyVariant_shopifyVariantId_key"
    ON "ProductShopifyVariant"("shopifyVariantId");

-- Lookup indexes.
CREATE INDEX "ProductShopifyVariant_productId_idx"
    ON "ProductShopifyVariant"("productId");

CREATE INDEX "ProductShopifyVariant_shopifyProductId_idx"
    ON "ProductShopifyVariant"("shopifyProductId");

-- FK to Product.
ALTER TABLE "ProductShopifyVariant"
    ADD CONSTRAINT "ProductShopifyVariant_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "Product"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- 2. Populate from existing Product rows (if they had shopifyVariantId).
--    Guard: on fresh installs the column never existed on Product, so skip.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'Product'
      AND column_name  = 'shopifyVariantId'
  ) THEN
    INSERT INTO "ProductShopifyVariant"
        ("id", "productId", "shopifyProductId", "shopifyVariantId",
         "isPrimary", "syncedAt", "createdAt", "updatedAt")
    SELECT
        'mig_' || md5(random()::text || clock_timestamp()::text || "id"),
        "id",
        "shopifyProductId",
        "shopifyVariantId",
        true,
        COALESCE("shopifySyncedAt", NOW()),
        NOW(),
        NOW()
    FROM "Product"
    WHERE "shopifyVariantId" IS NOT NULL
      AND "shopifyProductId" IS NOT NULL;
  END IF;
END $$;

-- 3. Drop the redundant columns from Product.
DROP INDEX IF EXISTS "Product_shopifyVariantId_key";
DROP INDEX IF EXISTS "Product_shopifyProductId_idx";

ALTER TABLE "Product"
    DROP COLUMN IF EXISTS "shopifyProductId",
    DROP COLUMN IF EXISTS "shopifyVariantId";
