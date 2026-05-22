/**
 * One-off chart-of-accounts change (owner request 2026-05-22):
 *   1. Rename account 2030 "Vendor Credits Available" -> "Vendor Balance"
 *      (type stays LIABILITY — name only).
 *   2. Create a new ASSET account "Vendor Credits" at the next available
 *      1xxx asset code.
 *
 * Both go through the GL account service (updateAccount / createAccount) so
 * the changes are audited. Read-only by default.
 *
 *   tsx --env-file=.env scripts/rename-2030-add-vendor-credits.ts          (dry-run)
 *   tsx --env-file=.env scripts/rename-2030-add-vendor-credits.ts --apply  (executes)
 *
 * Next-code rule: asset sub-categories follow 1{H}10 (1110 Cash, 1210 AR,
 * 1310 Inventory). We take the highest used 1{H}10 block + 1 -> 1410, and
 * verify it doesn't collide with ANY existing code (incl. soft-deleted,
 * since `code` is unique).
 *
 * Idempotent: re-running skips the rename if 2030 is already "Vendor
 * Balance" and skips the create if an ASSET "Vendor Credits" already exists.
 */
import { PrismaClient } from '../src/generated/tenant';
import {
  createAccount,
  getAccountByCode,
  updateAccount,
} from '../src/server/services/glAccounts';

const db = new PrismaClient();
const APPLY = process.argv.includes('--apply');

const ACCT_2030 = '2030';
const NEW_2030_NAME = 'Vendor Balance';
const NEW_ACCT_NAME = 'Vendor Credits';

const CTX = {
  userId: null,
  reason:
    'Rename 2030 to "Vendor Balance"; add "Vendor Credits" asset account ' +
    '(owner request 2026-05-22).',
} as const;

/** Highest used 1{H}10 asset block + 1, e.g. 1310 -> 1410. Guards collisions. */
async function nextAssetCode(allCodes: Set<string>): Promise<string> {
  const usedBlocks = [...allCodes]
    .filter((c) => /^1\d10$/.test(c))
    .map((c) => Number(c[1]));
  const maxBlock = usedBlocks.length ? Math.max(...usedBlocks) : 0;
  for (let h = maxBlock + 1; h <= 9; h++) {
    const candidate = `1${h}10`;
    if (!allCodes.has(candidate)) return candidate;
  }
  throw new Error('No free 1{H}10 asset code available in the 1xxx range.');
}

async function main() {
  // ---- Gather state ----
  const all = await db.glAccount.findMany({ select: { code: true } });
  const allCodes = new Set(all.map((a) => a.code));

  // ---- Step 1 prechecks: 2030 must exist ----
  const acct2030 = await getAccountByCode(db, ACCT_2030);
  if (!acct2030) {
    console.error(`ABORT: account ${ACCT_2030} not found.`);
    process.exitCode = 1;
    return;
  }
  const renameNeeded = acct2030.name !== NEW_2030_NAME;

  // ---- Step 2 prechecks: pick + validate new code, dedupe by name ----
  const existingVendorCredits = all.length
    ? await db.glAccount.findFirst({
        where: { name: NEW_ACCT_NAME, type: 'ASSET' },
        select: { code: true, name: true },
      })
    : null;
  const newCode = existingVendorCredits
    ? existingVendorCredits.code
    : await nextAssetCode(allCodes);
  const createNeeded = !existingVendorCredits;
  if (createNeeded && allCodes.has(newCode)) {
    console.error(`ABORT: chosen code ${newCode} already exists — collision.`);
    process.exitCode = 1;
    return;
  }

  // ---- Plan ----
  console.log('=== Plan ===');
  console.log(
    `Step 1: rename ${ACCT_2030} "${acct2030.name}" -> "${NEW_2030_NAME}" ` +
      `(type ${acct2030.type}, unchanged)` +
      `${renameNeeded ? '' : '  [already named — will skip]'}`,
  );
  console.log(
    createNeeded
      ? `Step 2: create ${newCode} "${NEW_ACCT_NAME}" (ASSET, active)`
      : `Step 2: "${NEW_ACCT_NAME}" already exists at ${existingVendorCredits!.code} — will skip`,
  );

  if (!APPLY) {
    console.log('\nDRY RUN — re-run with --apply to execute. Nothing changed.');
    return;
  }

  // ---- Apply ----
  console.log('\n=== Applying ===');
  if (renameNeeded) {
    await updateAccount(db, acct2030.id, { name: NEW_2030_NAME }, CTX);
    console.log(`  ✓ renamed ${ACCT_2030} -> "${NEW_2030_NAME}"`);
  } else {
    console.log(`  • ${ACCT_2030} already "${NEW_2030_NAME}" — skipped`);
  }
  if (createNeeded) {
    await createAccount(
      db,
      { code: newCode, name: NEW_ACCT_NAME, type: 'ASSET', active: true },
      CTX,
    );
    console.log(`  ✓ created ${newCode} "${NEW_ACCT_NAME}" (ASSET)`);
  } else {
    console.log(`  • "${NEW_ACCT_NAME}" already exists — skipped`);
  }

  // ---- Confirm: print both accounts ----
  console.log('\n=== Result ===');
  for (const code of [ACCT_2030, newCode]) {
    const a = await getAccountByCode(db, code);
    console.log(
      a
        ? `  ${a.code}  ${a.type.padEnd(10)} ${a.active ? 'active' : 'INACTIVE'}  ${a.name}`
        : `  ${code}  (not found)`,
    );
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
