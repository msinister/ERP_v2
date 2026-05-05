-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "cogsAtClose" DECIMAL(18,5);

-- AlterTable
ALTER TABLE "SalesRep" ADD COLUMN     "commissionEnabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "CommissionAccrual" (
    "id" TEXT NOT NULL,
    "salesRepId" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "basis" "CommissionBasis" NOT NULL,
    "basisAmount" DECIMAL(18,5) NOT NULL,
    "percent" DECIMAL(18,5) NOT NULL,
    "amount" DECIMAL(18,5) NOT NULL,
    "accruedAt" TIMESTAMP(3) NOT NULL,
    "reversedAt" TIMESTAMP(3),
    "reversedByPaymentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommissionAccrual_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CommissionAccrual_salesRepId_accruedAt_idx" ON "CommissionAccrual"("salesRepId", "accruedAt");

-- CreateIndex
CREATE INDEX "CommissionAccrual_paymentId_idx" ON "CommissionAccrual"("paymentId");

-- CreateIndex
CREATE INDEX "CommissionAccrual_invoiceId_idx" ON "CommissionAccrual"("invoiceId");

-- CreateIndex
CREATE INDEX "CommissionAccrual_reversedByPaymentId_idx" ON "CommissionAccrual"("reversedByPaymentId");

-- AddForeignKey
ALTER TABLE "CommissionAccrual" ADD CONSTRAINT "CommissionAccrual_salesRepId_fkey" FOREIGN KEY ("salesRepId") REFERENCES "SalesRep"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionAccrual" ADD CONSTRAINT "CommissionAccrual_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionAccrual" ADD CONSTRAINT "CommissionAccrual_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionAccrual" ADD CONSTRAINT "CommissionAccrual_reversedByPaymentId_fkey" FOREIGN KEY ("reversedByPaymentId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
