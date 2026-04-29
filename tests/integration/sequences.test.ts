import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@/generated/tenant';
import { getNextSequence } from '@/lib/sequences/sequences';
import { hasTenantDb, makeClient } from '../helpers/db';

const suite = hasTenantDb ? describe : describe.skip;

suite('getNextSequence', () => {
  let db: PrismaClient;
  const TEST_NAME = 'test_sequence_unit';
  const TEST_NAME_NOYEAR = 'test_sequence_noyear';
  const TEST_NAME_CONC = 'test_sequence_concurrent';

  beforeAll(async () => {
    db = makeClient();
  });

  beforeEach(async () => {
    await db.sequence.deleteMany({
      where: { name: { in: [TEST_NAME, TEST_NAME_NOYEAR, TEST_NAME_CONC] } },
    });
  });

  afterAll(async () => {
    await db.sequence.deleteMany({
      where: { name: { in: [TEST_NAME, TEST_NAME_NOYEAR, TEST_NAME_CONC] } },
    });
    await db.$disconnect();
  });

  it('formats annual sequence as PREFIX-YYYY-NNNNN, starting at 1, monotonic', async () => {
    const a = await db.$transaction((tx) =>
      getNextSequence(tx, { name: TEST_NAME, prefix: 'PO', useYear: true, now: new Date(Date.UTC(2026, 0, 5)) }),
    );
    const b = await db.$transaction((tx) =>
      getNextSequence(tx, { name: TEST_NAME, prefix: 'PO', useYear: true, now: new Date(Date.UTC(2026, 5, 5)) }),
    );
    const c = await db.$transaction((tx) =>
      getNextSequence(tx, { name: TEST_NAME, prefix: 'PO', useYear: true, now: new Date(Date.UTC(2026, 11, 31)) }),
    );

    expect(a.formatted).toBe('PO-2026-00001');
    expect(b.formatted).toBe('PO-2026-00002');
    expect(c.formatted).toBe('PO-2026-00003');
  });

  it('resets to 1 when year rolls over', async () => {
    await db.$transaction((tx) =>
      getNextSequence(tx, { name: TEST_NAME, prefix: 'PO', useYear: true, now: new Date(Date.UTC(2026, 11, 31)) }),
    );
    await db.$transaction((tx) =>
      getNextSequence(tx, { name: TEST_NAME, prefix: 'PO', useYear: true, now: new Date(Date.UTC(2026, 11, 31)) }),
    );

    const rolled = await db.$transaction((tx) =>
      getNextSequence(tx, { name: TEST_NAME, prefix: 'PO', useYear: true, now: new Date(Date.UTC(2027, 0, 1)) }),
    );

    expect(rolled.formatted).toBe('PO-2027-00001');
    expect(rolled.value).toBe(1);
    expect(rolled.year).toBe(2027);
  });

  it('non-annual sequence pads to 7 digits and never resets', async () => {
    const a = await db.$transaction((tx) =>
      getNextSequence(tx, { name: TEST_NAME_NOYEAR, prefix: 'X', useYear: false }),
    );
    const b = await db.$transaction((tx) =>
      getNextSequence(tx, { name: TEST_NAME_NOYEAR, prefix: 'X', useYear: false }),
    );

    expect(a.formatted).toBe('X-0000001');
    expect(b.formatted).toBe('X-0000002');
    expect(a.year).toBeNull();
  });

  it('serializes concurrent allocators — no duplicates, no gaps', async () => {
    const N = 10;
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        db.$transaction((tx) =>
          getNextSequence(tx, {
            name: TEST_NAME_CONC,
            prefix: 'CONC',
            useYear: true,
            now: new Date(Date.UTC(2026, 0, 1)),
          }),
        ),
      ),
    );

    const values = results.map((r) => r.value).sort((x, y) => x - y);
    expect(values).toEqual(Array.from({ length: N }, (_, i) => i + 1));
    const formatted = new Set(results.map((r) => r.formatted));
    expect(formatted.size).toBe(N);
  });
});
