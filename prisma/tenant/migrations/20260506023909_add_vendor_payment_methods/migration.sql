-- Vendor master slice B: encrypted payment-method records per vendor.
-- Payload (account/routing numbers, payee details, card metadata) is
-- AES-256-GCM ciphertext in encryptedPayload + IV in encryptedPayloadIv.
-- displayHint is server-derived non-sensitive summary (e.g. "ACH ****6789").
-- isPreferred singleton invariant is enforced at the SERVICE layer only;
-- no partial unique index (deliberate, mirrors CustomerDocument).

-- CreateEnum
CREATE TYPE "VendorPaymentMethodKind" AS ENUM ('ACH', 'WIRE', 'CHECK', 'CREDIT_CARD');

-- CreateTable
CREATE TABLE "VendorPaymentMethod" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "kind" "VendorPaymentMethodKind" NOT NULL,
    "label" TEXT,
    "encryptedPayload" TEXT NOT NULL,
    "encryptedPayloadIv" TEXT NOT NULL,
    "displayHint" TEXT,
    "isPreferred" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VendorPaymentMethod_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VendorPaymentMethod_vendorId_idx" ON "VendorPaymentMethod"("vendorId");

-- AddForeignKey. Match slice A's RESTRICT semantics for vendor master FKs:
-- a Vendor with payment methods on file should not be hard-deleted out
-- from under them. Soft-delete on Vendor is the supported path.
ALTER TABLE "VendorPaymentMethod"
  ADD CONSTRAINT "VendorPaymentMethod_vendorId_fkey"
  FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
