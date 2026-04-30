import { AuditAction, Prisma } from '@/generated/tenant';
import type { PrismaClient, Setting } from '@/generated/tenant';
import type { z } from 'zod';
import { audit, type AuditContext } from '@/lib/audit/audit';

/**
 * Generic Setting service. Setting is the home for admin-configurable
 * single values (restocking-fee default, late-fee %, AR-hold default,
 * negative-inventory toggle, etc.). Each key has its own Zod schema
 * declared in src/lib/validation/settings.ts; the schema operates on
 * the ON-DISK shape (strings for Decimals, primitives for everything
 * else). Per-key wrapper services own the runtime ↔ on-disk
 * conversion at the boundary.
 *
 * STORAGE CONVENTION: Decimals serialize as strings via
 * Prisma.Decimal.toString(). New setting schemas MUST follow the
 * same convention so JSON round-trips through Postgres without
 * precision loss.
 *
 * Don't bypass these helpers — every read of a Setting goes through
 * getSetting (so corrupted JSON throws immediately rather than
 * silently returning broken data) and every write through setSetting
 * (which validates first, audits the change with before/after).
 */

export async function getSetting<T>(
  db: PrismaClient,
  key: string,
  valueSchema: z.ZodType<T>,
): Promise<T> {
  const row = await db.setting.findUnique({ where: { key } });
  if (!row) {
    throw new Error(`Setting not found: ${key}`);
  }
  const parsed = valueSchema.safeParse(row.value);
  if (!parsed.success) {
    // Corruption / shape drift — surface immediately, don't return a
    // silent default. Every issue from Zod is included so the operator
    // can fix the row.
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`Setting '${key}' value failed schema validation: ${issues}`);
  }
  return parsed.data;
}

export async function setSetting<T>(
  db: PrismaClient,
  key: string,
  value: T,
  valueSchema: z.ZodType<T>,
  ctx?: AuditContext,
): Promise<T> {
  // Validate first — refuse to write a malformed value even if the
  // caller insists. The parsed payload is what gets stored, so any
  // transforms in the schema are applied.
  const parsed = valueSchema.parse(value);
  return db.$transaction(async (tx) => {
    const before = await tx.setting.findUnique({ where: { key } });
    const after = await tx.setting.upsert({
      where: { key },
      create: {
        key,
        value: parsed as Prisma.InputJsonValue,
        updatedBy: ctx?.userId ?? null,
      },
      update: {
        value: parsed as Prisma.InputJsonValue,
        updatedBy: ctx?.userId ?? null,
      },
    });
    await audit(tx, {
      action: AuditAction.UPDATE,
      entityType: 'Setting',
      entityId: after.id,
      before: before ?? undefined,
      after,
      ctx,
    });
    return parsed;
  });
}

export async function listSettings(db: PrismaClient): Promise<Setting[]> {
  return db.setting.findMany({ orderBy: { key: 'asc' } });
}
