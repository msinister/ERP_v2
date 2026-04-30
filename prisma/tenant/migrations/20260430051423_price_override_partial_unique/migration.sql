-- =============================================================
-- price_override_partial_unique
--
-- Replaces the naive UNIQUE (customerId, variantId) on
-- CustomerPriceOverride with a partial unique index that ignores
-- soft-deleted rows. Without this, soft-deleting an override and
-- creating a fresh one for the same (customer, variant) pair fails
-- with a unique-constraint violation. Mirrors the existing pattern
-- on CustomerAddress / CustomerContact / CustomerPaymentMethod.
-- =============================================================

DROP INDEX "CustomerPriceOverride_customerId_variantId_key";

CREATE UNIQUE INDEX "customerpriceoverride_active_key"
  ON "CustomerPriceOverride" ("customerId", "variantId")
  WHERE "deletedAt" IS NULL;
