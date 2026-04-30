-- =============================================================
-- expand_customer_master
-- Replaces the Customer stub with the full master. Hand-written
-- because Prisma can't express CREATE EXTENSION, the staged backfill
-- of NOT NULL FK columns, or partial unique indices with WHERE
-- "deletedAt" IS NULL.
-- =============================================================

-- 1. Citext extension (idempotent).
CREATE EXTENSION IF NOT EXISTS citext;

-- 2. New enums.
CREATE TYPE "CustomerType" AS ENUM (
  'WHOLESALE_REGULAR', 'WHOLESALE_PREFERRED', 'WHOLESALE_DISTRIBUTOR',
  'WHOLESALE_MASTER_DISTRIBUTOR', 'RETAIL'
);
CREATE TYPE "CustomerActivityKind" AS ENUM ('AUTO', 'MANUAL');
CREATE TYPE "CustomerDocumentKind" AS ENUM (
  'RESALE_PERMIT', 'BUSINESS_LICENSE', 'RESALE_CERT',
  'EIN', 'DRIVERS_LICENSE', 'SSN', 'OTHER'
);
CREATE TYPE "CommissionBasis" AS ENUM ('REVENUE', 'MARGIN');
CREATE TYPE "AddressKind" AS ENUM ('BILLING', 'SHIPPING');

-- 3. Extend AuditAction with SENSITIVE_READ.
ALTER TYPE "AuditAction" ADD VALUE 'SENSITIVE_READ';

-- 4. Lookup tables (must exist before Customer FK columns are filled).
CREATE TABLE "PaymentTerm" (
  "id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "netDays" INTEGER,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "deletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PaymentTerm_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PaymentTerm_code_key" ON "PaymentTerm"("code");

CREATE TABLE "SalesRep" (
  "id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "email" TEXT,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "userId" TEXT,
  "commissionBasis" "CommissionBasis",
  "commissionPercent" DECIMAL(18,5),
  "groupId" TEXT,
  "deletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SalesRep_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SalesRep_code_key" ON "SalesRep"("code");
CREATE INDEX "SalesRep_userId_idx" ON "SalesRep"("userId");

CREATE TABLE "CustomerCategory" (
  "id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "deletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CustomerCategory_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CustomerCategory_code_key" ON "CustomerCategory"("code");

CREATE TABLE "CustomerTag" (
  "id" TEXT NOT NULL,
  "label" CITEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CustomerTag_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CustomerTag_label_key" ON "CustomerTag"("label");

-- 5. Seed default PaymentTerm rows + UNASSIGNED SalesRep, idempotent.
--    Backfill in step 7 depends on these rows existing.
INSERT INTO "PaymentTerm" ("id", "code", "label", "netDays", "updatedAt") VALUES
  ('seed_pt_net30',     'NET30',     'Net 30',              30,   NOW()),
  ('seed_pt_cod',       'COD',       'COD',                 NULL, NOW()),
  ('seed_pt_prepay',    'PREPAY',    'Prepay',              NULL, NOW()),
  ('seed_pt_dep50',     'DEP50',     '50% Deposit',         NULL, NOW()),
  ('seed_pt_payship',   'PAYSHIP',   'Pay on Shipping',     NULL, NOW()),
  ('seed_pt_billnet30', 'BILLNET30', 'Bill later (Net 30)', 30,   NOW())
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "SalesRep" ("id", "code", "name", "updatedAt") VALUES
  ('seed_sr_unassigned', 'UNASSIGNED', 'Unassigned', NOW())
ON CONFLICT ("code") DO NOTHING;

-- 6. Convert Customer.name to CITEXT and add the new columns as
--    nullable / defaulted so existing rows survive.
ALTER TABLE "Customer" ALTER COLUMN "name" TYPE CITEXT;
ALTER TABLE "Customer"
  ADD COLUMN "type"              "CustomerType" NOT NULL DEFAULT 'WHOLESALE_REGULAR',
  ADD COLUMN "salesRepId"        TEXT,
  ADD COLUMN "paymentTermId"     TEXT,
  ADD COLUMN "creditLimit"       DECIMAL(18,5),
  ADD COLUMN "arHoldDays"        INTEGER,
  ADD COLUMN "taxExempt"         BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "resaleCertNumber"  TEXT,
  ADD COLUMN "primaryPhone"      TEXT,
  ADD COLUMN "primaryEmail"      TEXT,
  ADD COLUMN "internalNotes"     TEXT,
  ADD COLUMN "shopifyCustomerId" TEXT,
  ADD COLUMN "costPlusPercent"   DECIMAL(18,5);

-- 7. Backfill existing customers to UNASSIGNED rep + NET30 term.
UPDATE "Customer"
   SET "salesRepId"    = (SELECT "id" FROM "SalesRep"    WHERE "code"='UNASSIGNED'),
       "paymentTermId" = (SELECT "id" FROM "PaymentTerm" WHERE "code"='NET30')
 WHERE "salesRepId" IS NULL OR "paymentTermId" IS NULL;

-- 8. Now safe to flip the FK columns to NOT NULL.
ALTER TABLE "Customer" ALTER COLUMN "salesRepId"    SET NOT NULL;
ALTER TABLE "Customer" ALTER COLUMN "paymentTermId" SET NOT NULL;

-- 9. Customer indices + display-name uniqueness (case-insensitive via CITEXT).
CREATE UNIQUE INDEX "Customer_name_key"           ON "Customer"("name");
CREATE INDEX "Customer_type_idx"                  ON "Customer"("type");
CREATE INDEX "Customer_salesRepId_idx"            ON "Customer"("salesRepId");
CREATE INDEX "Customer_active_deletedAt_idx"      ON "Customer"("active", "deletedAt");
CREATE INDEX "Customer_shopifyCustomerId_idx"     ON "Customer"("shopifyCustomerId");

-- 10. Customer FKs.
ALTER TABLE "Customer"
  ADD CONSTRAINT "Customer_salesRepId_fkey"
    FOREIGN KEY ("salesRepId") REFERENCES "SalesRep"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "Customer_paymentTermId_fkey"
    FOREIGN KEY ("paymentTermId") REFERENCES "PaymentTerm"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- 11. Remaining customer-scoped tables.
CREATE TABLE "CustomerAddress" (
  "id" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "kind" "AddressKind" NOT NULL,
  "isDefault" BOOLEAN NOT NULL DEFAULT false,
  "label" TEXT,
  "line1" TEXT NOT NULL,
  "line2" TEXT,
  "city" TEXT NOT NULL,
  "region" TEXT NOT NULL,
  "postalCode" TEXT NOT NULL,
  "country" TEXT NOT NULL DEFAULT 'US',
  "attention" TEXT,
  "phone" TEXT,
  "deletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CustomerAddress_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "CustomerAddress_customerId_kind_idx"      ON "CustomerAddress"("customerId","kind");
CREATE INDEX "CustomerAddress_customerId_isDefault_idx" ON "CustomerAddress"("customerId","isDefault");

CREATE TABLE "CustomerContact" (
  "id" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "role" TEXT,
  "email" TEXT,
  "phone" TEXT,
  "mobile" TEXT,
  "isPrimary" BOOLEAN NOT NULL DEFAULT false,
  "deletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CustomerContact_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "CustomerContact_customerId_idx" ON "CustomerContact"("customerId");

CREATE TABLE "CustomerPriceOverride" (
  "id" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "variantId" TEXT NOT NULL,
  "unitPrice" DECIMAL(18,5) NOT NULL,
  "currency" TEXT DEFAULT 'USD',
  "notes" TEXT,
  "deletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CustomerPriceOverride_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CustomerPriceOverride_customerId_variantId_key"
  ON "CustomerPriceOverride"("customerId","variantId");
CREATE INDEX "CustomerPriceOverride_variantId_idx"  ON "CustomerPriceOverride"("variantId");
CREATE INDEX "CustomerPriceOverride_deletedAt_idx"  ON "CustomerPriceOverride"("deletedAt");

CREATE TABLE "CustomerPaymentMethod" (
  "id" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "authorizeNetCustomerProfileId" TEXT NOT NULL,
  "authorizeNetPaymentProfileId" TEXT NOT NULL,
  "brand" TEXT,
  "last4" TEXT,
  "expirationMonth" INTEGER,
  "expirationYear" INTEGER,
  "isPreferred" BOOLEAN NOT NULL DEFAULT false,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "deletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CustomerPaymentMethod_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CustomerPaymentMethod_authorizeNetPaymentProfileId_key"
  ON "CustomerPaymentMethod"("authorizeNetPaymentProfileId");
CREATE INDEX "CustomerPaymentMethod_customerId_isPreferred_idx"
  ON "CustomerPaymentMethod"("customerId","isPreferred");
CREATE INDEX "CustomerPaymentMethod_expirationYear_expirationMonth_idx"
  ON "CustomerPaymentMethod"("expirationYear","expirationMonth");

CREATE TABLE "CustomerDocument" (
  "id" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "kind" "CustomerDocumentKind" NOT NULL,
  "encryptedValue" TEXT,
  "encryptedValueIv" TEXT,
  "storageKey" TEXT,
  "fileName" TEXT,
  "contentType" TEXT,
  "expiresOn" TIMESTAMP(3),
  "notes" TEXT,
  "deletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CustomerDocument_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "CustomerDocument_customerId_kind_idx" ON "CustomerDocument"("customerId","kind");
CREATE INDEX "CustomerDocument_expiresOn_idx"       ON "CustomerDocument"("expiresOn");

CREATE TABLE "CustomerActivity" (
  "id" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "kind" "CustomerActivityKind" NOT NULL,
  "summary" TEXT NOT NULL,
  "detailJson" JSONB,
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CustomerActivity_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "CustomerActivity_customerId_createdAt_idx"
  ON "CustomerActivity"("customerId","createdAt");

CREATE TABLE "CustomerCategoryAssignment" (
  "customerId" TEXT NOT NULL,
  "categoryId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CustomerCategoryAssignment_pkey" PRIMARY KEY ("customerId","categoryId")
);
CREATE INDEX "CustomerCategoryAssignment_categoryId_idx"
  ON "CustomerCategoryAssignment"("categoryId");

CREATE TABLE "CustomerTagAssignment" (
  "customerId" TEXT NOT NULL,
  "tagId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CustomerTagAssignment_pkey" PRIMARY KEY ("customerId","tagId")
);
CREATE INDEX "CustomerTagAssignment_tagId_idx" ON "CustomerTagAssignment"("tagId");

-- 12. Foreign keys for the customer-scoped tables.
ALTER TABLE "CustomerAddress"
  ADD CONSTRAINT "CustomerAddress_customerId_fkey"
    FOREIGN KEY ("customerId") REFERENCES "Customer"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CustomerContact"
  ADD CONSTRAINT "CustomerContact_customerId_fkey"
    FOREIGN KEY ("customerId") REFERENCES "Customer"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CustomerPriceOverride"
  ADD CONSTRAINT "CustomerPriceOverride_customerId_fkey"
    FOREIGN KEY ("customerId") REFERENCES "Customer"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "CustomerPriceOverride_variantId_fkey"
    FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CustomerPaymentMethod"
  ADD CONSTRAINT "CustomerPaymentMethod_customerId_fkey"
    FOREIGN KEY ("customerId") REFERENCES "Customer"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CustomerDocument"
  ADD CONSTRAINT "CustomerDocument_customerId_fkey"
    FOREIGN KEY ("customerId") REFERENCES "Customer"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CustomerActivity"
  ADD CONSTRAINT "CustomerActivity_customerId_fkey"
    FOREIGN KEY ("customerId") REFERENCES "Customer"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CustomerCategoryAssignment"
  ADD CONSTRAINT "CustomerCategoryAssignment_customerId_fkey"
    FOREIGN KEY ("customerId") REFERENCES "Customer"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "CustomerCategoryAssignment_categoryId_fkey"
    FOREIGN KEY ("categoryId") REFERENCES "CustomerCategory"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CustomerTagAssignment"
  ADD CONSTRAINT "CustomerTagAssignment_customerId_fkey"
    FOREIGN KEY ("customerId") REFERENCES "Customer"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "CustomerTagAssignment_tagId_fkey"
    FOREIGN KEY ("tagId") REFERENCES "CustomerTag"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- 13. Three partial unique indices guarding the singleton invariants
--     (one default per (customer, kind), one primary contact, one preferred
--     payment method). Each excludes soft-deleted rows so a new record can
--     be set after the previous one is soft-deleted.
CREATE UNIQUE INDEX "customeraddress_default_per_kind_idx"
  ON "CustomerAddress" ("customerId", "kind")
  WHERE "isDefault" = true AND "deletedAt" IS NULL;

CREATE UNIQUE INDEX "customercontact_primary_idx"
  ON "CustomerContact" ("customerId")
  WHERE "isPrimary" = true AND "deletedAt" IS NULL;

CREATE UNIQUE INDEX "customerpaymentmethod_preferred_idx"
  ON "CustomerPaymentMethod" ("customerId")
  WHERE "isPreferred" = true AND "deletedAt" IS NULL;
