import { Prisma } from '@/generated/tenant';
import type { PrismaClient } from '@/generated/tenant';
import {
  SETTING_KEYS,
  negativeInventoryAllowedValueSchema,
} from '@/lib/validation/settings';

// =============================================================================
// negative_inventory_allowed — tenant-wide CONSUME-below-zero flag.
//
// Default false (set by the add_fifo_costing_foundation migration). Reads
// directly from the Setting table rather than going through getSetting()
// so this helper accepts either a PrismaClient or a Prisma.TransactionClient
// — necessary because consumeInventoryTx (Phase 1C) needs to read it from
// inside its own transaction.
//
// Defensive default: returns false if the Setting row is missing. The
// migration seeds the row, so absence implies operator action removed it
// (which is itself a fail-safe state — block consumption rather than
// silently allow negative inventory).
// =============================================================================

export type NegativeInventoryClient = PrismaClient | Prisma.TransactionClient;

export async function getNegativeInventoryAllowed(
  client: NegativeInventoryClient,
): Promise<boolean> {
  const row = await client.setting.findUnique({
    where: { key: SETTING_KEYS.NEGATIVE_INVENTORY_ALLOWED },
  });
  if (!row) return false;
  const parsed = negativeInventoryAllowedValueSchema.safeParse(row.value);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(
      `Setting '${SETTING_KEYS.NEGATIVE_INVENTORY_ALLOWED}' value failed schema validation: ${issues}`,
    );
  }
  return parsed.data.allowed;
}
