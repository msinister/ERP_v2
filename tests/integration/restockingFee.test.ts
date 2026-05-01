import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Prisma } from '@/generated/tenant';
import type { PrismaClient } from '@/generated/tenant';
import {
  getRestockingFeeDefault,
  resolveRestockingFee,
  setRestockingFeeDefault,
} from '@/server/services/restockingFee';
import { hasTenantDb, makeClient } from '../helpers/db';

const suite = hasTenantDb ? describe : describe.skip;

suite('restockingFee service', () => {
  let db: PrismaClient;
  let restockingFeeSettingId: string;

  beforeAll(async () => {
    db = makeClient();
    const row = await db.setting.findUniqueOrThrow({
      where: { key: 'restocking_fee_default' },
      select: { id: true },
    });
    restockingFeeSettingId = row.id;
  });

  afterEach(async () => {
    // Reset the seeded row to its original empty state so test order
    // doesn't matter.
    await db.setting.update({
      where: { key: 'restocking_fee_default' },
      data: { value: { percent: null, flat: null } },
    });
    // Scope to THIS setting's audit rows only — an unscoped
    // entityType='Setting' delete would wipe other suites' audit data.
    await db.auditLog.deleteMany({
      where: { entityType: 'Setting', entityId: restockingFeeSettingId },
    });
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  // ---------- Get / set ----------

  it('initial seed returns { percent: null, flat: null }', async () => {
    const v = await getRestockingFeeDefault(db);
    expect(v.percent).toBeNull();
    expect(v.flat).toBeNull();
  });

  it('set { percent: 10 } reads back as { percent: 10, flat: null }', async () => {
    await setRestockingFeeDefault(db, { percent: '10' });
    const v = await getRestockingFeeDefault(db);
    expect(v.percent?.toString()).toBe(new Prisma.Decimal('10').toString());
    expect(v.flat).toBeNull();
  });

  it('set { flat: 5 } after set { percent: 10 } REPLACES (does not merge) — prior percent is null', async () => {
    await setRestockingFeeDefault(db, { percent: '10' });
    await setRestockingFeeDefault(db, { flat: '5' });
    const v = await getRestockingFeeDefault(db);
    expect(v.percent).toBeNull();
    expect(v.flat?.toString()).toBe(new Prisma.Decimal('5').toString());
  });

  it('set with both percent AND flat throws (cross-field XOR)', async () => {
    await expect(
      setRestockingFeeDefault(db, { percent: '10', flat: '5' }),
    ).rejects.toThrow();
  });

  it('set with negative flat throws', async () => {
    await expect(setRestockingFeeDefault(db, { flat: '-1' })).rejects.toThrow();
  });

  it('set with percent > 100 throws', async () => {
    await expect(setRestockingFeeDefault(db, { percent: '150' })).rejects.toThrow();
  });

  it('set with percent at boundaries (0 and 100) succeeds', async () => {
    await setRestockingFeeDefault(db, { percent: '0' });
    let v = await getRestockingFeeDefault(db);
    expect(v.percent?.toString()).toBe(new Prisma.Decimal('0').toString());
    await setRestockingFeeDefault(db, { percent: '100' });
    v = await getRestockingFeeDefault(db);
    expect(v.percent?.toString()).toBe(new Prisma.Decimal('100').toString());
  });

  // ---------- resolveRestockingFee (pure) ----------

  it('null override + default {percent: 10} → uses default, source=default', async () => {
    const r = resolveRestockingFee(null, {
      percent: new Prisma.Decimal('10'),
      flat: null,
    });
    expect(r.source).toBe('default');
    expect(r.percent?.toString()).toBe(new Prisma.Decimal('10').toString());
    expect(r.flat).toBeNull();
  });

  it('override {percent: 5} + default {percent: 10} → override wins, source=rma_override', async () => {
    const r = resolveRestockingFee(
      { percent: new Prisma.Decimal('5'), flat: null },
      { percent: new Prisma.Decimal('10'), flat: null },
    );
    expect(r.source).toBe('rma_override');
    expect(r.percent?.toString()).toBe(new Prisma.Decimal('5').toString());
    expect(r.flat).toBeNull();
  });

  it('null override + default of all-nulls → source=none', async () => {
    const r = resolveRestockingFee(null, { percent: null, flat: null });
    expect(r.source).toBe('none');
    expect(r.percent).toBeNull();
    expect(r.flat).toBeNull();
  });

  it('override {flat: 0} + default {percent: 10} → override wins (explicit zero is a real override)', async () => {
    const r = resolveRestockingFee(
      { percent: null, flat: new Prisma.Decimal('0') },
      { percent: new Prisma.Decimal('10'), flat: null },
    );
    expect(r.source).toBe('rma_override');
    expect(r.percent).toBeNull();
    expect(r.flat?.toString()).toBe(new Prisma.Decimal('0').toString());
  });

  it('override {percent: null, flat: null} + default {percent: 10} → falls through to default', async () => {
    const r = resolveRestockingFee(
      { percent: null, flat: null },
      { percent: new Prisma.Decimal('10'), flat: null },
    );
    expect(r.source).toBe('default');
    expect(r.percent?.toString()).toBe(new Prisma.Decimal('10').toString());
  });
});
