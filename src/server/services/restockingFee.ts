import { Prisma } from '@/generated/tenant';
import type { PrismaClient } from '@/generated/tenant';
import type { AuditContext } from '@/lib/audit/audit';
import {
  SETTING_KEYS,
  restockingFeeDefaultValueSchema,
} from '@/lib/validation/settings';
import { getSetting, setSetting } from './settings';

// =============================================================================
// Restocking fee default — first concrete consumer of the Setting model.
//
// Storage shape is { percent: string|null, flat: string|null } per the
// Decimal-as-string convention; this wrapper exposes Decimal at the
// runtime API boundary. RMA-level overrides flow through resolveRestockingFee
// at credit-memo confirmation time.
// =============================================================================

export type RestockingFeeRuntime = {
  percent: Prisma.Decimal | null;
  flat: Prisma.Decimal | null;
};

export type ResolvedRestockingFee = RestockingFeeRuntime & {
  source: 'rma_override' | 'default' | 'none';
};

function toRuntime(onDisk: { percent: string | null; flat: string | null }): RestockingFeeRuntime {
  return {
    percent: onDisk.percent != null ? new Prisma.Decimal(onDisk.percent) : null,
    flat: onDisk.flat != null ? new Prisma.Decimal(onDisk.flat) : null,
  };
}

export async function getRestockingFeeDefault(
  db: PrismaClient,
): Promise<RestockingFeeRuntime> {
  const onDisk = await getSetting(
    db,
    SETTING_KEYS.RESTOCKING_FEE_DEFAULT,
    restockingFeeDefaultValueSchema,
  );
  return toRuntime(onDisk);
}

export async function setRestockingFeeDefault(
  db: PrismaClient,
  input: { percent?: Prisma.Decimal | string | number | null; flat?: Prisma.Decimal | string | number | null },
  ctx?: AuditContext,
): Promise<RestockingFeeRuntime> {
  // Convert input to the on-disk string-or-null shape. Missing keys
  // become null — set REPLACES the prior value, never merges.
  const toOnDiskString = (
    v: Prisma.Decimal | string | number | null | undefined,
  ): string | null => {
    if (v == null) return null;
    if (v instanceof Prisma.Decimal) return v.toString();
    return new Prisma.Decimal(v).toString();
  };
  const onDisk = {
    percent: toOnDiskString(input.percent),
    flat: toOnDiskString(input.flat),
  };
  // setSetting validates the on-disk shape (XOR + ranges) and audits.
  const stored = await setSetting(
    db,
    SETTING_KEYS.RESTOCKING_FEE_DEFAULT,
    onDisk,
    restockingFeeDefaultValueSchema,
    ctx,
  );
  return toRuntime(stored);
}

/**
 * Pure function — no DB. Resolves the effective restocking fee for an
 * RMA confirmation given the RMA-level override (read from the Rma
 * row's restockingFeePercent / restockingFeeFlat columns) and the
 * admin default (read from getRestockingFeeDefault).
 *
 * Precedence:
 *   - RMA override wins if it has at least one non-null field —
 *     including flat=0 ("explicit zero is a real override, not a
 *     fall-through-to-default")
 *   - Default applies when override is null OR has both fields null
 *   - source='none' when both override and default carry no fee
 */
export function resolveRestockingFee(
  override: { percent: Prisma.Decimal | null; flat: Prisma.Decimal | null } | null,
  defaults: RestockingFeeRuntime,
): ResolvedRestockingFee {
  if (override && (override.percent != null || override.flat != null)) {
    return {
      percent: override.percent,
      flat: override.flat,
      source: 'rma_override',
    };
  }
  if (defaults.percent != null || defaults.flat != null) {
    return {
      percent: defaults.percent,
      flat: defaults.flat,
      source: 'default',
    };
  }
  return { percent: null, flat: null, source: 'none' };
}
