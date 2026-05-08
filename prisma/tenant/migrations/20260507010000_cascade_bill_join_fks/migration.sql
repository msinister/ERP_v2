-- =============================================================
-- cascade_bill_join_fks
-- Phase 8 slice C prep — switch the Bill ↔ Receipt and Bill ↔ PO
-- join tables to ON DELETE CASCADE so test cleanup that hard-deletes
-- receipts/POs doesn't leave orphan join rows that block the parent
-- table delete.
--
-- Production never hard-deletes Bill, Receipt, or PurchaseOrder
-- (soft-delete only), so cascade fires only in test scenarios; no
-- change to operational data integrity. The composite-PK join row is
-- pure association and meaningless without either parent.
--
-- Pre-existing Vendor_paymentTermId_fkey RESTRICT-vs-SET NULL drift
-- (called out in 20260507000000_add_bills_ap_schema header) remains
-- untouched here. That's a separate, deliberate decision deferred for
-- its own slice.
-- =============================================================

-- BillReceipt
ALTER TABLE "BillReceipt" DROP CONSTRAINT "BillReceipt_billId_fkey";
ALTER TABLE "BillReceipt" DROP CONSTRAINT "BillReceipt_receiptId_fkey";
ALTER TABLE "BillReceipt"
  ADD CONSTRAINT "BillReceipt_billId_fkey"
    FOREIGN KEY ("billId") REFERENCES "Bill"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "BillReceipt_receiptId_fkey"
    FOREIGN KEY ("receiptId") REFERENCES "Receipt"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- BillPurchaseOrder
ALTER TABLE "BillPurchaseOrder" DROP CONSTRAINT "BillPurchaseOrder_billId_fkey";
ALTER TABLE "BillPurchaseOrder" DROP CONSTRAINT "BillPurchaseOrder_purchaseOrderId_fkey";
ALTER TABLE "BillPurchaseOrder"
  ADD CONSTRAINT "BillPurchaseOrder_billId_fkey"
    FOREIGN KEY ("billId") REFERENCES "Bill"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "BillPurchaseOrder_purchaseOrderId_fkey"
    FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
