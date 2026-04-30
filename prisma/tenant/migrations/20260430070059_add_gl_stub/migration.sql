-- =============================================================
-- add_gl_stub
--
-- Minimum GL shapes the Invoicing & AR slice's auto-JE posts need:
-- AccountType enum, GlAccount, JournalEntry, JournalEntryLine. Plus
-- 9 seeded GlAccount rows the post() helper looks up by code.
--
-- Full Chart of Accounts module (hierarchy / parent accounts / period
-- close / multi-warehouse inventory accounts / manual JEs / admin
-- reversal with closed-period gating) ships in its own slice (Module
-- 7, docs/08-gl-costing-reporting.md).
--
-- Seed rows use stable hardcoded IDs (not cuid) so cross-environment
-- references stay valid. Do not switch to cuid generation for seed
-- data — the IDs become part of the operational contract.
-- =============================================================

CREATE TYPE "AccountType" AS ENUM ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE');

CREATE TABLE "GlAccount" (
  "id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "type" "AccountType" NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "deletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "GlAccount_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "JournalEntry" (
  "id" TEXT NOT NULL,
  "number" TEXT NOT NULL,
  "entityType" TEXT NOT NULL,
  "entityId" TEXT NOT NULL,
  "postedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "description" TEXT NOT NULL,
  "reversedAt" TIMESTAMP(3),
  "reversedBy" TEXT,
  "deletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "JournalEntry_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "JournalEntryLine" (
  "id" TEXT NOT NULL,
  "journalEntryId" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "debit" DECIMAL(18,5) NOT NULL DEFAULT 0,
  "credit" DECIMAL(18,5) NOT NULL DEFAULT 0,
  "memo" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "JournalEntryLine_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GlAccount_code_key" ON "GlAccount"("code");
CREATE INDEX "GlAccount_type_idx" ON "GlAccount"("type");
CREATE UNIQUE INDEX "JournalEntry_number_key" ON "JournalEntry"("number");
CREATE INDEX "JournalEntry_entityType_entityId_idx" ON "JournalEntry"("entityType", "entityId");
CREATE INDEX "JournalEntry_postedAt_idx" ON "JournalEntry"("postedAt");
CREATE INDEX "JournalEntryLine_journalEntryId_idx" ON "JournalEntryLine"("journalEntryId");
CREATE INDEX "JournalEntryLine_accountId_idx" ON "JournalEntryLine"("accountId");

ALTER TABLE "JournalEntryLine" ADD CONSTRAINT "JournalEntryLine_journalEntryId_fkey"
  FOREIGN KEY ("journalEntryId") REFERENCES "JournalEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "JournalEntryLine" ADD CONSTRAINT "JournalEntryLine_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "GlAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Seed the 9 GL accounts the AR auto-posts depend on. Service layer
-- looks these up by code (e.g., findByCode('1210') for AR posts).
-- Pilot is single-warehouse, so 1310 is per-pilot-instance — the GL
-- slice generalizes to per-warehouse inventory accounts.
INSERT INTO "GlAccount" ("id", "code", "name", "type", "updatedAt") VALUES
  ('seed_gl_1110', '1110', 'Cash / Bank',                'ASSET'::"AccountType",   NOW()),
  ('seed_gl_1210', '1210', 'Accounts Receivable',        'ASSET'::"AccountType",   NOW()),
  ('seed_gl_1310', '1310', 'Inventory - Main Warehouse', 'ASSET'::"AccountType",   NOW()),
  ('seed_gl_4100', '4100', 'Sales Revenue',              'REVENUE'::"AccountType", NOW()),
  ('seed_gl_4200', '4200', 'Shipping Income',            'REVENUE'::"AccountType", NOW()),
  ('seed_gl_4300', '4300', 'Handling Income',            'REVENUE'::"AccountType", NOW()),
  ('seed_gl_4500', '4500', 'Sales Returns',              'REVENUE'::"AccountType", NOW()),
  ('seed_gl_4600', '4600', 'Restocking Fee Income',      'REVENUE'::"AccountType", NOW()),
  ('seed_gl_5100', '5100', 'Cost of Goods Sold',         'EXPENSE'::"AccountType", NOW())
ON CONFLICT ("code") DO NOTHING;
