-- CreateEnum
CREATE TYPE "SalesOrderStatus" AS ENUM ('DRAFT', 'CONFIRMED', 'DISPATCHED', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SalesOrderSource" AS ENUM ('STAFF', 'PORTAL', 'SHOPIFY');

-- CreateEnum
CREATE TYPE "PriceResolutionRule" AS ENUM ('BASE_PRICE', 'MANUAL_OVERRIDE', 'CUSTOMER_SPECIFIC', 'QTY_BREAK', 'TIER_DISCOUNT', 'PROMO', 'COST_PLUS');

-- AlterEnum
ALTER TYPE "AuditAction" ADD VALUE 'INSUFFICIENT_STOCK_AT_CLOSE';

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesOrder" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "status" "SalesOrderStatus" NOT NULL DEFAULT 'DRAFT',
    "source" "SalesOrderSource" NOT NULL DEFAULT 'STAFF',
    "currency" TEXT DEFAULT 'USD',
    "customerPo" TEXT,
    "promisedShipDate" TIMESTAMP(3),
    "orderDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "orderDiscountPercent" DECIMAL(18,5),
    "orderDiscountAmount" DECIMAL(18,5),
    "shippingAmount" DECIMAL(18,5),
    "handlingAmount" DECIMAL(18,5),
    "shippingAddress" TEXT,
    "customerNotes" TEXT,
    "internalNotes" TEXT,
    "createdById" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "dispatchedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalesOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesOrderLine" (
    "id" TEXT NOT NULL,
    "salesOrderId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "qtyOrdered" DECIMAL(18,5) NOT NULL,
    "qtyReserved" DECIMAL(18,5) NOT NULL DEFAULT 0,
    "qtyShipped" DECIMAL(18,5) NOT NULL DEFAULT 0,
    "unitPrice" DECIMAL(18,5) NOT NULL,
    "priceRule" "PriceResolutionRule" NOT NULL,
    "discountPercent" DECIMAL(18,5),
    "discountAmount" DECIMAL(18,5),
    "customerNote" TEXT,
    "internalNote" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalesOrderLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Customer_code_key" ON "Customer"("code");

-- CreateIndex
CREATE UNIQUE INDEX "SalesOrder_number_key" ON "SalesOrder"("number");

-- CreateIndex
CREATE INDEX "SalesOrder_customerId_status_idx" ON "SalesOrder"("customerId", "status");

-- CreateIndex
CREATE INDEX "SalesOrder_status_orderDate_idx" ON "SalesOrder"("status", "orderDate");

-- CreateIndex
CREATE INDEX "SalesOrder_warehouseId_idx" ON "SalesOrder"("warehouseId");

-- CreateIndex
CREATE INDEX "SalesOrder_deletedAt_idx" ON "SalesOrder"("deletedAt");

-- CreateIndex
CREATE INDEX "SalesOrderLine_salesOrderId_idx" ON "SalesOrderLine"("salesOrderId");

-- CreateIndex
CREATE INDEX "SalesOrderLine_variantId_warehouseId_idx" ON "SalesOrderLine"("variantId", "warehouseId");

-- CreateIndex
CREATE INDEX "SalesOrderLine_deletedAt_idx" ON "SalesOrderLine"("deletedAt");

-- AddForeignKey
ALTER TABLE "SalesOrder" ADD CONSTRAINT "SalesOrder_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesOrder" ADD CONSTRAINT "SalesOrder_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesOrderLine" ADD CONSTRAINT "SalesOrderLine_salesOrderId_fkey" FOREIGN KEY ("salesOrderId") REFERENCES "SalesOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesOrderLine" ADD CONSTRAINT "SalesOrderLine_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesOrderLine" ADD CONSTRAINT "SalesOrderLine_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
