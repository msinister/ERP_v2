-- =============================================================
-- add_accrued_receipts_and_adjustment_expense_seeds
--
-- Seeds two GL accounts the GL-counterpart-leg fix slice needs:
--   2020 Accrued Receipts             (LIABILITY) — clearing
--                                     account for goods-received-not-
--                                     invoiced. postReceipt posts
--                                     CR 2020 at receipt time; the AP
--                                     slice will later DR 2020 / CR AP
--                                     when the bill is confirmed.
--   5200 Inventory Adjustment Expense (EXPENSE)  — DR side of loss
--                                     adjustments (CR side for found
--                                     stock). createAdjustmentTx posts
--                                     against this account.
--
-- Seed-only migration (no DDL). The GlAccount table already exists
-- (created in 20260430070059_add_gl_stub). Stable hardcoded IDs
-- ('seed_gl_2020', 'seed_gl_5200') match the convention established in
-- add_gl_stub — these IDs are part of the operational contract; do not
-- switch to cuid generation for seed data.
--
-- ON CONFLICT DO NOTHING so re-running the migration on a database that
-- already has either code is a no-op (matches add_gl_stub idempotency).
--
-- Audit ref: docs/audits/2026-05-03-backend-inventory.md SUMMARY #1.
-- Spec ref:  docs/08-gl-costing-reporting.md (PO received → "Received
--            not invoiced" pattern; Inventory adjustment → loss/found
--            JE shapes).
-- =============================================================

INSERT INTO "GlAccount" ("id", "code", "name", "type", "updatedAt") VALUES
  ('seed_gl_2020', '2020', 'Accrued Receipts',             'LIABILITY'::"AccountType", NOW()),
  ('seed_gl_5200', '5200', 'Inventory Adjustment Expense', 'EXPENSE'::"AccountType",   NOW())
ON CONFLICT ("code") DO NOTHING;
