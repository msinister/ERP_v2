-- =============================================================
-- add_vendor_master
-- Expands the Vendor stub into the full master + adds VendorContact,
-- VendorAddress, VendorProduct. Hand-written because Prisma can't
-- express partial unique indices with WHERE "deletedAt" IS NULL.
--
-- Pilot scope: drop-ship commission and payment-method records are
-- deferred. defaultCommissionRate is included as nullable schema
-- room so the future drop-ship slice doesn't migrate.
--
-- Pre-existing Vendor rows (created by upsert-stub fixtures in 11+
-- test files + scripts/manual-test-po-flow.ts) survive: every new
-- column is nullable or carries a default, so legacy upserts that
-- only supply (code, name) keep passing.
-- =============================================================

-- 1. New enums.
CREATE TYPE "VendorType" AS ENUM ('STOCK', 'DROP_SHIP', 'SERVICE');
CREATE TYPE "VendorAddressKind" AS ENUM ('REMIT_TO', 'SHIPPING', 'BILLING');

-- 2. Extend the Vendor model. All new columns are nullable or have
--    defaults so existing rows survive.
ALTER TABLE "Vendor"
  ADD COLUMN "type"                  "VendorType"   NOT NULL DEFAULT 'STOCK',
  ADD COLUMN "paymentTermId"         TEXT,
  ADD COLUMN "defaultCurrency"       TEXT           DEFAULT 'USD',
  ADD COLUMN "minimumOrderAmount"    DECIMAL(18,5),
  ADD COLUMN "costChangeAlertPct"    DECIMAL(18,5),
  ADD COLUMN "notes"                 TEXT,
  ADD COLUMN "defaultCommissionRate" DECIMAL(18,5);

CREATE INDEX "Vendor_type_idx"             ON "Vendor"("type");
CREATE INDEX "Vendor_active_deletedAt_idx" ON "Vendor"("active", "deletedAt");

ALTER TABLE "Vendor"
  ADD CONSTRAINT "Vendor_paymentTermId_fkey"
    FOREIGN KEY ("paymentTermId") REFERENCES "PaymentTerm"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- 3. Vendor-scoped tables.
CREATE TABLE "VendorAddress" (
  "id"         TEXT NOT NULL,
  "vendorId"   TEXT NOT NULL,
  "kind"       "VendorAddressKind" NOT NULL,
  "isDefault"  BOOLEAN NOT NULL DEFAULT false,
  "label"      TEXT,
  "line1"      TEXT NOT NULL,
  "line2"      TEXT,
  "city"       TEXT NOT NULL,
  "region"     TEXT NOT NULL,
  "postalCode" TEXT NOT NULL,
  "country"    TEXT NOT NULL DEFAULT 'US',
  "attention"  TEXT,
  "phone"      TEXT,
  "deletedAt"  TIMESTAMP(3),
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"  TIMESTAMP(3) NOT NULL,
  CONSTRAINT "VendorAddress_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "VendorAddress_vendorId_kind_idx"      ON "VendorAddress"("vendorId","kind");
CREATE INDEX "VendorAddress_vendorId_isDefault_idx" ON "VendorAddress"("vendorId","isDefault");

CREATE TABLE "VendorContact" (
  "id"        TEXT NOT NULL,
  "vendorId"  TEXT NOT NULL,
  "name"      TEXT NOT NULL,
  "role"      TEXT,
  "email"     TEXT,
  "phone"     TEXT,
  "mobile"    TEXT,
  "isPrimary" BOOLEAN NOT NULL DEFAULT false,
  "deletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "VendorContact_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "VendorContact_vendorId_idx" ON "VendorContact"("vendorId");

CREATE TABLE "VendorProduct" (
  "id"         TEXT NOT NULL,
  "vendorId"   TEXT NOT NULL,
  "variantId"  TEXT NOT NULL,
  "vendorSku"  TEXT,
  "latestCost" DECIMAL(18,5),
  "packSize"   DECIMAL(18,5),
  "isPrimary"  BOOLEAN NOT NULL DEFAULT false,
  "active"     BOOLEAN NOT NULL DEFAULT true,
  "notes"      TEXT,
  "deletedAt"  TIMESTAMP(3),
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"  TIMESTAMP(3) NOT NULL,
  CONSTRAINT "VendorProduct_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "VendorProduct_vendorId_idx"  ON "VendorProduct"("vendorId");
CREATE INDEX "VendorProduct_variantId_idx" ON "VendorProduct"("variantId");
CREATE INDEX "VendorProduct_deletedAt_idx" ON "VendorProduct"("deletedAt");

-- 4. Foreign keys for vendor-scoped tables.
ALTER TABLE "VendorAddress"
  ADD CONSTRAINT "VendorAddress_vendorId_fkey"
    FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "VendorContact"
  ADD CONSTRAINT "VendorContact_vendorId_fkey"
    FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "VendorProduct"
  ADD CONSTRAINT "VendorProduct_vendorId_fkey"
    FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "VendorProduct_variantId_fkey"
    FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- 5. Partial unique indices guarding singleton invariants. Each
--    excludes soft-deleted rows so a new record can be set after
--    the previous one is soft-deleted.
--
--    vendoraddress_default_per_kind_idx — exactly one default per
--      (vendor, kind) among non-deleted rows.
--    vendorcontact_primary_idx — exactly one primary contact per
--      vendor among non-deleted rows.
--    vendorproduct_active_key — one catalog row per (vendor, variant)
--      among non-deleted rows; soft-deleted rows can be replaced.
--    vendorproduct_primary_idx — exactly one primary vendor per
--      variant among non-deleted rows.
CREATE UNIQUE INDEX "vendoraddress_default_per_kind_idx"
  ON "VendorAddress"("vendorId", "kind")
  WHERE "isDefault" = true AND "deletedAt" IS NULL;

CREATE UNIQUE INDEX "vendorcontact_primary_idx"
  ON "VendorContact"("vendorId")
  WHERE "isPrimary" = true AND "deletedAt" IS NULL;

CREATE UNIQUE INDEX "vendorproduct_active_key"
  ON "VendorProduct"("vendorId", "variantId")
  WHERE "deletedAt" IS NULL;

CREATE UNIQUE INDEX "vendorproduct_primary_idx"
  ON "VendorProduct"("variantId")
  WHERE "isPrimary" = true AND "deletedAt" IS NULL;
