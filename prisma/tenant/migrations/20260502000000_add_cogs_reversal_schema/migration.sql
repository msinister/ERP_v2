-- Part 3.5 of the costing engine slice: COGS reversal in voidInvoice and
-- creditFromRma.
--
-- This migration adds:
--   1. RMA_RETURN value to the InventoryMovementType enum (for movements
--      created by the goods-back path of cogsReversal).
--   2. Invoice.cogsReversed (idempotency anchor for voidInvoice's
--      reversal step).
--   3. CreditMemo.cogsReversed (idempotency anchor for creditFromRma's
--      reversal step; per-CM, independent of Invoice).
--   4. CreditMemoCategory.lossAccountId — admin-managed FK to GlAccount.
--      When set, drives the loss-reclassification reversal path
--      (DR Loss / CR COGS, no inventory restoration).
--   5. Three new Loss GL accounts (5920, 5930, 5940) for the loss-
--      reclassification path.
--   6. Two new CreditMemoCategory rows (SHIPPING_DAMAGE, MANUFACTURER_DEFECT)
--      and a relabel + lossAccountId set on the existing DAMAGED row.
--
-- ALTER TYPE comes first. In Postgres 12+ ALTER TYPE ... ADD VALUE works
-- inside a transaction provided the new value isn't *used* in the same
-- transaction. This migration only ADDS the value; service code writes
-- RMA_RETURN movements at runtime, not here. Safe.

ALTER TYPE "InventoryMovementType" ADD VALUE IF NOT EXISTS 'RMA_RETURN';

-- Idempotency anchors for the two reversal flows. Boolean defaults to
-- false so existing rows are correctly tagged "not yet reversed."
ALTER TABLE "Invoice" ADD COLUMN "cogsReversed" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "CreditMemo" ADD COLUMN "cogsReversed" BOOLEAN NOT NULL DEFAULT false;

-- Loss-account FK on CreditMemoCategory. Nullable because most categories
-- (RETURN, GOODWILL, PRICING_DISPUTE, CANCELLED) don't reclassify to a
-- loss account — they go through goods-back or pure-AR paths instead.
-- ON DELETE SET NULL matches Warehouse.inventoryAccountId precedent: the
-- GL account's life isn't owned by the category.
ALTER TABLE "CreditMemoCategory" ADD COLUMN "lossAccountId" TEXT;
ALTER TABLE "CreditMemoCategory" ADD CONSTRAINT "CreditMemoCategory_lossAccountId_fkey"
  FOREIGN KEY ("lossAccountId") REFERENCES "GlAccount"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "CreditMemoCategory_lossAccountId_idx" ON "CreditMemoCategory"("lossAccountId");

-- Loss GL accounts. Stable hardcoded ids matching the existing seed_gl_*
-- pattern from add_gl_stub. ON CONFLICT (code) DO NOTHING so this
-- migration is idempotent on re-run and across environments where these
-- accounts may already have been added by an admin.
INSERT INTO "GlAccount" ("id", "code", "name", "type", "updatedAt") VALUES
  ('seed_gl_5920', '5920', 'Loss - Shipping Damage',     'EXPENSE'::"AccountType", NOW()),
  ('seed_gl_5930', '5930', 'Loss - Manufacturer Defect', 'EXPENSE'::"AccountType", NOW()),
  ('seed_gl_5940', '5940', 'Loss - Misc Damage',         'EXPENSE'::"AccountType", NOW())
ON CONFLICT ("code") DO NOTHING;

-- New CreditMemoCategory rows. SHIPPING_DAMAGE + MANUFACTURER_DEFECT.
-- affectsInventory=false because these are loss-reclassification paths,
-- NOT goods-back paths. The lossAccountId is what tells reverseCogsForCreditMemoTx
-- to post DR Loss / CR COGS instead of restoring inventory.
INSERT INTO "CreditMemoCategory" ("id", "code", "label", "affectsInventory", "lossAccountId", "updatedAt") VALUES
  ('seed_cmc_shipping_damage',     'SHIPPING_DAMAGE',     'Shipping Damage',     false, 'seed_gl_5920', NOW()),
  ('seed_cmc_manufacturer_defect', 'MANUFACTURER_DEFECT', 'Manufacturer Defect', false, 'seed_gl_5930', NOW())
ON CONFLICT ("code") DO NOTHING;

-- Relabel existing DAMAGED row + set lossAccountId. The original 'Damaged'
-- label collides semantically with the new finer-grained categories;
-- relabel to 'Misc Damage' and route to 5940. Guarded so idempotent and
-- so we don't clobber an admin-set lossAccountId from a future change.
UPDATE "CreditMemoCategory"
SET "label" = 'Misc Damage',
    "lossAccountId" = 'seed_gl_5940',
    "updatedAt" = NOW()
WHERE "code" = 'DAMAGED'
  AND "lossAccountId" IS NULL
  AND EXISTS (SELECT 1 FROM "GlAccount" WHERE "id" = 'seed_gl_5940' AND "deletedAt" IS NULL);
