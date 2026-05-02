-- Part 3 of the costing engine slice: add SalesOrderLine.inventoryMovementId
-- so closeSalesOrder can record which CONSUME movement covers each line,
-- and postCogsForInvoiceTx can walk Invoice → InvoiceLine → SOLine →
-- InventoryMovement → FifoConsumption to compute COGS deterministically.
--
-- Nullable + @unique mirrors ReceiptLine.inventoryMovementId (the existing
-- precedent for "one operational line ↔ one inventory movement"). Existing
-- pre-Part-3 SOLines stay NULL (no backfill — invoices for those SOs were
-- closed before COGS posting was wired and stay cogsPosted=false; that
-- history is intentional and matches the schema comment at Invoice.cogsPosted).

-- AlterTable: add the column.
ALTER TABLE "SalesOrderLine" ADD COLUMN "inventoryMovementId" TEXT;

-- Unique index: one movement ↔ one SOLine. Implemented as a partial index
-- via @unique in Prisma; here we add the standard btree unique constraint.
CREATE UNIQUE INDEX "SalesOrderLine_inventoryMovementId_key" ON "SalesOrderLine"("inventoryMovementId");

-- Foreign key. ON DELETE SET NULL matches ReceiptLine's pattern — the
-- movement's life isn't owned by the SOLine, and a future hard-delete
-- of a movement should null the back-reference rather than cascade-
-- delete the operational line.
ALTER TABLE "SalesOrderLine" ADD CONSTRAINT "SalesOrderLine_inventoryMovementId_fkey"
  FOREIGN KEY ("inventoryMovementId") REFERENCES "InventoryMovement"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
