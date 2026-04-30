import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AuditAction } from '@/generated/tenant';
import type { PrismaClient } from '@/generated/tenant';
import {
  getSetting,
  listSettings,
  setSetting,
} from '@/server/services/settings';
import { hasTenantDb, makeClient } from '../helpers/db';

const suite = hasTenantDb ? describe : describe.skip;

// Test-only setting key + schema. Doesn't touch the real registry; we
// just exercise the generic helpers.
const TEST_KEY = 'TEST_SETTINGS_HELPER';
const testSchema = z.object({
  flag: z.boolean(),
  count: z.number().int().min(0),
});

suite('settings service — generic getSetting / setSetting', () => {
  let db: PrismaClient;

  beforeAll(async () => {
    db = makeClient();
  });

  beforeEach(async () => {
    await wipe(db);
  });

  afterAll(async () => {
    await wipe(db);
    await db.$disconnect();
  });

  it('getSetting on missing key throws specific error', async () => {
    await expect(
      getSetting(db, TEST_KEY, testSchema),
    ).rejects.toThrow(new RegExp(`Setting not found: ${TEST_KEY}`));
  });

  it('setSetting + getSetting round-trip', async () => {
    await setSetting(db, TEST_KEY, { flag: true, count: 7 }, testSchema);
    const value = await getSetting(db, TEST_KEY, testSchema);
    expect(value).toEqual({ flag: true, count: 7 });
  });

  it('getSetting on row with corrupted JSON throws schema validation error', async () => {
    // Write a row directly with a malformed value (skipping setSetting's
    // pre-write validation) so getSetting's read-side check fires.
    await db.setting.upsert({
      where: { key: TEST_KEY },
      create: { key: TEST_KEY, value: { flag: 'not-a-boolean', count: -5 } },
      update: { value: { flag: 'not-a-boolean', count: -5 } },
    });
    await expect(
      getSetting(db, TEST_KEY, testSchema),
    ).rejects.toThrow(/value failed schema validation/);
  });

  it('setSetting writes UPDATE audit row with before/after', async () => {
    await setSetting(db, TEST_KEY, { flag: false, count: 1 }, testSchema);
    await setSetting(db, TEST_KEY, { flag: true, count: 2 }, testSchema);
    const row = await db.setting.findUniqueOrThrow({ where: { key: TEST_KEY } });
    const audits = await db.auditLog.findMany({
      where: { entityType: 'Setting', entityId: row.id },
      orderBy: { createdAt: 'asc' },
    });
    // Two setSetting calls → two UPDATE audit rows. The first call's
    // `before` is null (no row existed); the second's `before` is the
    // row from after-call-1.
    expect(audits).toHaveLength(2);
    expect(audits[0].action).toBe(AuditAction.UPDATE);
    expect(audits[1].action).toBe(AuditAction.UPDATE);
    const after2 = audits[1].afterJson as { value?: { count?: number } };
    expect(after2.value?.count).toBe(2);
  });

  it('setSetting bumps updatedAt via @updatedAt', async () => {
    await setSetting(db, TEST_KEY, { flag: false, count: 1 }, testSchema);
    const row1 = await db.setting.findUniqueOrThrow({ where: { key: TEST_KEY } });
    await new Promise((r) => setTimeout(r, 10));
    await setSetting(db, TEST_KEY, { flag: true, count: 2 }, testSchema);
    const row2 = await db.setting.findUniqueOrThrow({ where: { key: TEST_KEY } });
    expect(row2.updatedAt.getTime()).toBeGreaterThan(row1.updatedAt.getTime());
  });

  it('listSettings returns all rows sorted by key', async () => {
    await setSetting(db, `${TEST_KEY}_B`, { flag: true, count: 1 }, testSchema);
    await setSetting(db, `${TEST_KEY}_A`, { flag: true, count: 1 }, testSchema);
    const all = await listSettings(db);
    const ours = all.filter((s) => s.key.startsWith(TEST_KEY));
    const sortedKeys = [...ours].sort((a, b) => a.key.localeCompare(b.key));
    expect(ours.map((s) => s.key)).toEqual(sortedKeys.map((s) => s.key));
  });
});

async function wipe(db: PrismaClient): Promise<void> {
  const ours = await db.setting.findMany({
    where: { key: { startsWith: TEST_KEY } },
    select: { id: true },
  });
  if (ours.length > 0) {
    const ids = ours.map((s) => s.id);
    await db.auditLog.deleteMany({
      where: { entityType: 'Setting', entityId: { in: ids } },
    });
    await db.setting.deleteMany({ where: { id: { in: ids } } });
  }
}
