-- =============================================================
-- add_bills_ap_schema
-- Phase 8 slice A — Bills / AP schema + GL chart-of-accounts
-- additions. Spec: docs/07-accounts-payable.md.
--
-- Adds:
--   * 4 enums (BillStatus, BillPaymentStatus, VendorCreditStatus, BillSource)
--   * 6 AuditAction values for AP-side filterable actions
--   * 8 tables (Bill + 2 join tables + BillLine + BillPayment +
--             VendorCredit + VendorCreditLine + VendorCreditApplication)
--   * Partial unique index on VendorCreditApplication
--     (vendorCreditId, billId) WHERE reversedAt IS NULL — mirrors the
--     CreditApplication index from add_invoicing_ar_core. Prisma can't
--     express partial indices.
--   * CHECK constraint enforcing BillLine source XOR (variantId-bearing
--     OR expenseAccountId-bearing, never both, never neither).
--   * GL account seeds:
--       2010 Accounts Payable          (LIABILITY) — credited on bill confirm
--       2030 Vendor Credits Available  (LIABILITY) — DR/CR on VC confirm + apply
--       5500 Office Expense            (EXPENSE)
--       5510 Utilities                 (EXPENSE)
--       5520 Rent                      (EXPENSE)
--       5530 Professional Services     (EXPENSE)
--       5540 Travel                    (EXPENSE)
--       5550 Shipping Expense          (EXPENSE)
--     Stable hardcoded ids (seed_gl_*) match the convention from
--     add_gl_stub + add_accrued_receipts_and_adjustment_expense_seeds.
--     Admin can add more expense accounts at runtime; these are the
--     pilot starter set.
--
-- NOT included: any change to Vendor_paymentTermId_fkey's ON DELETE
-- behavior. Prisma's auto-diff wanted to swap RESTRICT → SET NULL
-- because nullable-FK default differs from the original hand-written
-- constraint in add_vendor_master. That's an unrelated existing-state
-- quirk, not a Bills/AP concern; deliberate behavior change deferred.
-- =============================================================

-- 1. New enums.
CREATE TYPE "BillStatus"         AS ENUM ('DRAFT', 'CONFIRMED', 'CANCELLED');
CREATE TYPE "BillPaymentStatus"  AS ENUM ('UNPAID', 'PARTIAL', 'PAID');
CREATE TYPE "VendorCreditStatus" AS ENUM ('DRAFT', 'CONFIRMED', 'CANCELLED');
CREATE TYPE "BillSource"         AS ENUM ('PRODUCT', 'EXPENSE');

-- 2. AuditAction additions. Postgres 12+ supports multi-VALUE adds in
--    one transaction; the dev/prod environment is on PG 14+.
ALTER TYPE "AuditAction" ADD VALUE 'DRAFT_BILL_GENERATED';
ALTER TYPE "AuditAction" ADD VALUE 'BILL_CONFIRMED';
ALTER TYPE "AuditAction" ADD VALUE 'BILL_PAYMENT_RECORDED';
ALTER TYPE "AuditAction" ADD VALUE 'BILL_PAYMENT_REVERSED';
ALTER TYPE "AuditAction" ADD VALUE 'VENDOR_CREDIT_CONFIRMED';
ALTER TYPE "AuditAction" ADD VALUE 'VENDOR_CREDIT_APPLIED';

-- 3. Bill core.
CREATE TABLE "Bill" (
  "id"              TEXT NOT NULL,
  "number"          TEXT NOT NULL,
  "vendorId"        TEXT NOT NULL,
  "vendorReference" TEXT,
  "source"          "BillSource"        NOT NULL DEFAULT 'PRODUCT',
  "status"          "BillStatus"        NOT NULL DEFAULT 'DRAFT',
  "paymentStatus"   "BillPaymentStatus" NOT NULL DEFAULT 'UNPAID',
  "billDate"        TIMESTAMP(3)        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "dueDate"         TIMESTAMP(3),
  "subtotal"        DECIMAL(18,5)       NOT NULL,
  "freight"         DECIMAL(18,5)       NOT NULL DEFAULT 0,
  "tax"             DECIMAL(18,5)       NOT NULL DEFAULT 0,
  "total"           DECIMAL(18,5)       NOT NULL,
  "amountPaid"      DECIMAL(18,5)       NOT NULL DEFAULT 0,
  "amountCredited"  DECIMAL(18,5)       NOT NULL DEFAULT 0,
  "currency"        TEXT DEFAULT 'USD',
  "notes"           TEXT,
  "createdById"     TEXT,
  "confirmedAt"     TIMESTAMP(3),
  "cancelledAt"     TIMESTAMP(3),
  "cancelReason"    TEXT,
  "deletedAt"       TIMESTAMP(3),
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Bill_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Bill_number_key"           ON "Bill"("number");
CREATE INDEX        "Bill_vendorId_status_idx"  ON "Bill"("vendorId","status");
CREATE INDEX        "Bill_status_billDate_idx"  ON "Bill"("status","billDate");
CREATE INDEX        "Bill_paymentStatus_idx"    ON "Bill"("paymentStatus");
CREATE INDEX        "Bill_deletedAt_idx"        ON "Bill"("deletedAt");

-- 4. M:N join tables (PO ↔ Bill, Receipt ↔ Bill).
CREATE TABLE "BillReceipt" (
  "billId"    TEXT NOT NULL,
  "receiptId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BillReceipt_pkey" PRIMARY KEY ("billId","receiptId")
);
CREATE INDEX "BillReceipt_receiptId_idx" ON "BillReceipt"("receiptId");

CREATE TABLE "BillPurchaseOrder" (
  "billId"          TEXT NOT NULL,
  "purchaseOrderId" TEXT NOT NULL,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BillPurchaseOrder_pkey" PRIMARY KEY ("billId","purchaseOrderId")
);
CREATE INDEX "BillPurchaseOrder_purchaseOrderId_idx" ON "BillPurchaseOrder"("purchaseOrderId");

-- 5. BillLine. Nullable variantId/receiptLineId/expenseAccountId
--    discriminated by parent Bill.source. CHECK constraint enforces
--    XOR at the DB level so a bug in the service can't write an
--    invalid line.
CREATE TABLE "BillLine" (
  "id"               TEXT NOT NULL,
  "billId"           TEXT NOT NULL,
  "lineNumber"       INTEGER NOT NULL,
  "variantId"        TEXT,
  "receiptLineId"    TEXT,
  "expenseAccountId" TEXT,
  "description"      TEXT NOT NULL,
  "qty"              DECIMAL(18,5) NOT NULL,
  "unitCost"         DECIMAL(18,5) NOT NULL,
  "lineTotal"        DECIMAL(18,5) NOT NULL,
  "notes"            TEXT,
  "deletedAt"        TIMESTAMP(3),
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BillLine_pkey" PRIMARY KEY ("id"),
  -- XOR: exactly one of (variantId, expenseAccountId) is set.
  -- receiptLineId is optional traceability for PRODUCT lines, not part
  -- of the discriminator.
  CONSTRAINT "BillLine_source_xor"
    CHECK (
      (("variantId" IS NOT NULL)::int + ("expenseAccountId" IS NOT NULL)::int) = 1
    )
);
CREATE INDEX "BillLine_billId_idx"           ON "BillLine"("billId");
CREATE INDEX "BillLine_variantId_idx"        ON "BillLine"("variantId");
CREATE INDEX "BillLine_receiptLineId_idx"    ON "BillLine"("receiptLineId");
CREATE INDEX "BillLine_expenseAccountId_idx" ON "BillLine"("expenseAccountId");

-- 6. BillPayment. Reuses PaymentMethod + PaymentStatus enums.
CREATE TABLE "BillPayment" (
  "id"             TEXT NOT NULL,
  "number"         TEXT NOT NULL,
  "billId"         TEXT NOT NULL,
  "vendorId"       TEXT NOT NULL,
  "paymentDate"    TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "amount"         DECIMAL(18,5)   NOT NULL,
  "method"         "PaymentMethod" NOT NULL,
  "cashAccountId"  TEXT,
  "reference"      TEXT,
  "notes"          TEXT,
  "status"         "PaymentStatus" NOT NULL DEFAULT 'RECORDED',
  "reversedAt"     TIMESTAMP(3),
  "reversedReason" TEXT,
  "createdById"    TEXT,
  "deletedAt"      TIMESTAMP(3),
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BillPayment_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "BillPayment_number_key"               ON "BillPayment"("number");
CREATE INDEX        "BillPayment_billId_status_idx"        ON "BillPayment"("billId","status");
CREATE INDEX        "BillPayment_vendorId_paymentDate_idx" ON "BillPayment"("vendorId","paymentDate");
CREATE INDEX        "BillPayment_status_paymentDate_idx"   ON "BillPayment"("status","paymentDate");

-- 7. VendorCredit + lines.
CREATE TABLE "VendorCredit" (
  "id"            TEXT NOT NULL,
  "number"        TEXT NOT NULL,
  "vendorId"      TEXT NOT NULL,
  "status"        "VendorCreditStatus" NOT NULL DEFAULT 'DRAFT',
  "creditDate"    TIMESTAMP(3)         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "amount"        DECIMAL(18,5)        NOT NULL,
  "appliedAmount" DECIMAL(18,5)        NOT NULL DEFAULT 0,
  "currency"      TEXT DEFAULT 'USD',
  "reason"        TEXT,
  "notes"         TEXT,
  "createdById"   TEXT,
  "confirmedAt"   TIMESTAMP(3),
  "cancelledAt"   TIMESTAMP(3),
  "cancelReason"  TEXT,
  "sourceTag"     TEXT,
  "deletedAt"     TIMESTAMP(3),
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL,
  CONSTRAINT "VendorCredit_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "VendorCredit_number_key"          ON "VendorCredit"("number");
CREATE INDEX        "VendorCredit_vendorId_status_idx" ON "VendorCredit"("vendorId","status");
CREATE INDEX        "VendorCredit_sourceTag_idx"       ON "VendorCredit"("sourceTag");
CREATE INDEX        "VendorCredit_deletedAt_idx"       ON "VendorCredit"("deletedAt");

CREATE TABLE "VendorCreditLine" (
  "id"             TEXT NOT NULL,
  "vendorCreditId" TEXT NOT NULL,
  "lineNumber"     INTEGER NOT NULL,
  "description"    TEXT NOT NULL,
  "amount"         DECIMAL(18,5) NOT NULL,
  "notes"          TEXT,
  "deletedAt"      TIMESTAMP(3),
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "VendorCreditLine_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "VendorCreditLine_vendorCreditId_idx" ON "VendorCreditLine"("vendorCreditId");

-- 8. VendorCreditApplication + partial unique index.
CREATE TABLE "VendorCreditApplication" (
  "id"             TEXT NOT NULL,
  "vendorCreditId" TEXT NOT NULL,
  "billId"         TEXT NOT NULL,
  "amount"         DECIMAL(18,5) NOT NULL,
  "appliedAt"      TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "appliedById"    TEXT,
  "reversedAt"     TIMESTAMP(3),
  "notes"          TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "VendorCreditApplication_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "VendorCreditApplication_billId_reversedAt_idx" ON "VendorCreditApplication"("billId","reversedAt");
CREATE INDEX "VendorCreditApplication_vendorCreditId_idx"    ON "VendorCreditApplication"("vendorCreditId");
-- Live applications: prevent multi-applying the same VC to the same
-- bill while non-reversed. Mirrors creditapplication_payment_live_idx
-- pattern from add_invoicing_ar_core.
CREATE UNIQUE INDEX "vendorcreditapplication_live_idx"
  ON "VendorCreditApplication"("vendorCreditId","billId")
  WHERE "reversedAt" IS NULL;

-- 9. Foreign keys. ON DELETE RESTRICT for parent tables (Bill, Vendor,
--    PurchaseOrder, Receipt) — soft-delete is the only delete path.
--    SET NULL for the optional discriminator FKs (variantId, receiptLineId,
--    expenseAccountId, cashAccountId) — matches Prisma's default for
--    nullable FKs and is harmless given we don't hard-delete.
ALTER TABLE "Bill"
  ADD CONSTRAINT "Bill_vendorId_fkey"
    FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "BillReceipt"
  ADD CONSTRAINT "BillReceipt_billId_fkey"
    FOREIGN KEY ("billId") REFERENCES "Bill"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "BillReceipt_receiptId_fkey"
    FOREIGN KEY ("receiptId") REFERENCES "Receipt"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "BillPurchaseOrder"
  ADD CONSTRAINT "BillPurchaseOrder_billId_fkey"
    FOREIGN KEY ("billId") REFERENCES "Bill"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "BillPurchaseOrder_purchaseOrderId_fkey"
    FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "BillLine"
  ADD CONSTRAINT "BillLine_billId_fkey"
    FOREIGN KEY ("billId") REFERENCES "Bill"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "BillLine_variantId_fkey"
    FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "BillLine_receiptLineId_fkey"
    FOREIGN KEY ("receiptLineId") REFERENCES "ReceiptLine"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "BillLine_expenseAccountId_fkey"
    FOREIGN KEY ("expenseAccountId") REFERENCES "GlAccount"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "BillPayment"
  ADD CONSTRAINT "BillPayment_billId_fkey"
    FOREIGN KEY ("billId") REFERENCES "Bill"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "BillPayment_vendorId_fkey"
    FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "BillPayment_cashAccountId_fkey"
    FOREIGN KEY ("cashAccountId") REFERENCES "GlAccount"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "VendorCredit"
  ADD CONSTRAINT "VendorCredit_vendorId_fkey"
    FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "VendorCreditLine"
  ADD CONSTRAINT "VendorCreditLine_vendorCreditId_fkey"
    FOREIGN KEY ("vendorCreditId") REFERENCES "VendorCredit"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "VendorCreditApplication"
  ADD CONSTRAINT "VendorCreditApplication_vendorCreditId_fkey"
    FOREIGN KEY ("vendorCreditId") REFERENCES "VendorCredit"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "VendorCreditApplication_billId_fkey"
    FOREIGN KEY ("billId") REFERENCES "Bill"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- 10. GL chart-of-accounts seeds.
--     Stable hardcoded ids (seed_gl_NNNN) match the convention from
--     add_gl_stub. ON CONFLICT DO NOTHING per the established
--     idempotency pattern (re-running migration = no-op).
INSERT INTO "GlAccount" ("id", "code", "name", "type", "updatedAt") VALUES
  ('seed_gl_2010', '2010', 'Accounts Payable',          'LIABILITY'::"AccountType", NOW()),
  ('seed_gl_2030', '2030', 'Vendor Credits Available',  'LIABILITY'::"AccountType", NOW()),
  ('seed_gl_5500', '5500', 'Office Expense',            'EXPENSE'::"AccountType",   NOW()),
  ('seed_gl_5510', '5510', 'Utilities',                 'EXPENSE'::"AccountType",   NOW()),
  ('seed_gl_5520', '5520', 'Rent',                      'EXPENSE'::"AccountType",   NOW()),
  ('seed_gl_5530', '5530', 'Professional Services',     'EXPENSE'::"AccountType",   NOW()),
  ('seed_gl_5540', '5540', 'Travel',                    'EXPENSE'::"AccountType",   NOW()),
  ('seed_gl_5550', '5550', 'Shipping Expense',          'EXPENSE'::"AccountType",   NOW())
ON CONFLICT ("code") DO NOTHING;
