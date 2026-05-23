/**
 * One-off: create GL account 1510 "Vendor Deposits".
 *
 * The ASSET account that PO direct-payments (prepay / import deposits) post
 * to: recording a deposit DR 1510 / CR <cashAccount>; applying a deposit to
 * a bill DR 2010 AP / CR 1510. Distinct from 1410 "Vendor Credits" — deposits
 * are prepayments against specific POs, credits are vendor-owed balances.
 *
 *   tsx --env-file=.env scripts/create-vendor-deposits-account.ts          (dry-run)
 *   tsx --env-file=.env scripts/create-vendor-deposits-account.ts --apply  (executes)
 *
 * Idempotent: skips if 1510 already exists. Aborts if 1510 is taken by a
 * different account name.
 */
import { PrismaClient } from '../src/generated/tenant';
import { createAccount, getAccountByCode } from '../src/server/services/glAccounts';

const db = new PrismaClient();
const APPLY = process.argv.includes('--apply');

const CODE = '1510';
const NAME = 'Vendor Deposits';
const TYPE = 'ASSET' as const;

const CTX = {
  userId: null,
  reason:
    'Create Vendor Deposits asset account for PO direct-payments / prepay ' +
    'deposits (DR 1510 / CR cash on record; DR AP / CR 1510 on apply). ' +
    'Owner-approved 2026-05-22.',
} as const;

async function main() {
  const existing = await db.glAccount.findFirst({ where: { code: CODE } });
  if (existing) {
    if (existing.name !== NAME) {
      console.error(
        `ABORT: code ${CODE} already exists with a different name "${existing.name}".`,
      );
      process.exitCode = 1;
      return;
    }
    console.log(`Account ${CODE} "${NAME}" already exists — nothing to do.`);
    return;
  }

  console.log(`=== Plan ===\nCreate ${CODE} "${NAME}" (${TYPE}, active)`);
  if (!APPLY) {
    console.log('\nDRY RUN — re-run with --apply to create. Nothing changed.');
    return;
  }

  await createAccount(db, { code: CODE, name: NAME, type: TYPE, active: true }, CTX);
  const a = await getAccountByCode(db, CODE);
  console.log(
    `\n✓ created: ${a!.code}  ${a!.type}  ${a!.active ? 'active' : 'INACTIVE'}  ${a!.name}`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
