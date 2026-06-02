import { PrismaClient } from '../src/generated/tenant';

const db = new PrismaClient();

const entries = [
  {
    version: '2.0.0',
    type: 'FEATURE' as const,
    title: 'Multi-Store Shopify Integration',
    description: 'Connect multiple Shopify stores with routing rules to control which products sync to which store. Support for include/exclude rules by vendor, category, or tag.',
  },
  {
    version: '2.0.0',
    type: 'FEATURE' as const,
    title: 'Product Sync (Shopify → ERP)',
    description: 'Pull product catalog, images, vendors, and tags from Shopify automatically via webhooks. Real-time sync on product create, update, and delete.',
  },
  {
    version: '2.0.0',
    type: 'FEATURE' as const,
    title: 'Product Push (ERP → Shopify)',
    description: 'Push ERP products to Shopify stores based on routing rules. Creates and updates product listings with images, variants, and tags.',
  },
  {
    version: '2.0.0',
    type: 'FEATURE' as const,
    title: 'Real-Time Inventory Push',
    description: 'Inventory levels sync from ERP to all connected Shopify stores automatically after every movement — receipts, sales, adjustments, and returns.',
  },
  {
    version: '2.0.0',
    type: 'FEATURE' as const,
    title: 'Shopify Order Sync',
    description: 'Import orders from Shopify into ERP as sales orders. Includes smart customer matching with a pending review workflow for ambiguous matches.',
  },
  {
    version: '2.0.0',
    type: 'FEATURE' as const,
    title: 'Sales Orders',
    description: 'Full order lifecycle management — Draft → Confirmed → Dispatched → Closed — with invoicing, payments, credit memos, and RMA support.',
  },
  {
    version: '2.0.0',
    type: 'FEATURE' as const,
    title: 'Purchase Orders',
    description: 'Full PO lifecycle with multi-shipment tracking, prepay deposits with auto-apply to bills, and receipt reversal from the PO page.',
  },
  {
    version: '2.0.0',
    type: 'FEATURE' as const,
    title: 'Multi-Entity Tagging',
    description: 'Tag Sales Orders, Purchase Orders, Bills, Credit Memos, RMAs, Work Orders, and Vendor Credits with a shared tag pool. Filter by tags on all list pages.',
  },
  {
    version: '2.0.0',
    type: 'FEATURE' as const,
    title: 'GL & FIFO Costing Engine',
    description: 'Double-entry general ledger with automatic journal entries on all operational events. FIFO inventory costing with WAC tracking per product per warehouse.',
  },
  {
    version: '2.0.0',
    type: 'IMPROVEMENT' as const,
    title: 'Per-User Column Customization',
    description: 'Customize and reorder columns on all list pages with drag-and-drop. Settings saved per user and persist across sessions.',
  },
  {
    version: '2.0.0',
    type: 'IMPROVEMENT' as const,
    title: 'Search by Name Across All Lists',
    description: 'All list pages now search by document number AND related entity name — customer name on orders, vendor name on POs and bills, etc.',
  },
  {
    version: '2.0.0',
    type: 'IMPROVEMENT' as const,
    title: 'Vendor & Customer Ledger Tabs',
    description: 'Full transaction ledger with net running balance on vendor and customer detail pages. Export to CSV. Filterable by date and transaction type.',
  },
];

async function main() {
  const existing = await db.changelogEntry.findFirst();
  if (existing) {
    console.log('Changelog entries already exist — skipping seed.');
    return;
  }

  const superAdmin = await db.user.findFirstOrThrow({
    where: { isSuperAdmin: true, deletedAt: null, enabled: true },
    select: { id: true },
  });

  const publishedAt = new Date();

  for (const entry of entries) {
    await db.changelogEntry.create({
      data: {
        ...entry,
        publishedAt,
        createdById: superAdmin.id,
      },
    });
    console.log(`  ✓ ${entry.type.padEnd(12)} ${entry.title}`);
  }

  console.log(`Done — ${entries.length} entries created.`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => db.$disconnect());
