import { Prisma } from '@/generated/tenant';
import { createHash } from 'node:crypto';

// Hash a string to a signed 32-bit int suitable for the (int4, int4) form of
// pg_advisory_xact_lock. We use the two-int form so the lock key is the pair
// (variantId, warehouseId) rather than a single bigint, which makes lock
// contention map cleanly to the per-bin granularity we want.
export function lockKey(s: string): number {
  return createHash('sha256').update(s).digest().readInt32BE(0);
}

// Take a per-bin advisory lock for the duration of the surrounding tx.
// Used by the inventory movement service AND the sales order service so
// reservation + consume operations against the same (variant, warehouse)
// serialize correctly.
export async function lockBin(
  tx: Prisma.TransactionClient,
  variantId: string,
  warehouseId: string,
): Promise<void> {
  const v = lockKey(variantId);
  const w = lockKey(warehouseId);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${v}::int4, ${w}::int4)`;
}

// Lock two bins for the same variant in deterministic order to avoid
// deadlocks between simultaneous A→B and B→A transfers.
export async function lockBinsOrdered(
  tx: Prisma.TransactionClient,
  variantId: string,
  warehouseA: string,
  warehouseB: string,
): Promise<void> {
  const [first, second] = [warehouseA, warehouseB].sort();
  await lockBin(tx, variantId, first);
  await lockBin(tx, variantId, second);
}
