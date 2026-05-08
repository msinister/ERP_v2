-- =============================================================
-- restrict_billline_discriminator_fks
-- Phase 8 slice C followup. The BillLine_source_xor CHECK constraint
-- (added in 20260507000000_add_bills_ap_schema) requires exactly one
-- of (variantId, expenseAccountId) to be non-null. Prisma's default
-- ON DELETE for nullable FKs is SET NULL, which means hard-deleting a
-- ProductVariant or a GlAccount referenced by a BillLine sets the
-- discriminator column to NULL — and the CHECK then rejects the row
-- because both discriminators end up NULL.
--
-- Production never hard-deletes ProductVariant or GlAccount (soft-delete
-- only). Test cleanup does, and was hitting the CHECK violation when
-- variants got deleted while bills still referenced them. Switching to
-- RESTRICT forces the right cleanup order: delete bills before variants
-- / accounts.
--
-- BillLine.receiptLineId stays SET NULL — it's optional traceability,
-- not part of the XOR; losing the link doesn't violate the CHECK
-- because variantId on the PRODUCT line stays set.
--
-- Pre-existing Vendor_paymentTermId_fkey RESTRICT-vs-SET NULL drift
-- continues to be untouched here.
-- =============================================================

ALTER TABLE "BillLine" DROP CONSTRAINT "BillLine_variantId_fkey";
ALTER TABLE "BillLine"
  ADD CONSTRAINT "BillLine_variantId_fkey"
    FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "BillLine" DROP CONSTRAINT "BillLine_expenseAccountId_fkey";
ALTER TABLE "BillLine"
  ADD CONSTRAINT "BillLine_expenseAccountId_fkey"
    FOREIGN KEY ("expenseAccountId") REFERENCES "GlAccount"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
