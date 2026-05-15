-- =============================================================
-- add_product_images
-- Spec: docs/02-products-inventory.md (#85 — images on Product,
-- multiple + primary flag; variant-specific deferred but pilot
-- allows a single ProductVariant.imageUrl as a thumbnail override).
--
-- Adds:
--   * ProductImage table — multi-image gallery, one isPrimary flag
--     per product (enforced service-side, not via partial unique
--     because swap-primary needs to atomically demote → promote).
--   * ProductVariant.imageUrl — single optional image override for
--     a variant. ProductThumbnail resolves variant.imageUrl ??
--     product's primary ProductImage.url.
-- =============================================================

ALTER TABLE "ProductVariant" ADD COLUMN "imageUrl" TEXT;

CREATE TABLE "ProductImage" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "altText" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductImage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ProductImage_productId_sortOrder_idx" ON "ProductImage"("productId", "sortOrder");
CREATE INDEX "ProductImage_productId_isPrimary_idx" ON "ProductImage"("productId", "isPrimary");
CREATE INDEX "ProductImage_deletedAt_idx" ON "ProductImage"("deletedAt");

ALTER TABLE "ProductImage" ADD CONSTRAINT "ProductImage_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
