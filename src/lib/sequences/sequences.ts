import type { Prisma } from '@/generated/tenant';

// Allocate the next number for a named sequence inside the caller's
// transaction. Uses SELECT ... FOR UPDATE to serialize concurrent allocators
// so monotonic counters stay gap-free under contention.
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

  // Lock the row if it exists; rows.length === 0 means we'll create it below.
  const rows = await tx.$queryRaw<
    Array<{ name: string; currentValue: number; year: number | null }>
  >`SELECT "name", "currentValue", "year" FROM "Sequence" WHERE "name" = ${name} FOR UPDATE`;

  let nextValue: number;
  if (rows.length === 0) {
    nextValue = 1;
    await tx.sequence.create({
      data: { name, currentValue: nextValue, year: currentYear },
    });
  } else {
    const row = rows[0];
    if (useYear && row.year !== currentYear) {
      nextValue = 1;
    } else {
      nextValue = row.currentValue + 1;
    }
    await tx.sequence.update({
      where: { name },
      data: { currentValue: nextValue, year: currentYear },
    });
  }

  const padded = useYear
    ? String(nextValue).padStart(5, '0')
    : String(nextValue).padStart(7, '0');
  const formatted = useYear
    ? `${prefix}-${currentYear}-${padded}`
    : `${prefix}-${padded}`;

  return { value: nextValue, year: currentYear, formatted };
}
