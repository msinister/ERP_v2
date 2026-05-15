-- =============================================================
-- invoice_sales_order_id_nullable
-- Reopen support — reopenSalesOrder unlinks the invoice from the SO
-- without voiding it. The Invoice keeps its applications, lines, and
-- posted JE rows; only the back-pointer to the SO goes away. A
-- subsequent close on the reopened SO generates a fresh invoice.
--
-- Schema change: Invoice.salesOrderId NOT NULL → NULL.
-- The pre-existing UNIQUE constraint stays as-is. Postgres treats
-- multiple NULLs as distinct under a UNIQUE constraint, so the
-- index continues to enforce one active invoice per SO for all
-- non-null rows while permitting any number of NULL'd orphans.
-- =============================================================

ALTER TABLE "Invoice" ALTER COLUMN "salesOrderId" DROP NOT NULL;
