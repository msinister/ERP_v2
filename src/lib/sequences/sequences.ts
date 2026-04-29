import type { Prisma } from '@/generated/tenant';

// Allocate the next number for a named sequence inside the caller's
// transaction. Uses SELECT ... FOR UPDATE to serialize concurrent allocators
// so monotonic counters stay gap-free under contention.
//
// First-allocation race: SELECT FOR UPDATE on a missing row locks nothing,
// so two parallel callers can both see no row and race to INSERT. We do an
// idempotent INSERT ... ON CONFLICT DO NOTHING up front, then re-SELECT
// FOR UPDATE to take the row lock from whichever side won.
//
// Format: when useYear → `${prefix}-${year}-${nnnnn}` (5-digit pad, annual reset).
//         else        → `${prefix}-${nnnnnnn}` (7-digit pad).
export async function getNextSequence(
  tx: Prisma.TransactionClient,
  args: { name: string; prefix: string; useYear: boolean; now?: Date },
): Promise<{ value: number; year: number | null; formatted: string }> {
  const { name, prefix, useYear } = args;
  const now = args.now ?? new Date();
  const currentYear = useYear ? now.getUTCFullYear() : null;

  // Idempotent seed — does nothing if the row already exists. We start at
  // currentValue=0 so the first FOR UPDATE branch increments to 1.
  await tx.$executeRaw`
    INSERT INTO "Sequence" ("name", "currentValue", "year", "updatedAt")
    VALUES (${name}, 0, ${currentYear}, NOW())
    ON CONFLICT ("name") DO NOTHING
  `;

  const rows = await tx.$queryRaw<
    Array<{ name: string; currentValue: number; year: number | null }>
  >`SELECT "name", "currentValue", "year" FROM "Sequence" WHERE "name" = ${name} FOR UPDATE`;
  if (rows.length === 0) {
    // Should not happen — we just inserted (or it already existed).
    throw new Error(`Sequence row missing after seed: ${name}`);
  }
  const row = rows[0];

  let nextValue: number;
  if (useYear && row.year !== currentYear) {
    nextValue = 1;
  } else {
    nextValue = row.currentValue + 1;
  }
  await tx.sequence.update({
    where: { name },
    data: { currentValue: nextValue, year: currentYear },
  });

  const padded = useYear
    ? String(nextValue).padStart(5, '0')
    : String(nextValue).padStart(7, '0');
  const formatted = useYear
    ? `${prefix}-${currentYear}-${padded}`
    : `${prefix}-${padded}`;

  return { value: nextValue, year: currentYear, formatted };
}
