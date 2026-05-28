-- Migration: replace Customer.shopifyCustomerId scalar with a store-scoped
-- ShopifyCustomerLink junction table. This allows the same Shopify customer
-- (or email) to map to different ERP billing accounts on different stores —
-- the standard pattern for multi-location B2B accounts that share one email.

-- 1. Create the new junction table.
CREATE TABLE "ShopifyCustomerLink" (
    "shopifyStoreId"    TEXT NOT NULL,
    "shopifyCustomerId" TEXT NOT NULL,
    "customerId"        TEXT NOT NULL,
    "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShopifyCustomerLink_pkey" PRIMARY KEY ("shopifyStoreId", "shopifyCustomerId")
);

-- 2. Index on customerId so "which stores link to this ERP customer?" is fast.
CREATE INDEX "ShopifyCustomerLink_customerId_idx" ON "ShopifyCustomerLink"("customerId");

-- 3. Foreign keys.
ALTER TABLE "ShopifyCustomerLink"
    ADD CONSTRAINT "ShopifyCustomerLink_shopifyStoreId_fkey"
    FOREIGN KEY ("shopifyStoreId") REFERENCES "ShopifyStore"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ShopifyCustomerLink"
    ADD CONSTRAINT "ShopifyCustomerLink_customerId_fkey"
    FOREIGN KEY ("customerId") REFERENCES "Customer"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- 4. Migrate any existing Customer.shopifyCustomerId values. Since the old
--    column had no store context we can't know which store each link belonged
--    to, so we skip migrating rows with NULL shopifyCustomerId and attempt
--    to insert rows for non-NULL values against the first active store that
--    has orderSyncEnabled (best-effort; conflicts are ignored). For the pilot
--    this affects at most a handful of test rows that will re-link on the
--    next order sync run via the email-match path.
INSERT INTO "ShopifyCustomerLink" ("shopifyStoreId", "shopifyCustomerId", "customerId")
SELECT
    (SELECT id FROM "ShopifyStore" WHERE "orderSyncEnabled" = true AND "deletedAt" IS NULL ORDER BY "createdAt" LIMIT 1),
    c."shopifyCustomerId",
    c.id
FROM "Customer" c
WHERE c."shopifyCustomerId" IS NOT NULL
  AND EXISTS (SELECT 1 FROM "ShopifyStore" WHERE "orderSyncEnabled" = true AND "deletedAt" IS NULL)
ON CONFLICT DO NOTHING;

-- 5. Drop the old scalar column and its index from Customer.
DROP INDEX IF EXISTS "Customer_shopifyCustomerId_idx";
ALTER TABLE "Customer" DROP COLUMN IF EXISTS "shopifyCustomerId";
