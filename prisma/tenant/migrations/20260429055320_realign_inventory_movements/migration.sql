-- Realign InventoryMovementType enum to approved spec:
--   Rename:  ADJUSTMENT -> ADJUST, RECEIPT -> RECEIVE, SALE -> CONSUME
--   Drop:    RETURN, BUILD_CONSUME, BUILD_RECEIPT
-- Add column InventoryMovement.transferGroupId + index.
--
-- Strategy: cast column to TEXT, translate values in-place, recreate the enum
-- with only the approved set, cast back. Fails loudly if any row holds a
-- to-be-dropped value (no clean mapping exists for RETURN / BUILD_*).

ALTER TABLE "InventoryMovement" ALTER COLUMN "type" TYPE TEXT USING "type"::TEXT;

UPDATE "InventoryMovement" SET "type" = 'ADJUST'  WHERE "type" = 'ADJUSTMENT';
UPDATE "InventoryMovement" SET "type" = 'RECEIVE' WHERE "type" = 'RECEIPT';
UPDATE "InventoryMovement" SET "type" = 'CONSUME' WHERE "type" = 'SALE';

DO $$
DECLARE
  bad_count BIGINT;
BEGIN
  SELECT COUNT(*) INTO bad_count
    FROM "InventoryMovement"
   WHERE "type" IN ('RETURN', 'BUILD_CONSUME', 'BUILD_RECEIPT');
  IF bad_count > 0 THEN
    RAISE EXCEPTION
      'Cannot drop enum values: % InventoryMovement rows still use RETURN/BUILD_CONSUME/BUILD_RECEIPT',
      bad_count;
  END IF;
END $$;

DROP TYPE "InventoryMovementType";

CREATE TYPE "InventoryMovementType" AS ENUM ('ADJUST', 'RECEIVE', 'CONSUME', 'TRANSFER_OUT', 'TRANSFER_IN');

ALTER TABLE "InventoryMovement"
  ALTER COLUMN "type" TYPE "InventoryMovementType" USING "type"::"InventoryMovementType";

ALTER TABLE "InventoryMovement" ADD COLUMN "transferGroupId" TEXT;

CREATE INDEX "InventoryMovement_transferGroupId_idx" ON "InventoryMovement" ("transferGroupId");
