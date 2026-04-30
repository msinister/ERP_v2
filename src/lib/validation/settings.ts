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
// Per-key registry — useful for a future generic admin UI that needs to
// validate any key by name. For now only one entry; later admin settings
// (late_fee_default, ar_hold_default, etc.) get added here as they ship.
// ---------------------------------------------------------------------------

export const SETTING_KEYS = {
  RESTOCKING_FEE_DEFAULT: 'restocking_fee_default',
} as const;

export const settingValueSchemas: ReadonlyMap<string, z.ZodTypeAny> = new Map<
  string,
  z.ZodTypeAny
>([[SETTING_KEYS.RESTOCKING_FEE_DEFAULT, restockingFeeDefaultValueSchema]]);
