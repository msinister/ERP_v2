import { Prisma } from '@/generated/tenant';
import type { PrismaClient } from '@/generated/tenant';
import {
  tableViewPrefSchema,
  type TableViewPref,
} from '@/lib/validation/preferences';

// =============================================================================
// Per-user preference service. Generic key → JSON store (one row per
// (userId, key)), mirroring the global Setting service but scoped per user.
//
// Unlike getSetting, reads NEVER throw on a missing/corrupt value — a
// personal UI preference should silently fall back to defaults, not break
// the page. Writes are not audited: column-visibility toggles aren't a
// sensitive action.
// =============================================================================

export async function getUserPreference(
  db: PrismaClient,
  userId: string,
  key: string,
): Promise<unknown | null> {
  const row = await db.userPreference.findUnique({
    where: { userId_key: { userId, key } },
    select: { value: true },
  });
  return row?.value ?? null;
}

export async function setUserPreference(
  db: PrismaClient,
  userId: string,
  key: string,
  value: Prisma.InputJsonValue,
): Promise<void> {
  await db.userPreference.upsert({
    where: { userId_key: { userId, key } },
    create: { userId, key, value },
    update: { value },
  });
}

// Typed read for a table-view preference. Returns {} (→ caller applies its
// own defaults) when nothing is saved or the stored shape is unexpected.
export async function getTableViewPref(
  db: PrismaClient,
  userId: string,
  key: string,
): Promise<TableViewPref> {
  const raw = await getUserPreference(db, userId, key);
  if (raw == null) return {};
  const parsed = tableViewPrefSchema.safeParse(raw);
  return parsed.success ? parsed.data : {};
}
