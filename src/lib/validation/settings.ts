import { z } from 'zod';
import { decimalString } from './common';

// =============================================================================
// Setting model — value-schema registry.
//
// Each admin-configurable single value lives in the Setting table as a row
// keyed by `key`. The JSON `value` column is validated by a per-key Zod
// schema declared here. The schemas operate on the ON-DISK shape — strings
// for Decimals, primitives for numbers / booleans / nulls. Per-key wrapper
// services in src/server/services/* own the runtime ↔ on-disk conversion
// (e.g., string ↔ Prisma.Decimal at the boundary).
//
// Storage convention: Decimals serialize as strings via Prisma.Decimal.toString().
// New setting schemas MUST follow the same convention so JSON round-trips
// through Postgres without losing precision.
// =============================================================================

// ---------------------------------------------------------------------------
// restocking_fee_default
// ---------------------------------------------------------------------------
// Shape on disk: { percent: string | null, flat: string | null }
// At most one of percent / flat is non-null. Both null is valid (= "no
// default"). percent in [0, 100]; flat >= 0.

const decimalOrNull = z.union([decimalString, z.null()]);

export const restockingFeeDefaultValueSchema = z
  .object({
    percent: decimalOrNull,
    flat: decimalOrNull,
  })
  .superRefine((data, ctx) => {
    if (data.percent !== null && data.flat !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['flat'],
        message: 'Set percent OR flat, not both',
      });
    }
    if (data.percent !== null) {
      const n = Number(data.percent);
      if (!(n >= 0 && n <= 100)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['percent'],
          message: 'percent must be between 0 and 100',
        });
      }
    }
    if (data.flat !== null) {
      const n = Number(data.flat);
      if (!(n >= 0)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['flat'],
          message: 'flat must be >= 0',
        });
      }
    }
  });

export type RestockingFeeDefaultOnDisk = z.infer<typeof restockingFeeDefaultValueSchema>;

// ---------------------------------------------------------------------------
// negative_inventory_allowed
// ---------------------------------------------------------------------------
// Shape on disk: { allowed: boolean }
// Tenant-wide flag that controls whether CONSUME against insufficient stock
// is allowed. Default false (preserves the historical hard-block behavior).
// When true and stock is insufficient, the CONSUME succeeds with
// unitCost=NULL and negativeAllocation=true on the movement; no
// FifoConsumption rows are created. Back-fill on subsequent RECEIVE is
// not yet implemented (see CLAUDE.md known limitations).

export const negativeInventoryAllowedValueSchema = z.object({
  allowed: z.boolean(),
});

export type NegativeInventoryAllowedOnDisk = z.infer<
  typeof negativeInventoryAllowedValueSchema
>;

// ---------------------------------------------------------------------------
// tier_discount_percentages
// ---------------------------------------------------------------------------
// Shape on disk: { WHOLESALE_REGULAR: string, WHOLESALE_PREFERRED: string,
//                  WHOLESALE_DISTRIBUTOR: string, WHOLESALE_MASTER_DISTRIBUTOR: string,
//                  RETAIL: string }
// Each value is a Decimal-string in [0, 100] representing the blanket
// tier discount % applied at SO line entry. Tier % pre-fills the
// % Discount column on SO lines (operator can edit). Missing key =
// no tier discounts (resolver gracefully no-ops). Per audit doc
// resolution 4: stored as a Setting, not on Customer / CustomerCategory.

const tierDiscountPercent = decimalString.refine(
  (v) => {
    const n = Number(v);
    return n >= 0 && n <= 100;
  },
  'Must be between 0 and 100',
);

export const tierDiscountPercentagesValueSchema = z.object({
  WHOLESALE_REGULAR: tierDiscountPercent,
  WHOLESALE_PREFERRED: tierDiscountPercent,
  WHOLESALE_DISTRIBUTOR: tierDiscountPercent,
  WHOLESALE_MASTER_DISTRIBUTOR: tierDiscountPercent,
  RETAIL: tierDiscountPercent,
});

export type TierDiscountPercentagesOnDisk = z.infer<
  typeof tierDiscountPercentagesValueSchema
>;

// ---------------------------------------------------------------------------
// Per-key registry — useful for a future generic admin UI that needs to
// validate any key by name. For now only one entry; later admin settings
// (late_fee_default, ar_hold_default, etc.) get added here as they ship.
// ---------------------------------------------------------------------------

export const SETTING_KEYS = {
  RESTOCKING_FEE_DEFAULT: 'restocking_fee_default',
  NEGATIVE_INVENTORY_ALLOWED: 'negative_inventory_allowed',
  TIER_DISCOUNT_PERCENTAGES: 'tier_discount_percentages',
} as const;

export const settingValueSchemas: ReadonlyMap<string, z.ZodTypeAny> = new Map<
  string,
  z.ZodTypeAny
>([
  [SETTING_KEYS.RESTOCKING_FEE_DEFAULT, restockingFeeDefaultValueSchema],
  [SETTING_KEYS.NEGATIVE_INVENTORY_ALLOWED, negativeInventoryAllowedValueSchema],
  [SETTING_KEYS.TIER_DISCOUNT_PERCENTAGES, tierDiscountPercentagesValueSchema],
]);
