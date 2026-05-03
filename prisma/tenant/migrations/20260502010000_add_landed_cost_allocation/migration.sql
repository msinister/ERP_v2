-- =============================================================
-- add_landed_cost_allocation
--
-- Part 4 of the costing engine slice: late landed cost retroactive
-- adjustment.
--
-- This migration adds:
--   1. AllocationMethod enum (UNIT_COUNT, VALUE, WEIGHT, BOX_COUNT).
--      Schema declares all four values so the enum doesn't need a
--      migration when WEIGHT/BOX_COUNT operationally land. The Part 4
--      service rejects WEIGHT/BOX_COUNT with a "deferred to future
--      slice" error; UNIT_COUNT and VALUE are the active paths.
--   2. LandedCostAllocation table: header for one applied freight /
--      customs / handling allocation. sourceBillId is a plain TEXT?
--      (no FK) for now — the Bill model lives in the future Bills/AP
--      slice (phase 8). When that slice lands, an additive migration
--      adds the FK constraint. notes / appliedById / reversedAt /
--      reversedReason / deletedAt mirror the patterns established by
--      CreditMemo + Receipt.
--   3. LandedCostAllocationLine table: one row per affected FifoLayer.
--      originalUnitCost is the snapshot used by reverseLandedCost-
--      Allocation to restore layer.unitCost; deltaUnitCost +
--      deltaTotal capture the dollar impact for audit/reporting.
--      cogsAdjustmentJeId is nullable because layers with no
--      FifoConsumption rows (no sales yet) have no COGS adjustment
--      JE to anchor; per scope decision, layers whose consumptions
--      tie to not-yet-cogs-posted invoices ALSO post no JE (instead,
--      the consumption.unitCost snapshot is mutated in-place — see
--      revised invariant in schema.prisma).
--   4. LandedCostAllocationReceipt join: M:N between Allocation and
--      Receipt. Mirror of the per-FifoLayer Lines child, one level
--      up. UNIQUE(allocationId, receiptId) prevents duplicate links;
--      INDEX(receiptId) supports the reverse query "all allocations
--      applied to receipt X" (vendor freight-bill reconciliation).
--
-- Out of scope here:
--   - Forward landed cost on postReceipt (postReceipt signature
--     unchanged — receipts continue to take vendor's landed-inclusive
--     unitCost as today, per spec docs/07:120-121 "Most vendors quote
--     landed cost").
--   - Bill model (phase 8 Bills/AP slice).
--   - Period-close gating on backdated COGS adjustment JEs (TODO
--     comment in service code; AccountingPeriod model lands with the
--     full GL slice, Module 7).
--   - WEIGHT / BOX_COUNT allocator implementations (data dependencies
--     not yet in the schema — variant.weight, per-line box count).
--
-- No backfill of existing FifoLayers — there is no historical data to
-- back-allocate. The first allocation in a given environment writes
-- fresh rows.
-- =============================================================

-- CreateEnum
CREATE TYPE "AllocationMethod" AS ENUM ('UNIT_COUNT', 'VALUE', 'WEIGHT', 'BOX_COUNT');

-- CreateTable
CREATE TABLE "LandedCostAllocation" (
    "id" TEXT NOT NULL,
    "totalLandedCost" DECIMAL(18,5) NOT NULL,
    "allocationMethod" "AllocationMethod" NOT NULL,
    "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "appliedById" TEXT,
    "reversedAt" TIMESTAMP(3),
    "reversedReason" TEXT,
    "sourceBillId" TEXT,
    "notes" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LandedCostAllocation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "LandedCostAllocation_totalLandedCost_positive_chk" CHECK ("totalLandedCost" > 0)
);

-- CreateTable
CREATE TABLE "LandedCostAllocationLine" (
    "id" TEXT NOT NULL,
    "allocationId" TEXT NOT NULL,
    "fifoLayerId" TEXT NOT NULL,
    "deltaUnitCost" DECIMAL(18,5) NOT NULL,
    "deltaTotal" DECIMAL(18,5) NOT NULL,
    "originalUnitCost" DECIMAL(18,5) NOT NULL,
    "cogsAdjustmentJeId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LandedCostAllocationLine_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "LandedCostAllocationLine_originalUnitCost_nonneg_chk" CHECK ("originalUnitCost" >= 0)
);

-- CreateTable
CREATE TABLE "LandedCostAllocationReceipt" (
    "id" TEXT NOT NULL,
    "allocationId" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LandedCostAllocationReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LandedCostAllocation_appliedAt_idx" ON "LandedCostAllocation"("appliedAt");

-- CreateIndex
CREATE INDEX "LandedCostAllocation_reversedAt_idx" ON "LandedCostAllocation"("reversedAt");

-- CreateIndex
CREATE INDEX "LandedCostAllocation_sourceBillId_idx" ON "LandedCostAllocation"("sourceBillId");

-- CreateIndex
CREATE INDEX "LandedCostAllocation_deletedAt_idx" ON "LandedCostAllocation"("deletedAt");

-- CreateIndex
CREATE INDEX "LandedCostAllocationLine_allocationId_idx" ON "LandedCostAllocationLine"("allocationId");

-- CreateIndex
CREATE INDEX "LandedCostAllocationLine_fifoLayerId_idx" ON "LandedCostAllocationLine"("fifoLayerId");

-- CreateIndex
CREATE INDEX "LandedCostAllocationLine_cogsAdjustmentJeId_idx" ON "LandedCostAllocationLine"("cogsAdjustmentJeId");

-- CreateIndex
CREATE UNIQUE INDEX "LandedCostAllocationReceipt_allocationId_receiptId_key" ON "LandedCostAllocationReceipt"("allocationId", "receiptId");

-- CreateIndex
CREATE INDEX "LandedCostAllocationReceipt_receiptId_idx" ON "LandedCostAllocationReceipt"("receiptId");

-- AddForeignKey
ALTER TABLE "LandedCostAllocationLine" ADD CONSTRAINT "LandedCostAllocationLine_allocationId_fkey"
  FOREIGN KEY ("allocationId") REFERENCES "LandedCostAllocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LandedCostAllocationLine" ADD CONSTRAINT "LandedCostAllocationLine_fifoLayerId_fkey"
  FOREIGN KEY ("fifoLayerId") REFERENCES "FifoLayer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LandedCostAllocationLine" ADD CONSTRAINT "LandedCostAllocationLine_cogsAdjustmentJeId_fkey"
  FOREIGN KEY ("cogsAdjustmentJeId") REFERENCES "JournalEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LandedCostAllocationReceipt" ADD CONSTRAINT "LandedCostAllocationReceipt_allocationId_fkey"
  FOREIGN KEY ("allocationId") REFERENCES "LandedCostAllocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LandedCostAllocationReceipt" ADD CONSTRAINT "LandedCostAllocationReceipt_receiptId_fkey"
  FOREIGN KEY ("receiptId") REFERENCES "Receipt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
