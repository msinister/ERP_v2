/**
 * One-off: create GL account 5150 "Purchase Returns & Allowances".
 *
 * This is the offset (credit) side of a manually-issued vendor credit under
 * the new asset model: confirm posts DR 1410 Vendor Credits / CR 5150.
 * Typed EXPENSE so it behaves as a contra-COGS — crediting it reduces total
 * cost on the income statement (the conventional purchase-returns treatment).
 *
 *   tsx --env-file=.env scripts/create-purchase-returns-account.ts          (dry-run)
 *   tsx --env-file=.env scripts/create-purchase-returns-account.ts --apply  (executes)
 *
 * Idempotent: skips if 5150 already exists. Aborts if 5150 is taken by a
 * different account name.
 */
import { PrismaClient } from '../src/generated/tenant';
import { createAccount, getAccountByCode } from '../src/server/services/glAccounts';

const db = new PrismaClient();
const APPLY = process.argv.includes('--apply');

const CODE = '5150';
const NAME = 'Purchase Returns & Allowances';
const TYPE = 'EXPENSE' as const;

const CTX = {
  userId: null,
  reason: 'Create Purchase Returns & Allowances (vendor-credit offset, asset model). Owner-approved 2026-05-22.',
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
