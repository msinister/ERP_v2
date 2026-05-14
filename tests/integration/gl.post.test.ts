import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Prisma } from '@/generated/tenant';
import type { PrismaClient } from '@/generated/tenant';
import { post } from '@/lib/gl/post';
import { hasTenantDb, makeClient } from '../helpers/db';

const suite = hasTenantDb ? describe : describe.skip;

const TAG = 'TEST-GLP';

suite('lib/gl/post helper', () => {
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

  // ---------- Balance + line shape ----------

  it('balanced 2-line JE: debits == credits → succeeds', async () => {
    const je = await db.$transaction((tx) =>
      post(tx, {
        entityType: TAG,
        entityId: 'b2-' + Date.now(),
        description: 'balanced 2-line',
        lines: [
          { accountCode: '1210', debit: '100.00' },
          { accountCode: '4100', credit: '100.00' },
        ],
      }),
    );
    // Pad is 5 digits, but overflow past 99999 is not truncated — accept
    // 5+ digits so the test survives once a year's sequence rolls past
    // 100000 (already reached in dev DBs with heavy test history).
    expect(je.number).toMatch(/^JE-\d{4}-\d{5,}$/);
    expect(je.lines).toHaveLength(2);
    const debitTotal = je.lines.reduce(
      (acc, l) => acc.plus(l.debit),
      new Prisma.Decimal(0),
    );
    const creditTotal = je.lines.reduce(
      (acc, l) => acc.plus(l.credit),
      new Prisma.Decimal(0),
    );
    expect(debitTotal.toString()).toBe(creditTotal.toString());
    expect(debitTotal.toString()).toBe(new Prisma.Decimal('100').toString());
  });

  it('balanced 4-line JE: 2 debits + 2 credits, summed → succeeds', async () => {
    const je = await db.$transaction((tx) =>
      post(tx, {
        entityType: TAG,
        entityId: 'b4-' + Date.now(),
        description: 'balanced 4-line',
        lines: [
          { accountCode: '1210', debit: '60' }, // AR (gross)
          { accountCode: '1210', debit: '5' }, // AR (shipping)
          { accountCode: '4100', credit: '60' }, // Sales Revenue
          { accountCode: '4200', credit: '5' }, // Shipping Income
        ],
      }),
    );
    expect(je.lines).toHaveLength(4);
  });

  it('unbalanced JE → throws naming the imbalance', async () => {
    await expect(
      db.$transaction((tx) =>
        post(tx, {
          entityType: TAG,
          entityId: 'unb-' + Date.now(),
          description: 'unbalanced',
          lines: [
            { accountCode: '1210', debit: '100.00' },
            { accountCode: '4100', credit: '99.99' },
          ],
        }),
      ),
    ).rejects.toThrow(/JE not balanced.*debits=100.*credits=99\.99.*difference=0\.01/);
  });

  it('both debit AND credit on same line → throws (XOR violation)', async () => {
    await expect(
      db.$transaction((tx) =>
        post(tx, {
          entityType: TAG,
          entityId: 'xor1-' + Date.now(),
          description: 'xor both',
          lines: [
            { accountCode: '1210', debit: '50', credit: '50' },
            { accountCode: '4100', credit: '50' },
          ],
        }),
      ),
    ).rejects.toThrow(/BOTH debit and credit non-zero/);
  });

  it('both debit AND credit zero on same line → throws', async () => {
    await expect(
      db.$transaction((tx) =>
        post(tx, {
          entityType: TAG,
          entityId: 'xor0-' + Date.now(),
          description: 'xor zero',
          lines: [
            { accountCode: '1210' }, // both default 0
            { accountCode: '4100', credit: '50' },
          ],
        }),
      ),
    ).rejects.toThrow(/BOTH debit and credit zero/);
  });

  it('negative debit → throws', async () => {
    await expect(
      db.$transaction((tx) =>
        post(tx, {
          entityType: TAG,
          entityId: 'neg-' + Date.now(),
          description: 'negative',
          lines: [
            { accountCode: '1210', debit: '-50' },
            { accountCode: '4100', credit: '-50' },
          ],
        }),
      ),
    ).rejects.toThrow(/negative amount/);
  });

  // ---------- Account lookup ----------

  it('unknown account code → throws naming the missing code', async () => {
    await expect(
      db.$transaction((tx) =>
        post(tx, {
          entityType: TAG,
          entityId: 'unk-' + Date.now(),
          description: 'unknown code',
          lines: [
            { accountCode: '1210', debit: '50' },
            { accountCode: '9999', credit: '50' },
          ],
        }),
      ),
    ).rejects.toThrow(/GL account not found.*code=9999/);
  });

  it('soft-deleted account → throws naming the missing code', async () => {
    // Create + soft-delete a throwaway account, then try to post against it.
    const stamp = Date.now();
    const code = `${TAG}-DEL-${stamp}`;
    const acct = await db.glAccount.create({
      data: { code, name: 'Throwaway', type: 'ASSET' },
    });
    await db.glAccount.update({
      where: { id: acct.id },
      data: { deletedAt: new Date() },
    });
    await expect(
      db.$transaction((tx) =>
        post(tx, {
          entityType: TAG,
          entityId: 'sd-' + stamp,
          description: 'soft-deleted code',
          lines: [
            { accountCode: code, debit: '10' },
            { accountCode: '4100', credit: '10' },
          ],
        }),
      ),
    ).rejects.toThrow(new RegExp(`GL account not found.*code=${TAG}-DEL-${stamp}`));
  });

  // ---------- Numbering + idempotency ----------

  it('JE numbers are JE-YYYY-NNNNN monotonic', async () => {
    const a = await db.$transaction((tx) =>
      post(tx, {
        entityType: TAG,
        entityId: 'mon-a-' + Date.now(),
        description: 'mon a',
        lines: [
          { accountCode: '1210', debit: '1' },
          { accountCode: '4100', credit: '1' },
        ],
      }),
    );
    const b = await db.$transaction((tx) =>
      post(tx, {
        entityType: TAG,
        entityId: 'mon-b-' + Date.now(),
        description: 'mon b',
        lines: [
          { accountCode: '1210', debit: '2' },
          { accountCode: '4100', credit: '2' },
        ],
      }),
    );
    const [, yearA, seqA] = a.number.match(/^JE-(\d{4})-(\d{5,})$/)!;
    const [, yearB, seqB] = b.number.match(/^JE-(\d{4})-(\d{5,})$/)!;
    expect(yearA).toBe(yearB);
    expect(parseInt(seqB, 10)).toBeGreaterThan(parseInt(seqA, 10));
  });

  it('idempotency: same (entityType, entityId, description) twice → second throws naming existing JE', async () => {
    const id = 'idem-' + Date.now();
    const first = await db.$transaction((tx) =>
      post(tx, {
        entityType: TAG,
        entityId: id,
        description: 'idem desc',
        lines: [
          { accountCode: '1210', debit: '1' },
          { accountCode: '4100', credit: '1' },
        ],
      }),
    );
    await expect(
      db.$transaction((tx) =>
        post(tx, {
          entityType: TAG,
          entityId: id,
          description: 'idem desc',
          lines: [
            { accountCode: '1210', debit: '1' },
            { accountCode: '4100', credit: '1' },
          ],
        }),
      ),
    ).rejects.toThrow(new RegExp(`already posted.*existing=${first.number}`));
  });

  it('reversal allowed: prior JE with reversedAt set → fresh post succeeds', async () => {
    const id = 'rev-' + Date.now();
    const first = await db.$transaction((tx) =>
      post(tx, {
        entityType: TAG,
        entityId: id,
        description: 'rev desc',
        lines: [
          { accountCode: '1210', debit: '1' },
          { accountCode: '4100', credit: '1' },
        ],
      }),
    );
    // Mark the first JE as reversed.
    await db.journalEntry.update({
      where: { id: first.id },
      data: { reversedAt: new Date() },
    });
    // A fresh post for the same event now succeeds.
    const second = await db.$transaction((tx) =>
      post(tx, {
        entityType: TAG,
        entityId: id,
        description: 'rev desc',
        lines: [
          { accountCode: '1210', debit: '1' },
          { accountCode: '4100', credit: '1' },
        ],
      }),
    );
    expect(second.id).not.toBe(first.id);
    expect(second.number).not.toBe(first.number);
  });

  // ---------- Decimal precision ----------

  it('Decimal precision: amounts like 12.34567 round-trip exactly', async () => {
    const stamp = Date.now();
    const je = await db.$transaction((tx) =>
      post(tx, {
        entityType: TAG,
        entityId: 'dp-' + stamp,
        description: 'precision check',
        lines: [
          { accountCode: '1210', debit: '12.34567' },
          { accountCode: '4100', credit: '12.34567' },
        ],
      }),
    );
    const dr = je.lines.find((l) => l.debit.greaterThan(0))!;
    expect(dr.debit.toString()).toBe(new Prisma.Decimal('12.34567').toString());
  });

  // ---------- Concurrency ----------

  it('two parallel posts with different entities serialize cleanly (no sequence collision)', async () => {
    const stamp = Date.now();
    const results = await Promise.allSettled([
      db.$transaction((tx) =>
        post(tx, {
          entityType: TAG,
          entityId: 'par-a-' + stamp,
          description: 'par a',
          lines: [
            { accountCode: '1210', debit: '10' },
            { accountCode: '4100', credit: '10' },
          ],
        }),
      ),
      db.$transaction((tx) =>
        post(tx, {
          entityType: TAG,
          entityId: 'par-b-' + stamp,
          description: 'par b',
          lines: [
            { accountCode: '1210', debit: '20' },
            { accountCode: '4100', credit: '20' },
          ],
        }),
      ),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled).toHaveLength(2);
    const numbers = fulfilled.map(
      (r) => (r as PromiseFulfilledResult<{ number: string }>).value.number,
    );
    expect(new Set(numbers).size).toBe(2); // no collision
  });
});

async function wipe(db: PrismaClient): Promise<void> {
  // Tear down only the JEs and lines this suite created, scoped by
  // entityType=TAG. Leaves the seeded GlAccount rows alone — they're
  // shared with other tests and the production schema.
  const ourJes = await db.journalEntry.findMany({
    where: { entityType: TAG },
    select: { id: true },
  });
  if (ourJes.length > 0) {
    const ids = ourJes.map((j) => j.id);
    await db.journalEntryLine.deleteMany({ where: { journalEntryId: { in: ids } } });
    await db.journalEntry.deleteMany({ where: { id: { in: ids } } });
  }
  // Drop any throwaway accounts the soft-delete test created.
  await db.glAccount.deleteMany({ where: { code: { startsWith: `${TAG}-DEL-` } } });
}
