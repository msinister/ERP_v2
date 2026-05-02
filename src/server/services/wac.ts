import { Prisma, ReceiptStatus } from '@/generated/tenant';
import type { PrismaClient } from '@/generated/tenant';

// =============================================================================
// WAC service — Part 2 of the costing engine.
//
// Two pure read-only functions. Compute-on-demand; no cache, no schema
// column. Both accept either a PrismaClient or a Prisma.TransactionClient
// so callers can compose them inside an existing tx without nesting.
//
// Precision contract (matters for tests + future callers):
//
//   - computeWac is PURE COMPUTE. Reads layers from the DB at column
//     precision (Decimal(18, 5)) and divides in memory using Prisma.Decimal,
//     which is full Decimal.js precision (no DB round-trip on the result).
//     Quotients can therefore exceed 5 decimal places — e.g., 9/7 returns
//     the full quotient, NOT 1.28571. Compare with .toString() / .equals()
//     at full precision in tests; round only at display.
//
//   - getLastPurchaseCost returns a value READ from the Decimal(18, 5)
//     ReceiptLine.unitCost column. The Prisma.Decimal it returns therefore
//     has at most 5 fractional digits — toFixed(5) comparisons are valid.
//
// WAC ⊥ negative_allocation: WAC reads exclusively from FifoLayer rows
// whose qtyRemaining > 0. Negative-allocation movements never touch
// FifoLayer.qtyRemaining (they don't go through consumeFromLayersTx's
// mutation path), so they cannot affect computeWac's output.
// =============================================================================

export type WacClient = PrismaClient | Prisma.TransactionClient;

export async function computeWac(
  client: WacClient,
  variantId: string,
  warehouseId: string,
): Promise<Prisma.Decimal | null> {
  const layers = await client.fifoLayer.findMany({
    where: {
      variantId,
      warehouseId,
      deletedAt: null,
      qtyRemaining: { gt: new Prisma.Decimal(0) },
    },
    select: { qtyRemaining: true, unitCost: true },
  });

  if (layers.length === 0) return null;

  let totalValue = new Prisma.Decimal(0);
  let totalQty = new Prisma.Decimal(0);
  for (const l of layers) {
    totalValue = totalValue.plus(l.qtyRemaining.times(l.unitCost));
    totalQty = totalQty.plus(l.qtyRemaining);
  }

  // Defensive — the qtyRemaining > 0 filter and length check should make
  // this unreachable, but a friendly null is cheaper than a divide-by-zero.
  if (totalQty.lessThanOrEqualTo(0)) return null;

  return totalValue.dividedBy(totalQty);
}

export async function getLastPurchaseCost(
  client: WacClient,
  variantId: string,
  warehouseId: string,
): Promise<Prisma.Decimal | null> {
  // Tie-breaker on receipt.id is for stable ordering when two receipts
  // share an identical receivedAt timestamp. id is a CUID (random), so
  // it isn't time-meaningful — but for our volume the chance of a
  // sub-millisecond collision is low enough that "deterministic, not
  // necessarily latest-by-wall-clock" is acceptable.
  const line = await client.receiptLine.findFirst({
    where: {
      variantId,
      warehouseId,
      deletedAt: null,
      receipt: {
        status: ReceiptStatus.POSTED,
        deletedAt: null,
        // Defensive — POSTED implies non-null receivedAt (set in the same
        // update at receipts.ts:222-228). Filter remains as a safety net
        // against future code paths that might post without stamping.
        receivedAt: { not: null },
      },
    },
    orderBy: [
      { receipt: { receivedAt: 'desc' } },
      { receipt: { id: 'desc' } },
    ],
    select: { unitCost: true },
  });

  return line?.unitCost ?? null;
}
