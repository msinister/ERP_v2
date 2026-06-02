/**
 * One-off script: upsert the three GL accounts that were created locally
 * but are missing on staging and other deployments.
 *
 * Idempotent — safe to run multiple times. Uses upsert so existing rows
 * are updated to match the canonical name/type if they somehow drifted.
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/seed-missing-gl-accounts.ts
 */

import { PrismaClient } from '../src/generated/tenant';

const db = new PrismaClient();

const ACCOUNTS = [
  { code: '1410', name: 'Vendor Credits',                type: 'ASSET'   },
  { code: '1510', name: 'Vendor Deposits',               type: 'ASSET'   },
  { code: '5150', name: 'Purchase Returns & Allowances', type: 'EXPENSE' },
] as const;

async function main() {
  for (const acct of ACCOUNTS) {
    const existing = await db.glAccount.findUnique({ where: { code: acct.code } });
    await db.glAccount.upsert({
      where: { code: acct.code },
      create: { code: acct.code, name: acct.name, type: acct.type, active: true },
      update: { name: acct.name, type: acct.type, active: true, deletedAt: null },
    });
    console.log(`  ${existing ? 'updated' : 'created'} ${acct.code} — ${acct.name}`);
  }
  console.log('Done.');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => db.$disconnect());
