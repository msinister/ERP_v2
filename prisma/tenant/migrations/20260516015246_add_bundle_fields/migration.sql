-- AlterEnum
ALTER TYPE "ProductType" ADD VALUE 'BUNDLE';

-- AlterTable
ALTER TABLE "InvoiceLine" ADD COLUMN     "bundleGroupId" TEXT,
ADD COLUMN     "bundleSourceProductId" TEXT;

-- AlterTable
ALTER TABLE "SalesOrderLine" ADD COLUMN     "bundleGroupId" TEXT,
ADD COLUMN     "bundleSourceProductId" TEXT;

-- CreateIndex
CREATE INDEX "InvoiceLine_bundleGroupId_idx" ON "InvoiceLine"("bundleGroupId");

-- CreateIndex
CREATE INDEX "SalesOrderLine_bundleGroupId_idx" ON "SalesOrderLine"("bundleGroupId");

-- AddForeignKey
ALTER TABLE "SalesOrderLine" ADD CONSTRAINT "SalesOrderLine_bundleSourceProductId_fkey" FOREIGN KEY ("bundleSourceProductId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_bundleSourceProductId_fkey" FOREIGN KEY ("bundleSourceProductId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;
