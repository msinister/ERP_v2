-- =============================================================
-- add_fifo_costing_foundation
--
-- Part 1 of the costing engine slice. Foundation only: FifoLayer
-- table, FifoConsumption breakdown rows, InventoryMovement.unitCost +
-- negativeAllocation columns, Warehouse → GlAccount FK, and the
-- NEGATIVE_INVENTORY_ALLOWED tenant Setting (default { "allowed": false }).
--
-- Out of scope here: retroactive COGS posting (Part 2), WAC
-- computation (Part 3), late-landed-cost layer mutation (Part 4),
-- void/reversal (Part 5).
--
-- No backfill of FifoLayer for pre-existing RECEIVE movements —
-- pre-Part-1 receives have no unitCost data and inventing one would
-- produce wrong COGS later. Part 2 will design the legacy backfill
-- explicitly. Test fixtures reseed clean each run.
--
-- qtyRemaining is denormalized (not a Postgres GENERATED column —
-- Prisma 6.x has no first-class schema directive for STORED generated
-- columns; service code maintains it and a CHECK enforces consistency
-- at COMMIT).
-- =============================================================

-- AlterTable
ALTER TABLE "InventoryMovement" ADD COLUMN     "negativeAllocation" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "unitCost" DECIMAL(18,5);

-- AlterTable
ALTER TABLE "Warehouse" ADD COLUMN     "inventoryAccountId" TEXT;

-- CreateTable
CREATE TABLE "FifoLayer" (
    "id" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "qtyReceived" DECIMAL(18,5) NOT NULL,
    "qtyConsumed" DECIMAL(18,5) NOT NULL DEFAULT 0,
    "qtyRemaining" DECIMAL(18,5) NOT NULL,
    "unitCost" DECIMAL(18,5) NOT NULL,
    "receivedDate" TIMESTAMP(3) NOT NULL,
    "sourceReceiptLineId" TEXT,
    "sourceMovementId" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FifoLayer_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "FifoLayer_qtyReceived_positive_chk"     CHECK ("qtyReceived" > 0),
    CONSTRAINT "FifoLayer_qtyConsumed_nonneg_chk"       CHECK ("qtyConsumed" >= 0),
    CONSTRAINT "FifoLayer_qtyConsumed_lte_received_chk" CHECK ("qtyConsumed" <= "qtyReceived"),
    CONSTRAINT "FifoLayer_qtyRemaining_consistent_chk"  CHECK ("qtyRemaining" = "qtyReceived" - "qtyConsumed")
);

-- CreateTable
CREATE TABLE "FifoConsumption" (
    "id" TEXT NOT NULL,
    "movementId" TEXT NOT NULL,
    "layerId" TEXT NOT NULL,
    "qty" DECIMAL(18,5) NOT NULL,
    "unitCost" DECIMAL(18,5) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FifoConsumption_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "FifoConsumption_qty_positive_chk"    CHECK ("qty" > 0),
    CONSTRAINT "FifoConsumption_unitCost_nonneg_chk" CHECK ("unitCost" >= 0)
);

-- CreateIndex
CREATE UNIQUE INDEX "FifoLayer_sourceReceiptLineId_key" ON "FifoLayer"("sourceReceiptLineId");

-- CreateIndex
CREATE UNIQUE INDEX "FifoLayer_sourceMovementId_key" ON "FifoLayer"("sourceMovementId");

-- CreateIndex
CREATE INDEX "FifoLayer_variantId_warehouseId_receivedDate_id_idx" ON "FifoLayer"("variantId", "warehouseId", "receivedDate", "id");

-- CreateIndex
CREATE INDEX "FifoLayer_deletedAt_idx" ON "FifoLayer"("deletedAt");

-- CreateIndex
CREATE INDEX "FifoConsumption_movementId_idx" ON "FifoConsumption"("movementId");

-- CreateIndex
CREATE INDEX "FifoConsumption_layerId_idx" ON "FifoConsumption"("layerId");

-- AddForeignKey
ALTER TABLE "Warehouse" ADD CONSTRAINT "Warehouse_inventoryAccountId_fkey" FOREIGN KEY ("inventoryAccountId") REFERENCES "GlAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FifoLayer" ADD CONSTRAINT "FifoLayer_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FifoLayer" ADD CONSTRAINT "FifoLayer_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FifoLayer" ADD CONSTRAINT "FifoLayer_sourceReceiptLineId_fkey" FOREIGN KEY ("sourceReceiptLineId") REFERENCES "ReceiptLine"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FifoLayer" ADD CONSTRAINT "FifoLayer_sourceMovementId_fkey" FOREIGN KEY ("sourceMovementId") REFERENCES "InventoryMovement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FifoConsumption" ADD CONSTRAINT "FifoConsumption_movementId_fkey" FOREIGN KEY ("movementId") REFERENCES "InventoryMovement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FifoConsumption" ADD CONSTRAINT "FifoConsumption_layerId_fkey" FOREIGN KEY ("layerId") REFERENCES "FifoLayer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Backfill: link the seeded WH-MAIN warehouse to the seeded GL '1310 Inventory - Main Warehouse'.
-- seed_gl_1310 is the stable hardcoded id from add_gl_stub. Idempotent via IS NULL guard.
UPDATE "Warehouse"
SET "inventoryAccountId" = 'seed_gl_1310'
WHERE "code" = 'WH-MAIN'
  AND "inventoryAccountId" IS NULL
  AND EXISTS (SELECT 1 FROM "GlAccount" WHERE "id" = 'seed_gl_1310' AND "deletedAt" IS NULL);

-- Seed the negative_inventory_allowed Setting row at default { "allowed": false }.
-- Object wrapper matches the restocking_fee_default precedent. Idempotent via WHERE NOT EXISTS.
INSERT INTO "Setting" ("id", "key", "value", "updatedAt")
SELECT 'seed_set_neginv', 'negative_inventory_allowed', '{"allowed": false}'::jsonb, NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM "Setting" WHERE "key" = 'negative_inventory_allowed'
);
