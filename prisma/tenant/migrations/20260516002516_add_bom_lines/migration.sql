-- AlterEnum
ALTER TYPE "ProductType" ADD VALUE 'ASSEMBLED';

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "bomLaborCost" DECIMAL(18,5);

-- CreateTable
CREATE TABLE "BomLine" (
    "id" TEXT NOT NULL,
    "parentProductId" TEXT NOT NULL,
    "componentVariantId" TEXT NOT NULL,
    "qtyRequired" DECIMAL(18,5) NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BomLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BomLine_parentProductId_sortOrder_idx" ON "BomLine"("parentProductId", "sortOrder");

-- CreateIndex
CREATE INDEX "BomLine_componentVariantId_idx" ON "BomLine"("componentVariantId");

-- CreateIndex
CREATE INDEX "BomLine_deletedAt_idx" ON "BomLine"("deletedAt");

-- AddForeignKey
ALTER TABLE "BomLine" ADD CONSTRAINT "BomLine_parentProductId_fkey" FOREIGN KEY ("parentProductId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BomLine" ADD CONSTRAINT "BomLine_componentVariantId_fkey" FOREIGN KEY ("componentVariantId") REFERENCES "ProductVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
