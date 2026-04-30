-- =============================================================
-- add_invoicing_ar_core
--
-- Tables for Invoicing & AR per docs/06-invoicing-ar.md:
-- Setting (generic admin key/value store), Invoice + InvoiceLine,
-- Payment, CreditMemoCategory + CreditMemo + CreditMemoLine, Rma +
-- RmaLine, CreditApplication. Three new AuditAction values for
-- domain-filterable audit reports.
--
-- Hand-written so we can include: (a) the two partial unique
-- indices on CreditApplication that Prisma can't express; (b)
-- seeded CreditMemoCategory rows the service layer depends on;
-- (c) a seeded Setting row for restocking_fee_default.
--
-- Seed rows use stable hardcoded IDs (not cuid) so cross-environment
-- references stay valid. Do not switch to cuid generation for seed
-- data — the IDs become part of the operational contract.
-- =============================================================

-- 1. Extend the AuditAction enum.
ALTER TYPE "AuditAction" ADD VALUE 'INVOICE_GENERATED';
ALTER TYPE "AuditAction" ADD VALUE 'PAYMENT_REVERSED';
ALTER TYPE "AuditAction" ADD VALUE 'RMA_STATUS_CHANGE';

-- 2. New enums.
CREATE TYPE "InvoiceStatus" AS ENUM ('OPEN', 'PARTIAL', 'PAID', 'VOIDED');
CREATE TYPE "PaymentMethod" AS ENUM ('CREDIT_CARD', 'ACH', 'WIRE', 'CHECK', 'CASH', 'MONEY_ORDER', 'APPLIED_CREDIT');
CREATE TYPE "PaymentStatus" AS ENUM ('RECORDED', 'REVERSED');
CREATE TYPE "CreditMemoStatus" AS ENUM ('DRAFT', 'CONFIRMED', 'VOIDED');
CREATE TYPE "RmaStatus" AS ENUM ('PENDING', 'APPROVED', 'IN_TRANSIT', 'RECEIVED', 'INSPECTED', 'CREDITED', 'REJECTED');
CREATE TYPE "CreditApplicationKind" AS ENUM ('PAYMENT_TO_INVOICE', 'CREDIT_TO_INVOICE');

-- 3. Tables.
CREATE TABLE "Setting" (
  "id" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "value" JSONB NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "updatedBy" TEXT,
  CONSTRAINT "Setting_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Invoice" (
  "id" TEXT NOT NULL,
  "number" TEXT NOT NULL,
  "salesOrderId" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "warehouseId" TEXT NOT NULL,
  "status" "InvoiceStatus" NOT NULL DEFAULT 'OPEN',
  "subtotal" DECIMAL(18,5) NOT NULL,
  "orderDiscount" DECIMAL(18,5) NOT NULL DEFAULT 0,
  "shippingAmount" DECIMAL(18,5) NOT NULL DEFAULT 0,
  "handlingAmount" DECIMAL(18,5) NOT NULL DEFAULT 0,
  "total" DECIMAL(18,5) NOT NULL,
  "amountPaid" DECIMAL(18,5) NOT NULL DEFAULT 0,
  "amountCredited" DECIMAL(18,5) NOT NULL DEFAULT 0,
  "currency" TEXT DEFAULT 'USD',
  "invoiceDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "customerNotes" TEXT,
  "internalNotes" TEXT,
  "storedPdfKey" TEXT,
  "emailedAt" TIMESTAMP(3),
  "voidedAt" TIMESTAMP(3),
  "voidReason" TEXT,
  "cogsPosted" BOOLEAN NOT NULL DEFAULT false,
  "deletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "InvoiceLine" (
  "id" TEXT NOT NULL,
  "invoiceId" TEXT NOT NULL,
  "salesOrderLineId" TEXT,
  "variantId" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "qty" DECIMAL(18,5) NOT NULL,
  "unitPrice" DECIMAL(18,5) NOT NULL,
  "discountPercent" DECIMAL(18,5),
  "discountAmount" DECIMAL(18,5),
  "lineTotal" DECIMAL(18,5) NOT NULL,
  "qtyReturned" DECIMAL(18,5) NOT NULL DEFAULT 0,
  "deletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "InvoiceLine_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Payment" (
  "id" TEXT NOT NULL,
  "number" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "method" "PaymentMethod" NOT NULL,
  "status" "PaymentStatus" NOT NULL DEFAULT 'RECORDED',
  "amount" DECIMAL(18,5) NOT NULL,
  "appliedAmount" DECIMAL(18,5) NOT NULL DEFAULT 0,
  "currency" TEXT DEFAULT 'USD',
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reference" TEXT,
  "notes" TEXT,
  "reversedAt" TIMESTAMP(3),
  "reversedReason" TEXT,
  "deletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CreditMemoCategory" (
  "id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "affectsInventory" BOOLEAN NOT NULL DEFAULT true,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "deletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CreditMemoCategory_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CreditMemo" (
  "id" TEXT NOT NULL,
  "number" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "invoiceId" TEXT,
  "status" "CreditMemoStatus" NOT NULL DEFAULT 'DRAFT',
  "categoryId" TEXT NOT NULL,
  "amount" DECIMAL(18,5) NOT NULL,
  "restockingFee" DECIMAL(18,5) NOT NULL DEFAULT 0,
  "netCredit" DECIMAL(18,5) NOT NULL,
  "appliedAmount" DECIMAL(18,5) NOT NULL DEFAULT 0,
  "currency" TEXT DEFAULT 'USD',
  "reason" TEXT,
  "issuedAt" TIMESTAMP(3),
  "voidedAt" TIMESTAMP(3),
  "voidReason" TEXT,
  "deletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CreditMemo_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CreditMemoLine" (
  "id" TEXT NOT NULL,
  "creditMemoId" TEXT NOT NULL,
  "invoiceLineId" TEXT,
  "variantId" TEXT NOT NULL,
  "qty" DECIMAL(18,5) NOT NULL,
  "unitPrice" DECIMAL(18,5) NOT NULL,
  "lineTotal" DECIMAL(18,5) NOT NULL,
  "description" TEXT NOT NULL,
  "deletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CreditMemoLine_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Rma" (
  "id" TEXT NOT NULL,
  "number" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "invoiceId" TEXT NOT NULL,
  "status" "RmaStatus" NOT NULL DEFAULT 'PENDING',
  "returnless" BOOLEAN NOT NULL DEFAULT false,
  "reason" TEXT,
  "restockingFeePercent" DECIMAL(18,5),
  "restockingFeeFlat" DECIMAL(18,5),
  "approvedAt" TIMESTAMP(3),
  "receivedAt" TIMESTAMP(3),
  "inspectedAt" TIMESTAMP(3),
  "creditedAt" TIMESTAMP(3),
  "rejectedAt" TIMESTAMP(3),
  "rejectedReason" TEXT,
  "creditMemoId" TEXT,
  "deletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Rma_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RmaLine" (
  "id" TEXT NOT NULL,
  "rmaId" TEXT NOT NULL,
  "invoiceLineId" TEXT NOT NULL,
  "qty" DECIMAL(18,5) NOT NULL,
  "reason" TEXT,
  "deletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RmaLine_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CreditApplication" (
  "id" TEXT NOT NULL,
  "kind" "CreditApplicationKind" NOT NULL,
  "paymentId" TEXT,
  "creditMemoId" TEXT,
  "invoiceId" TEXT NOT NULL,
  "amount" DECIMAL(18,5) NOT NULL,
  "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "appliedById" TEXT,
  "reversedAt" TIMESTAMP(3),
  "notes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CreditApplication_pkey" PRIMARY KEY ("id")
);

-- 4. Plain indices and unique constraints.
CREATE UNIQUE INDEX "Setting_key_key" ON "Setting"("key");
CREATE UNIQUE INDEX "Invoice_number_key" ON "Invoice"("number");
CREATE UNIQUE INDEX "Invoice_salesOrderId_key" ON "Invoice"("salesOrderId");
CREATE INDEX "Invoice_customerId_status_idx" ON "Invoice"("customerId", "status");
CREATE INDEX "Invoice_status_invoiceDate_idx" ON "Invoice"("status", "invoiceDate");
CREATE INDEX "Invoice_cogsPosted_idx" ON "Invoice"("cogsPosted");
CREATE INDEX "Invoice_deletedAt_idx" ON "Invoice"("deletedAt");
CREATE INDEX "InvoiceLine_invoiceId_idx" ON "InvoiceLine"("invoiceId");
CREATE INDEX "InvoiceLine_variantId_idx" ON "InvoiceLine"("variantId");
CREATE UNIQUE INDEX "Payment_number_key" ON "Payment"("number");
CREATE INDEX "Payment_customerId_receivedAt_idx" ON "Payment"("customerId", "receivedAt");
CREATE INDEX "Payment_status_receivedAt_idx" ON "Payment"("status", "receivedAt");
CREATE UNIQUE INDEX "CreditMemoCategory_code_key" ON "CreditMemoCategory"("code");
CREATE UNIQUE INDEX "CreditMemo_number_key" ON "CreditMemo"("number");
CREATE INDEX "CreditMemo_customerId_status_idx" ON "CreditMemo"("customerId", "status");
CREATE INDEX "CreditMemo_invoiceId_idx" ON "CreditMemo"("invoiceId");
CREATE INDEX "CreditMemoLine_creditMemoId_idx" ON "CreditMemoLine"("creditMemoId");
CREATE UNIQUE INDEX "Rma_number_key" ON "Rma"("number");
CREATE UNIQUE INDEX "Rma_creditMemoId_key" ON "Rma"("creditMemoId");
CREATE INDEX "Rma_customerId_status_idx" ON "Rma"("customerId", "status");
CREATE INDEX "Rma_status_idx" ON "Rma"("status");
CREATE INDEX "RmaLine_rmaId_idx" ON "RmaLine"("rmaId");
CREATE INDEX "CreditApplication_invoiceId_reversedAt_idx" ON "CreditApplication"("invoiceId", "reversedAt");
CREATE INDEX "CreditApplication_paymentId_idx" ON "CreditApplication"("paymentId");
CREATE INDEX "CreditApplication_creditMemoId_idx" ON "CreditApplication"("creditMemoId");

-- 5. Foreign keys.
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_salesOrderId_fkey"
  FOREIGN KEY ("salesOrderId") REFERENCES "SalesOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_customerId_fkey"
  FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_warehouseId_fkey"
  FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_invoiceId_fkey"
  FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_variantId_fkey"
  FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_customerId_fkey"
  FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CreditMemo" ADD CONSTRAINT "CreditMemo_customerId_fkey"
  FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CreditMemo" ADD CONSTRAINT "CreditMemo_invoiceId_fkey"
  FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CreditMemo" ADD CONSTRAINT "CreditMemo_categoryId_fkey"
  FOREIGN KEY ("categoryId") REFERENCES "CreditMemoCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CreditMemoLine" ADD CONSTRAINT "CreditMemoLine_creditMemoId_fkey"
  FOREIGN KEY ("creditMemoId") REFERENCES "CreditMemo"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CreditMemoLine" ADD CONSTRAINT "CreditMemoLine_invoiceLineId_fkey"
  FOREIGN KEY ("invoiceLineId") REFERENCES "InvoiceLine"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CreditMemoLine" ADD CONSTRAINT "CreditMemoLine_variantId_fkey"
  FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Rma" ADD CONSTRAINT "Rma_customerId_fkey"
  FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Rma" ADD CONSTRAINT "Rma_invoiceId_fkey"
  FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Rma" ADD CONSTRAINT "Rma_creditMemoId_fkey"
  FOREIGN KEY ("creditMemoId") REFERENCES "CreditMemo"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RmaLine" ADD CONSTRAINT "RmaLine_rmaId_fkey"
  FOREIGN KEY ("rmaId") REFERENCES "Rma"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RmaLine" ADD CONSTRAINT "RmaLine_invoiceLineId_fkey"
  FOREIGN KEY ("invoiceLineId") REFERENCES "InvoiceLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CreditApplication" ADD CONSTRAINT "CreditApplication_paymentId_fkey"
  FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CreditApplication" ADD CONSTRAINT "CreditApplication_creditMemoId_fkey"
  FOREIGN KEY ("creditMemoId") REFERENCES "CreditMemo"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CreditApplication" ADD CONSTRAINT "CreditApplication_invoiceId_fkey"
  FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 6. Two partial unique indices preventing multi-application of the
--    same payment / credit memo to the same invoice while live.
--    Defense-in-depth — service layer enforces the same invariant.
--    Same pattern as customer addresses / contacts / payment methods.
CREATE UNIQUE INDEX "creditapp_payment_invoice_active_idx"
  ON "CreditApplication" ("paymentId", "invoiceId")
  WHERE "paymentId" IS NOT NULL AND "reversedAt" IS NULL;

CREATE UNIQUE INDEX "creditapp_creditmemo_invoice_active_idx"
  ON "CreditApplication" ("creditMemoId", "invoiceId")
  WHERE "creditMemoId" IS NOT NULL AND "reversedAt" IS NULL;

-- 7. Seed rows. Stable hardcoded IDs (not cuid) so cross-environment
--    references stay valid. Do not switch to cuid generation for
--    seed data — the IDs become part of the operational contract.
--    affectsInventory defaults: only RETURN restocks.
INSERT INTO "CreditMemoCategory" ("id", "code", "label", "affectsInventory", "updatedAt") VALUES
  ('seed_cmc_return',    'RETURN',          'Return',                  true,  NOW()),
  ('seed_cmc_damaged',   'DAMAGED',         'Damaged',                 false, NOW()),
  ('seed_cmc_pricing',   'PRICING_DISPUTE', 'Pricing Dispute',         false, NOW()),
  ('seed_cmc_goodwill',  'GOODWILL',        'Goodwill',                false, NOW()),
  ('seed_cmc_cancelled', 'CANCELLED',       'Cancelled After Invoice', false, NOW()),
  ('seed_cmc_baddebt',   'BAD_DEBT',        'Bad Debt Write-Off',      false, NOW())
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "Setting" ("id", "key", "value", "updatedAt") VALUES
  ('seed_set_rstkfee', 'restocking_fee_default', '{"percent": null, "flat": null}'::jsonb, NOW())
ON CONFLICT ("key") DO NOTHING;
