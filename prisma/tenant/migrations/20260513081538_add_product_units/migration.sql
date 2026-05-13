-- Add weight + dimension unit columns to Product. Both nullable with
-- defaults so existing rows backfill on read (or via the form on next
-- edit); operators can null them out if a product is unit-agnostic
-- (e.g. SERVICE).

ALTER TABLE "Product"
  ADD COLUMN "weightUnit"    TEXT DEFAULT 'lb',
  ADD COLUMN "dimensionUnit" TEXT DEFAULT 'in';

-- NOT included: any change to Vendor_paymentTermId_fkey's ON DELETE
-- behavior. Prisma's auto-diff wanted to swap RESTRICT → SET NULL
-- (nullable-FK default in schema differs from the original hand-written
-- constraint in add_vendor_master). That's pre-existing drift, not a
-- product-units concern; deliberate behavior change deferred per the
-- same rationale as 20260507000000_add_bills_ap_schema.
