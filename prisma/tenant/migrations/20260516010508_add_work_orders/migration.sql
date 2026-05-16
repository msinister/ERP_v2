-- CreateEnum
CREATE TYPE "WorkOrderStatus" AS ENUM ('DRAFT', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- AlterEnum
ALTER TYPE "InventoryMovementType" ADD VALUE 'BUILD_CONSUME';
ALTER TYPE "InventoryMovementType" ADD VALUE 'BUILD_PRODUCE';

-- CreateTable
CREATE TABLE "WorkOrder" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "qtyToBuild" DECIMAL(18,5) NOT NULL,
    "qtyCompleted" DECIMAL(18,5) NOT NULL DEFAULT 0,
    "laborCost" DECIMAL(18,5),
    "status" "WorkOrderStatus" NOT NULL DEFAULT 'DRAFT',
    "notes" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "createdById" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkOrderComponent" (
    "id" TEXT NOT NULL,
    "workOrderId" TEXT NOT NULL,
    "componentVariantId" TEXT NOT NULL,
    "qtyRequiredPerUnit" DECIMAL(18,5) NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkOrderComponent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkOrderCompletion" (
    "id" TEXT NOT NULL,
    "workOrderId" TEXT NOT NULL,
    "qtyCompleted" DECIMAL(18,5) NOT NULL,
    "unitCost" DECIMAL(18,5) NOT NULL,
    "totalLaborCost" DECIMAL(18,5) NOT NULL,
    "producedLayerId" TEXT,
    "journalEntryId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkOrderCompletion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WorkOrder_number_key" ON "WorkOrder"("number");

-- CreateIndex
CREATE INDEX "WorkOrder_productId_idx" ON "WorkOrder"("productId");

-- CreateIndex
CREATE INDEX "WorkOrder_status_idx" ON "WorkOrder"("status");

-- CreateIndex
CREATE INDEX "WorkOrder_warehouseId_idx" ON "WorkOrder"("warehouseId");

-- CreateIndex
CREATE INDEX "WorkOrder_deletedAt_idx" ON "WorkOrder"("deletedAt");

-- CreateIndex
CREATE INDEX "WorkOrderComponent_workOrderId_sortOrder_idx" ON "WorkOrderComponent"("workOrderId", "sortOrder");

-- CreateIndex
CREATE INDEX "WorkOrderComponent_componentVariantId_idx" ON "WorkOrderComponent"("componentVariantId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkOrderCompletion_producedLayerId_key" ON "WorkOrderCompletion"("producedLayerId");

-- CreateIndex
CREATE INDEX "WorkOrderCompletion_workOrderId_idx" ON "WorkOrderCompletion"("workOrderId");

-- AddForeignKey
ALTER TABLE "WorkOrder" ADD CONSTRAINT "WorkOrder_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkOrder" ADD CONSTRAINT "WorkOrder_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkOrder" ADD CONSTRAINT "WorkOrder_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkOrderComponent" ADD CONSTRAINT "WorkOrderComponent_workOrderId_fkey" FOREIGN KEY ("workOrderId") REFERENCES "WorkOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkOrderComponent" ADD CONSTRAINT "WorkOrderComponent_componentVariantId_fkey" FOREIGN KEY ("componentVariantId") REFERENCES "ProductVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkOrderCompletion" ADD CONSTRAINT "WorkOrderCompletion_workOrderId_fkey" FOREIGN KEY ("workOrderId") REFERENCES "WorkOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkOrderCompletion" ADD CONSTRAINT "WorkOrderCompletion_producedLayerId_fkey" FOREIGN KEY ("producedLayerId") REFERENCES "FifoLayer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkOrderCompletion" ADD CONSTRAINT "WorkOrderCompletion_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "JournalEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- =============================================================
-- Seed: Direct Labor expense account (5300).
-- Mirrors the seeding pattern used by COGS (5100) + Inventory
-- Adjustment Expense (5200). completeWorkOrder posts to '5300'
-- only when the WO's labor cost > 0; if the account is missing
-- the post() helper throws a clear error.
-- =============================================================
INSERT INTO "GlAccount" ("id", "code", "name", "type", "updatedAt") VALUES
  ('seed_gl_5300', '5300', 'Direct Labor', 'EXPENSE'::"AccountType", NOW())
ON CONFLICT ("code") DO NOTHING;
