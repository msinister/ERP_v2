import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FiscalPeriodStatus, Prisma } from '@/generated/tenant';
import type { PrismaClient } from '@/generated/tenant';
import {
  createAccount,
  getAccount,
  getAccountByCode,
  listAccounts,
  softDeleteAccount,
  updateAccount,
} from '@/server/services/glAccounts';
import { periodCodeForDate } from '@/server/services/fiscalPeriods';
import { post } from '@/lib/gl/post';
import { hasTenantDb, makeClient } from '../helpers/db';

const suite = hasTenantDb ? describe : describe.skip;

const TAG = 'TEST-GLA';

// Deterministic far-future month for the reclassify-gate tests. 2090 is
// unused by other integration files (which sit in 2026/2027/2096-2099),
// so the FiscalPeriod rows we create + hard-close here can't collide with
// another test's posts. wipe() drops them after each test.
const TEST_YEAR = 2090;
function dateInMonth(month: number, day = 15): Date {
  return new Date(Date.UTC(TEST_YEAR, month - 1, day, 12));
}

const SEEDED_ACCOUNTS: ReadonlyArray<{ code: string; name: string; type: string }> = [
  { code: '1110', name: 'Cash / Bank', type: 'ASSET' },
  { code: '1210', name: 'Accounts Receivable', type: 'ASSET' },
  { code: '1310', name: 'Inventory - Main Warehouse', type: 'ASSET' },
  { code: '4100', name: 'Sales Revenue', type: 'REVENUE' },
  { code: '4200', name: 'Shipping Income', type: 'REVENUE' },
  { code: '4300', name: 'Handling Income', type: 'REVENUE' },
  { code: '4500', name: 'Sales Returns', type: 'REVENUE' },
  { code: '4600', name: 'Restocking Fee Income', type: 'REVENUE' },
  { code: '5100', name: 'Cost of Goods Sold', type: 'EXPENSE' },
];

suite('GlAccount service', () => {
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

  // ---------- Seeded accounts ----------

  it('all 9 seeded accounts exist with correct codes, names, types, deletedAt: null', async () => {
    for (const expected of SEEDED_ACCOUNTS) {
      const a = await getAccountByCode(db, expected.code);
      expect(a, `seed code ${expected.code} present`).not.toBeNull();
      expect(a!.name).toBe(expected.name);
      expect(a!.type).toBe(expected.type);
      expect(a!.deletedAt).toBeNull();
    }
  });

  it('listAccounts returns at least the 9 seeded accounts sorted by code', async () => {
    const all = await listAccounts(db);
    const seedCodes = SEEDED_ACCOUNTS.map((a) => a.code);
    const presentSeeds = all.filter((a) => seedCodes.includes(a.code));
    expect(presentSeeds).toHaveLength(9);
    // Sorted by code ascending across the whole list.
    for (let i = 1; i < all.length; i++) {
      expect(all[i].code.localeCompare(all[i - 1].code)).toBeGreaterThanOrEqual(0);
    }
  });

  it('getAccountByCode returns null for missing code', async () => {
    const a = await getAccountByCode(db, `${TAG}-NEVER-USED`);
    expect(a).toBeNull();
  });

  // ---------- Create / update / soft-delete ----------

  it('createAccount happy path', async () => {
    const code = `${TAG}-1500`;
    const created = await createAccount(db, {
      code,
      name: 'Test Inventory Account',
      type: 'ASSET',
    });
    expect(created.code).toBe(code);
    expect(created.name).toBe('Test Inventory Account');
    expect(created.type).toBe('ASSET');
    expect(created.active).toBe(true);
  });

  it('createAccount with duplicate code throws', async () => {
    const code = `${TAG}-DUP`;
    await createAccount(db, { code, name: 'Dup A', type: 'ASSET' });
    await expect(
      createAccount(db, { code, name: 'Dup B', type: 'LIABILITY' }),
    ).rejects.toThrow();
  });

  it('updateAccount can change name + active; type unchanged when omitted; code never changes', async () => {
    const code = `${TAG}-UPD`;
    const created = await createAccount(db, {
      code,
      name: 'Old Name',
      type: 'EXPENSE',
    });
    const updated = await updateAccount(db, created.id, { name: 'New Name', active: false });
    expect(updated.name).toBe('New Name');
    expect(updated.active).toBe(false);
    expect(updated.type).toBe('EXPENSE'); // unchanged — type omitted
    expect(updated.code).toBe(code); // code is not in the update schema
  });

  it('update validation accepts type but strips code', async () => {
    const { updateGlAccountInputSchema } = await import('@/lib/validation/glAccounts');
    // type is now a first-class updatable field.
    const withType = updateGlAccountInputSchema.safeParse({ type: 'ASSET' });
    expect(withType.success).toBe(true);
    if (withType.success) expect(withType.data.type).toBe('ASSET');
    // code stays out of the schema → Zod strips it.
    const withCode = updateGlAccountInputSchema.safeParse({ code: '9999' });
    expect(withCode.success).toBe(true);
    if (withCode.success) expect(Object.keys(withCode.data)).toEqual([]);
  });

  // ---------- Reclassify (type change) gate ----------

  it('reclassifies type when the account has no journal entries', async () => {
    const code = `${TAG}-RC-NONE`;
    const created = await createAccount(db, { code, name: 'Reclass none', type: 'LIABILITY' });
    const updated = await updateAccount(db, created.id, { type: 'ASSET' });
    expect(updated.type).toBe('ASSET');
  });

  it('reclassifies type when referencing JEs sit in OPEN periods', async () => {
    const code = `${TAG}-RC-OPEN`;
    const created = await createAccount(db, { code, name: 'Reclass open', type: 'LIABILITY' });
    const stamp = Date.now();
    await db.$transaction((tx) =>
      post(tx, {
        entityType: TAG,
        entityId: 'rc-open-' + stamp,
        description: 'open-period je ' + stamp,
        postedAt: dateInMonth(3), // auto-creates the period OPEN
        lines: [
          { accountCode: code, debit: '5' },
          { accountCode: '4100', credit: '5' },
        ],
      }),
    );
    const updated = await updateAccount(db, created.id, { type: 'ASSET' });
    expect(updated.type).toBe('ASSET');
  });

  it('blocks type change when a referencing JE sits in a HARD_CLOSED period', async () => {
    const code = `${TAG}-RC-CLOSED`;
    const created = await createAccount(db, { code, name: 'Reclass closed', type: 'LIABILITY' });
    const stamp = Date.now();
    const closedDate = dateInMonth(6);
    await db.$transaction((tx) =>
      post(tx, {
        entityType: TAG,
        entityId: 'rc-closed-' + stamp,
        description: 'closed-period je ' + stamp,
        postedAt: closedDate,
        lines: [
          { accountCode: code, debit: '7' },
          { accountCode: '4100', credit: '7' },
        ],
      }),
    );
    // post() auto-created the period OPEN; flip it to HARD_CLOSED to arm
    // the gate (fixture short-cut — not exercising the close workflow).
    await db.fiscalPeriod.update({
      where: { code: periodCodeForDate(closedDate) },
      data: { status: FiscalPeriodStatus.HARD_CLOSED },
    });
    await expect(updateAccount(db, created.id, { type: 'ASSET' })).rejects.toThrow(
      /hard-closed period/i,
    );
    // The blocked attempt rolled back — type is still LIABILITY.
    const after = await getAccount(db, created.id);
    expect(after!.type).toBe('LIABILITY');
  });

  it('softDeleteAccount when no JE lines reference → succeeds', async () => {
    const code = `${TAG}-DEL-OK`;
    const created = await createAccount(db, {
      code,
      name: 'Deletable',
      type: 'ASSET',
    });
    const deleted = await softDeleteAccount(db, created.id);
    expect(deleted.deletedAt).not.toBeNull();
    const refetch = await getAccount(db, created.id);
    expect(refetch).toBeNull();
  });

  it('softDeleteAccount when active JE lines reference → throws', async () => {
    // Pick a seeded account that gets used by post() — 1210 (AR).
    // Post an event referencing 1210, then try to soft-delete the seed
    // account. Should refuse.
    const ar = (await getAccountByCode(db, '1210'))!;
    const stamp = Date.now();
    await db.$transaction((tx) =>
      post(tx, {
        entityType: TAG,
        entityId: 'block-' + stamp,
        description: 'block delete via active JE',
        lines: [
          { accountCode: '1210', debit: '5' },
          { accountCode: '4100', credit: '5' },
        ],
      }),
    );
    await expect(softDeleteAccount(db, ar.id)).rejects.toThrow(
      /journal entry line\(s\) reference it/,
    );
  });

  it('softDeleteAccount when only reversed JE lines reference → still refuses', async () => {
    // Stub-slice stance is conservative: any JE line counts, including
    // reversed. The GL slice will relax this once period-close rules are
    // in place.
    const ar = (await getAccountByCode(db, '4200'))!; // shipping income
    const stamp = Date.now();
    const je = await db.$transaction((tx) =>
      post(tx, {
        entityType: TAG,
        entityId: 'rev-block-' + stamp,
        description: 'reversed je still blocks',
        lines: [
          { accountCode: '1210', debit: '5' },
          { accountCode: '4200', credit: '5' },
        ],
      }),
    );
    // Mark the JE reversed.
    await db.journalEntry.update({
      where: { id: je.id },
      data: { reversedAt: new Date() },
    });
    await expect(softDeleteAccount(db, ar.id)).rejects.toThrow(
      /journal entry line\(s\) reference it/,
    );
    // Sanity: the throw stub above didn't change the seed account. Avoid
    // unused-var warning.
    void Prisma;
  });
});

async function wipe(db: PrismaClient): Promise<void> {
  // Drop our test JEs first (they hold FKs on GlAccount).
  const ourJes = await db.journalEntry.findMany({
    where: { entityType: TAG },
    select: { id: true },
  });
  if (ourJes.length > 0) {
    const ids = ourJes.map((j) => j.id);
    await db.journalEntryLine.deleteMany({ where: { journalEntryId: { in: ids } } });
    await db.journalEntry.deleteMany({ where: { id: { in: ids } } });
  }
  // Then our test-created accounts and their audit rows.
  const ourAccounts = await db.glAccount.findMany({
    where: { code: { startsWith: TAG } },
    select: { id: true },
  });
  if (ourAccounts.length > 0) {
    const ids = ourAccounts.map((a) => a.id);
    await db.auditLog.deleteMany({
      where: { entityType: 'GlAccount', entityId: { in: ids } },
    });
    await db.glAccount.deleteMany({ where: { id: { in: ids } } });
  }
  // Drop the far-future periods the reclassify-gate tests materialize, so
  // a HARD_CLOSED test period can't leak and block another file's posts.
  // No FK from JournalEntry → FiscalPeriod, and we never run the recon
  // close path here, so there are no dependent rows.
  await db.fiscalPeriod.deleteMany({
    where: { code: { startsWith: `${TEST_YEAR}-` } },
  });
}
