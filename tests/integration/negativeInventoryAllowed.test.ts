import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@/generated/tenant';
import { setSetting } from '@/server/services/settings';
import {
  SETTING_KEYS,
  negativeInventoryAllowedValueSchema,
} from '@/lib/validation/settings';
import { getNegativeInventoryAllowed } from '@/server/services/negativeInventory';
import { hasTenantDb, makeClient } from '../helpers/db';

const suite = hasTenantDb ? describe : describe.skip;

suite('negativeInventoryAllowed setting', () => {
  let db: PrismaClient;
  let settingId: string;

  beforeAll(async () => {
    db = makeClient();
    const row = await db.setting.findUniqueOrThrow({
      where: { key: SETTING_KEYS.NEGATIVE_INVENTORY_ALLOWED },
      select: { id: true },
    });
    settingId = row.id;
  });

  afterEach(async () => {
    // Reset the seeded row to its original false default so test order
    // doesn't matter.
    await db.setting.update({
      where: { key: SETTING_KEYS.NEGATIVE_INVENTORY_ALLOWED },
      data: { value: { allowed: false } },
    });
    // Scope to THIS setting's audit rows only — an unscoped
    // entityType='Setting' delete would wipe other suites' audit data.
    await db.auditLog.deleteMany({
      where: { entityType: 'Setting', entityId: settingId },
    });
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  it('initial seed returns false', async () => {
    const v = await getNegativeInventoryAllowed(db);
    expect(v).toBe(false);
  });

  it('returns true after setSetting flips it to {allowed: true}', async () => {
    await setSetting(
      db,
      SETTING_KEYS.NEGATIVE_INVENTORY_ALLOWED,
      { allowed: true },
      negativeInventoryAllowedValueSchema,
    );
    const v = await getNegativeInventoryAllowed(db);
    expect(v).toBe(true);
  });

  it('returns false after flipping back to {allowed: false}', async () => {
    await setSetting(
      db,
      SETTING_KEYS.NEGATIVE_INVENTORY_ALLOWED,
      { allowed: true },
      negativeInventoryAllowedValueSchema,
    );
    expect(await getNegativeInventoryAllowed(db)).toBe(true);

    await setSetting(
      db,
      SETTING_KEYS.NEGATIVE_INVENTORY_ALLOWED,
      { allowed: false },
      negativeInventoryAllowedValueSchema,
    );
    expect(await getNegativeInventoryAllowed(db)).toBe(false);
  });
});
