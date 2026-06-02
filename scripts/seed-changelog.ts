/**
 * Seed the initial v2.0.0 changelog entries.
 *
 * Idempotent — skips if any entry with version "2.0.0" already exists.
 * Requires a Super Admin to exist (run create-first-super-admin first).
 *
 * Usage:
 *   tsx --env-file=.env scripts/seed-changelog.ts
 */

import { PrismaClient, ChangelogEntryType, AuditAction } from '../src/generated/tenant';
import { audit } from '../src/lib/audit/audit';

const db = new PrismaClient({
  datasources: { db: { url: process.env.TENANT_DATABASE_URL } },
});

const PUBLISH_DATE = new Date('2025-01-01T00:00:00Z');

const ENTRIES: Array<{
  type: ChangelogEntryType;
  title: string;
  description: string;
}> = [
  {
    type: ChangelogEntryType.FEATURE,
    title: 'Sales Orders — full lifecycle',
    description: `Complete SO workflow from DRAFT through CONFIRMED → DISPATCHED → CLOSED, with reservation, cancellation, and advisory locking. Insufficient-stock alerts surface at close time.`,
  },
  {
    type: ChangelogEntryType.FEATURE,
    title: 'Purchase Orders with shipment tracking and prepay deposits',
    description: `M:N PO ↔ Receipt model. Record prepay deposits (DR 1510 Vendor Deposits) that auto-apply at receipt time. Reverse receipts and void POs with full cascade guards.`,
  },
  {
    type: ChangelogEntryType.FEATURE,
    title: 'Invoicing and Accounts Receivable',
    description: `Auto-invoice on SO close. FIFO credit memo apply, RMA → credit flow, AR aging (balance + per-customer buckets). Void blocked by applied payments.`,
  },
  {
    type: ChangelogEntryType.FEATURE,
    title: 'Bills and Accounts Payable',
    description: `Bill DRAFT → CONFIRMED with M:N PO/Receipt joins. Overpayment auto-VC. Vendor credits with manual application. AP aging mirrors AR. Receipt → auto-draft bill hook.`,
  },
  {
    type: ChangelogEntryType.FEATURE,
    title: 'GL, FIFO costing, and automatic journal entries',
    description: `Full general ledger with fiscal period management (soft/hard close, reopen). Every operational event auto-posts a balanced JE. Financial reports: trial balance, balance sheet, income statement, GL detail. Operational reports: sales by customer, inventory valuation, cash position.`,
  },
  {
    type: ChangelogEntryType.FEATURE,
    title: 'Multi-store Shopify integration',
    description: `Connect multiple Shopify stores. Routing rules map store orders to ERP customers. Product sync (Shopify → ERP), inventory push (ERP → Shopify), and order sync with pending-review workflow for unmatched orders.`,
  },
  {
    type: ChangelogEntryType.FEATURE,
    title: 'Customer master with pricing tiers and sales reps',
    description: `Full customer profile: types, addresses, contacts, payment terms, credit limits, tax-exempt status, resale certs. Customer-specific pricing with CSV importer. Sales rep assignment, commissions, and activity log.`,
  },
  {
    type: ChangelogEntryType.FEATURE,
    title: 'Vendor and Customer ledger tabs',
    description: `Running net balance on vendor and customer detail pages. Bills/invoices debit; payments/credits/deposits credit. Applications and overpayment VCs are balance-neutral.`,
  },
  {
    type: ChangelogEntryType.FEATURE,
    title: 'Multi-entity tagging',
    description: `Tag Sales Orders, Purchase Orders, Bills, Credit Memos, RMAs, Work Orders, and Vendor Credits. Filter any list by tag.`,
  },
  {
    type: ChangelogEntryType.FEATURE,
    title: 'My Account — profile and session management',
    description: `Edit your profile, change your password, upload an avatar, view and revoke active sessions, and browse your recent activity. Sales reps see a commission summary for the current month.`,
  },
  {
    type: ChangelogEntryType.IMPROVEMENT,
    title: 'Per-user column customization on all list pages',
    description: `Toggle, reorder, and persist column visibility per table. Preferences are saved per user and survive page reloads. Reset to defaults from My Account.`,
  },
  {
    type: ChangelogEntryType.IMPROVEMENT,
    title: 'Pending order review workflow',
    description: `Shopify orders that can't auto-match to an ERP customer land in a review queue. Operators confirm the match, create a new customer, or dismiss the order — with full side-by-side comparison.`,
  },
];

async function main() {
  const existing = await db.changelogEntry.findFirst({
    where: { version: '2.0.0', deletedAt: null },
  });
  if (existing) {
    console.log('v2.0.0 entries already exist — skipping seed.');
    return;
  }

  const superAdmin = await db.user.findFirst({
    where: { isSuperAdmin: true, deletedAt: null, enabled: true },
    select: { id: true },
  });
  if (!superAdmin) {
    throw new Error('No Super Admin found. Run create-first-super-admin first.');
  }

  console.log(`Seeding ${ENTRIES.length} changelog entries as user ${superAdmin.id}…`);

  for (const entry of ENTRIES) {
    const row = await db.changelogEntry.create({
      data: {
        version: '2.0.0',
        title: entry.title,
        description: entry.description,
        type: entry.type,
        publishedAt: PUBLISH_DATE,
        createdById: superAdmin.id,
      },
    });
    await audit(db, {
      action: AuditAction.CREATE,
      entityType: 'ChangelogEntry',
      entityId: row.id,
      after: { version: row.version, title: row.title },
      ctx: { userId: superAdmin.id },
    });
    console.log(`  ✓ ${entry.type.padEnd(12)} ${entry.title}`);
  }

  console.log('Done.');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => db.$disconnect());
