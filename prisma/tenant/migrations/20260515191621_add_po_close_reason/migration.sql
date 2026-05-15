-- =============================================================
-- add_po_close_reason
-- Manual close-with-reason on PurchaseOrders. Spec: operators can
-- close a CONFIRMED or PARTIALLY_RECEIVED PO when no further
-- receipts are expected (short shipment, damaged goods, vendor
-- can't fulfill). The reason is required for the audit trail and
-- displays on the PO detail page.
--
-- closeReason also serves as a sentinel: when present,
-- applyComputedPoStatus preserves the CLOSED status even if a
-- downstream receipt cancel would otherwise revert it.
-- =============================================================

ALTER TABLE "PurchaseOrder" ADD COLUMN "closeReason" TEXT;
