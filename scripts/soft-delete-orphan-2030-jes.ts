/**
 * One-off remediation: soft-delete the 6 ORPHAN journal entries that
 * mis-credited GL account 2030 (Vendor Credits Available).
 *
 * Background: these JEs were posted by bill payments that selected 2030 as
 * their cash/payment account. Those BillPayment rows were later hard-deleted
 * (smoke/load-test teardown), leaving the JEs behind as orphans — so the
 * normal reverseBillPayment path can't void them (no BillPayment row exists).
 * Per owner decision (2026-05-22), we soft-delete the orphan JEs: every GL
 * report filters `journalEntry.deletedAt = null`, so this removes both legs
 * (CR 2030 + DR 2010) from all balances while preserving the row + an audit
 * trail.
 *
 *   tsx --env-file=.env scripts/soft-delete-orphan-2030-jes.ts          (dry-run)
 *   tsx --env-file=.env scripts/soft-delete-orphan-2030-jes.ts --apply  (executes)
 *
 * Safety rails (script ABORTS, changing nothing, if any fail):
 *   - account 2030 must exist
 *   - the targeted JEs must each be entityType=BillPayment with a MISSING
 *     BillPayment row (true orphans) and not already soft-deleted
 *   - exactly EXPECTED_COUNT of them, summing to EXPECTED_CREDIT on 2030
 * The genuine vendor credit (VCM-2026-02558) is never in scope — it has a
 * live entity row, so it fails the orphan test.
 */
import { AuditAction, PrismaClient } from '../src/generated/tenant';
import { audit } from '../src/lib/audit/audit';

const db = new PrismaClient();
const APPLY = process.argv.includes('--apply');

const EXPECTED_COUNT = 6;
const EXPECTED_CREDIT = 246.8; // $50+$50+$23.40+$50+$23.40+$50

const REASON =
  'Orphan JE remediation: bill payment used account 2030 as the cash source, ' +
  'then the BillPayment was hard-deleted (test residue), leaving this JE orphaned. ' +
  'Soft-deleting to clear the mis-booked credit from 2030. Owner-approved 2026-05-22.';

const CTX = { userId: null, reason: REASON } as const;

async function main() {
  const acct = await db.glAccount.findFirst({ where: { code: '2030' } });
  if (!acct) throw new Error('GL account 2030 not found — aborting.');

  // All live JE lines on 2030, with their parent JE.
  const lines = await db.journalEntryLine.findMany({
    where: { accountId: acct.id, journalEntry: { deletedAt: null } },
    include: { journalEntry: true },
    orderBy: { journalEntry: { postedAt: 'asc' } },
  });

  // Keep only BillPayment-typed JEs whose BillPayment row is GONE (orphans).
  const orphans: { jeId: string; number: string; credit: number; entityId: string }[] = [];
  let liveOrNonBp = 0;
  for (const l of lines) {
    const je = l.journalEntry;
    if (je.entityType !== 'BillPayment') {
      liveOrNonBp++;
      continue;
    }
    const bp = await db.billPayment.findUnique({
      where: { id: je.entityId },
      select: { id: true },
    });
    if (bp) {
      liveOrNonBp++;
      continue;
    }
    orphans.push({
      jeId: je.id,
      number: je.number,
      credit: Number(l.credit),
      entityId: je.entityId,
    });
  }

  const total = orphans.reduce((s, o) => s + o.credit, 0);

  console.log('=== Targets (orphan BillPayment JEs on 2030) ===');
  for (const o of orphans) {
    console.log(`  ${o.number}  CR ${o.credit}  (missing BillPayment ${o.entityId})`);
  }
  console.log(
    `\nFound ${orphans.length} orphan JE(s) totaling ${total}; ` +
      `${liveOrNonBp} other live/non-BillPayment line(s) on 2030 left untouched.`,
  );

  // Hard safety gate.
  if (orphans.length !== EXPECTED_COUNT) {
    console.error(
      `\nABORT: expected ${EXPECTED_COUNT} orphan JEs, found ${orphans.length}. ` +
        'Re-investigate before changing anything.',
    );
    process.exitCode = 1;
    return;
  }
  if (Math.abs(total - EXPECTED_CREDIT) > 0.005) {
    console.error(
      `\nABORT: expected total ${EXPECTED_CREDIT}, found ${total}. ` +
        'Re-investigate before changing anything.',
    );
    process.exitCode = 1;
    return;
  }

  if (!APPLY) {
    console.log('\nDRY RUN — re-run with --apply to soft-delete. Nothing changed.');
    return;
  }

  const now = new Date();
  await db.$transaction(async (tx) => {
    for (const o of orphans) {
      const before = await tx.journalEntry.findUnique({ where: { id: o.jeId } });
      const after = await tx.journalEntry.update({
        where: { id: o.jeId },
        data: { deletedAt: now },
      });
      await audit(tx, {
        action: AuditAction.DELETE,
        entityType: 'JournalEntry',
        entityId: o.jeId,
        before,
        after,
        ctx: CTX,
      });
      console.log(`  ✓ soft-deleted ${o.number} (CR ${o.credit})`);
    }
  });

  console.log(`\nDone. Soft-deleted ${orphans.length} orphan JE(s), clearing ${total} from 2030.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
