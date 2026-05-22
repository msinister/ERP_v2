/**
 * READ-ONLY diagnostic for GL account 2030 (Vendor Credits Available).
 *
 * Lists the account row and every JournalEntry that touches it (full
 * both-sides view + the fiscal-period status for each JE's postedAt), and
 * computes the net balance under both the current and proposed
 * classification so direction can be reviewed before any reclassify.
 *
 * Writes NOTHING. Run with:
 *   tsx --env-file=.env scripts/inspect-account-2030.ts
 *
 * Context: account 2030 is currently typed LIABILITY. The open question is
 * whether to reclassify it to ASSET ("value owed TO us"). The posting
 * convention (spec docs/07:159) CREDITS 2030 when a vendor credit is
 * issued, so an outstanding credit carries a *credit* balance — which an
 * ASSET classification would render as a NEGATIVE asset. This script
 * surfaces the actual lines so the call can be made on real data.
 */
import { PrismaClient } from '../src/generated/tenant';
import { periodCodeForDate } from '../src/server/services/fiscalPeriods';

const db = new PrismaClient();

const pad = (v: unknown, n: number) => String(v).padStart(n);

async function main() {
  const account = await db.glAccount.findFirst({ where: { code: '2030' } });
  if (!account) {
    console.log('No GL account with code 2030 found.');
    return;
  }

  console.log('=== Account 2030 ===');
  console.log({
    id: account.id,
    code: account.code,
    name: account.name,
    type: account.type,
    active: account.active,
    deletedAt: account.deletedAt,
  });

  // All JEs that have a line on 2030, with both sides for context.
  const lines = await db.journalEntryLine.findMany({
    where: { accountId: account.id },
    select: { journalEntryId: true },
  });
  const jeIds = Array.from(new Set(lines.map((l) => l.journalEntryId)));
  const jes = await db.journalEntry.findMany({
    where: { id: { in: jeIds } },
    include: { lines: { include: { account: true } } },
    orderBy: { postedAt: 'asc' },
  });

  // Resolve fiscal-period status per JE.
  const codes = Array.from(new Set(jes.map((j) => periodCodeForDate(j.postedAt))));
  const periods = await db.fiscalPeriod.findMany({ where: { code: { in: codes } } });
  const statusByCode = new Map(periods.map((p) => [p.code, p.status]));

  console.log(`\n=== ${jes.length} journal entr${jes.length === 1 ? 'y' : 'ies'} touching 2030 ===`);
  let sumDebit = 0;
  let sumCredit = 0;
  for (const je of jes) {
    const code = periodCodeForDate(je.postedAt);
    console.log(
      `\n${je.number}  ${je.postedAt.toISOString().slice(0, 10)}  ` +
        `[${code} ${statusByCode.get(code) ?? 'OPEN (uncreated)'}]  ` +
        `${je.entityType}${je.reversedAt ? '  (REVERSED)' : ''}\n  "${je.description}"`,
    );
    for (const l of je.lines) {
      const is2030 = l.accountId === account.id;
      if (is2030) {
        sumDebit += Number(l.debit);
        sumCredit += Number(l.credit);
      }
      console.log(
        `   ${is2030 ? '>' : ' '} ${l.account.code} ${l.account.name.padEnd(26)}` +
          ` DR ${pad(l.debit, 9)}  CR ${pad(l.credit, 9)}  | ${l.memo ?? ''}`,
      );
    }
  }

  console.log('\n=== Net on 2030 ===');
  console.log(`SUM(debit)  = ${sumDebit}`);
  console.log(`SUM(credit) = ${sumCredit}`);
  console.log(`As LIABILITY (credit - debit) = ${sumCredit - sumDebit}  <- current display`);
  console.log(`As ASSET     (debit - credit) = ${sumDebit - sumCredit}  <- display after reclassify`);

  const hardClosed = jes.filter(
    (j) => statusByCode.get(periodCodeForDate(j.postedAt)) === 'HARD_CLOSED',
  );
  console.log(`\nJEs in a HARD_CLOSED period (would block reclassify): ${hardClosed.length}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
