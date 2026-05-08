-- =============================================================
-- add_fiscal_period_and_recon_check
-- Phase 9 slice A — period close foundation. Spec: docs/08-gl-
-- costing-reporting.md#period-close.
--
-- Adds:
--   * FiscalPeriodStatus enum (OPEN, SOFT_CLOSED, HARD_CLOSED)
--   * 4 AuditAction values (PERIOD_CLOSED, PERIOD_REOPENED,
--     MANUAL_JE_POSTED, RECONCILIATION_RUN)
--   * FiscalPeriod table — monthly periods, lazily auto-created on
--     first JE post (via getOrCreatePeriodForDate). Unique by `code`
--     ("YYYY-MM") to enforce one-row-per-month.
--   * PeriodReconciliationCheck table — append-only snapshots written
--     by the slice-D recon helper at close time and on demand. JSON
--     `details` carries per-checkType bucket data.
--
-- NOT included: any change to Vendor_paymentTermId_fkey's ON DELETE
-- behavior (the same pre-existing RESTRICT-vs-SET NULL drift carried
-- forward from prior slices). Deliberate behavior change deferred.
-- =============================================================

-- 1. Enum.
CREATE TYPE "FiscalPeriodStatus" AS ENUM ('OPEN', 'SOFT_CLOSED', 'HARD_CLOSED');

-- 2. AuditAction additions.
ALTER TYPE "AuditAction" ADD VALUE 'PERIOD_CLOSED';
ALTER TYPE "AuditAction" ADD VALUE 'PERIOD_REOPENED';
ALTER TYPE "AuditAction" ADD VALUE 'MANUAL_JE_POSTED';
ALTER TYPE "AuditAction" ADD VALUE 'RECONCILIATION_RUN';

-- 3. FiscalPeriod.
CREATE TABLE "FiscalPeriod" (
  "id"           TEXT NOT NULL,
  "code"         TEXT NOT NULL,
  "startDate"    TIMESTAMP(3)         NOT NULL,
  "endDate"      TIMESTAMP(3)         NOT NULL,
  "status"       "FiscalPeriodStatus" NOT NULL DEFAULT 'OPEN',
  "closedAt"     TIMESTAMP(3),
  "closedById"   TEXT,
  "reopenedAt"   TIMESTAMP(3),
  "reopenedById" TEXT,
  "reopenReason" TEXT,
  "notes"        TEXT,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL,
  CONSTRAINT "FiscalPeriod_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "FiscalPeriod_code_key"      ON "FiscalPeriod"("code");
CREATE INDEX        "FiscalPeriod_status_idx"    ON "FiscalPeriod"("status");
CREATE INDEX        "FiscalPeriod_startDate_idx" ON "FiscalPeriod"("startDate");

-- 4. PeriodReconciliationCheck.
CREATE TABLE "PeriodReconciliationCheck" (
  "id"               TEXT NOT NULL,
  "fiscalPeriodId"   TEXT NOT NULL,
  "checkType"        TEXT NOT NULL,
  "glBalance"        DECIMAL(18,5) NOT NULL,
  "subledgerBalance" DECIMAL(18,5) NOT NULL,
  "difference"       DECIMAL(18,5) NOT NULL,
  "passed"           BOOLEAN       NOT NULL,
  "details"          JSONB,
  "checkedAt"        TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PeriodReconciliationCheck_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PeriodReconciliationCheck_fiscalPeriodId_checkedAt_idx"
  ON "PeriodReconciliationCheck"("fiscalPeriodId","checkedAt");

ALTER TABLE "PeriodReconciliationCheck"
  ADD CONSTRAINT "PeriodReconciliationCheck_fiscalPeriodId_fkey"
    FOREIGN KEY ("fiscalPeriodId") REFERENCES "FiscalPeriod"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
