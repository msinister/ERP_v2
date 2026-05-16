import { Prisma } from '@/generated/tenant';
import type { PrismaClient } from '@/generated/tenant';
import {
  SETTING_KEYS,
  overShippingPolicyValueSchema,
  type OverShippingPolicyValue,
} from '@/lib/validation/settings';

// =============================================================================
// over_shipping_policy — tenant-wide policy for qtyShipped > qtyOrdered.
//
//   BLOCK   — server rejects. Historical behavior.
//   CONFIRM — server accepts; UI gates with a confirm dialog (operator
//             must explicitly OK the over-ship). The server doesn't
//             enforce the dialog — clients that skip it just succeed,
//             which is fine: the dialog is a speed bump, not security.
//   ALLOW   — server accepts; UI saves with no prompt.
//
// Defensive default when the Setting row is missing: CONFIRM (matches
// the spec's requested default and is the least-surprising mid-ground
// — it neither hard-blocks nor silently allows). Mirrors the
// getNegativeInventoryAllowed pattern so the helper can be called from
// inside a TransactionClient.
// =============================================================================

export type OverShippingClient = PrismaClient | Prisma.TransactionClient;

const DEFAULT_POLICY: OverShippingPolicyValue = 'CONFIRM';

export async function getOverShippingPolicy(
  client: OverShippingClient,
): Promise<OverShippingPolicyValue> {
  const row = await client.setting.findUnique({
    where: { key: SETTING_KEYS.OVER_SHIPPING_POLICY },
  });
  if (!row) return DEFAULT_POLICY;
  const parsed = overShippingPolicyValueSchema.safeParse(row.value);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(
      `Setting '${SETTING_KEYS.OVER_SHIPPING_POLICY}' value failed schema validation: ${issues}`,
    );
  }
  return parsed.data.policy;
}
