# 10 — Module 9: Deployment, Migration, & Build Phasing

## Deployment architecture

### DigitalOcean App Platform (recommended)
- Managed platform — less ops burden than Droplets
- Sufficient for 10-user scale
- Auto-deploys from Git
- Managed PostgreSQL add-on
- Spaces (S3-compatible) for file storage
- Total cost per company instance: **$50–100/month**

### Per-company resources
- Subdomain: `companyname.yourerp.com`
- Database: dedicated PostgreSQL instance
- Storage bucket: dedicated Spaces bucket for PDFs and uploads
- App Platform service: scaled per company's needs

### Provisioning script
Build a script that spins up a new company instance from scratch in approximately one hour:
1. Create database
2. Run schema migrations
3. Seed default data (chart of accounts, default categories, document templates)
4. Configure subdomain + DNS
5. Create Spaces bucket
6. Deploy app
7. Create first Super Admin user

### Backup strategy
- Daily automated database backups, retained for 30 days
- Spaces versioning enabled on file storage
- Manual snapshot before any major migration
- Quarterly restore test

### Staging environment
- One shared staging instance
- Test changes there before pushing to production
- Deploy to all production instances after staging verification

## Document templates

### Templates to build (v1)

| Document | Module | Notes |
|----------|--------|-------|
| Sales Order | 4 | Customer-facing, includes prices |
| Invoice | 5 | Customer-facing, includes shipping/payments/balance |
| Pick Sheet | 4 | Internal, no prices, has packed-by column |
| Packing Slip | 4 | Goes in box, no prices |
| Check-In Sheet | 6 | Receiving doc with QTY Received + Qty Good |
| Purchase Order | 3 | Vendor-facing |
| Credit Memo | 5 | Customer-facing |
| Payment Receipt | 5 | Customer-facing |
| Customer Statement (full activity) | 2/5 | On-demand |
| Customer Statement (open balance) | 2/5 | On-demand |
| Vendor Commission Statement | 3 | For drop-ship vendors |
| RMA Document | 5 | Authorization for return |
| Stock Transfer Sheet | 1 | For multi-warehouse, deferred to post-pilot |

### Template engine

**Unified template engine** — one base document framework, all docs inherit:
- Logo
- Company info header
- Customer info block
- Product table (configurable columns)
- Footer with totals
- Branding

Change once, applies everywhere. New doc types inherit the look automatically.

### Customization scope

Super Admin can edit:
- Logo, header, footer
- Add / remove / hide columns
- Edit text labels
- Color scheme (within limits)

Layout/positioning: fixed structure with content slots. Full layout redesign is deferred (rabbit hole).

### Layout principles (from existing samples)
- Company logo + document title at top
- Document #, date, key metadata top-right
- Bill-to and Ship-to address blocks
- Sales rep, payment, shipping method as metadata
- Product table: photo, item description, SKU (with stock context line for internal docs), qty, price/total
- Production tags below item description ("12-14 DAY PRODUCTION", "EXPRESS")
- Footer: subtotal, discounts, shipping, grand total, credits, payments, balance due
- Special notes section
- Page 2 (pick sheet only): box dimensions table

### Visual modernization
- Match field structure of existing docs (muscle memory preserved)
- Modernize typography, spacing, colors
- Better image fallbacks (placeholder with SKU printed)
- Print-area aware (no cut-off columns)

## Email templates

### Templates to build (v1)
- Order confirmation
- Invoice email
- Payment receipt
- Statement
- Backorder ready notification
- RMA approved
- RMA received
- Wholesale application received
- Wholesale application approved (with portal credentials)
- Card expiring soon
- Document expiring soon
- Password reset
- 2FA code
- Statement reminder (manual trigger)

### Customization
Same engine as document templates. Editable text, merge fields, branding.

## Data migration

### Pilot migration: Naked Kratom
Small business — ~40 SKUs, few customers, ~10 vendors, low transaction volume. Low complexity makes it a good first migration.

### What to migrate

**High priority:**
- Customers (with addresses, contacts, payment terms, tier assignments, notes)
- Vendors (with payment info, terms, contacts)
- Products (with cost, price, current inventory levels)
- Open AR (unpaid customer invoices with balances)
- Open AP (unpaid vendor bills with balances)
- Customer credits / deposits (unapplied balances)
- Vendor credits

**Medium priority:**
- Closed sales orders / shipped invoices (last 12 months)
- Closed POs (last 12 months)
- Payment history (last 12 months)
- Inventory movement history (last 6 months)

**Low priority:**
- Historical invoice PDFs (archive in old system as reference if needed)
- Customer files (resale certs)
- Older history (>12 months, leave in old system)

### Source data access
Confirm with old ERP (custom Python/Cisco):
- Database export (SQL dump or CSVs) — preferred
- API access — alternative
- Manual extraction queries — fallback

### Migration approach: parallel run
- Old system continues running
- New system loaded with master data + open balances
- Both systems active for 30–60 days
- All new transactions entered in BOTH systems
- Reconciliation at end of each week (AR balances, AP balances, inventory, GL)
- When confidence is high → cut over (old system goes read-only, new system is live)
- Old system kept as read-only archive

### Reconciliation checks during parallel run
- AR balance per customer matches
- AP balance per vendor matches
- Inventory quantities per SKU per warehouse match
- Trial balance matches
- COGS for shipped orders matches
- WAC per product matches (allow rounding tolerance)

## Build phasing (estimated solo-build with Claude Code)

### Realistic timeline (Naked Kratom pilot)

**Full-time (5+ hrs/day):** 6–10 weeks to functional system + 2–4 weeks parallel run = **2–3 months**

**Part-time (1–2 hrs/day):** 4–6 months

### Phase order

1. **Foundation** (auth, RBAC, audit, multi-tenant infra, base UI shell) — weeks 1–3
2. **Products & Inventory** (master data, FIFO/WAC engine, single warehouse) — weeks 4–6
3. **Customers + Vendors** (master data, basic CRM) — week 7
4. **Sales Orders + Invoicing/AR** (full SO lifecycle, invoicing, payments) — weeks 8–10
5. **POs + Bills/AP** (full PO lifecycle, multi-PO receipt model) — weeks 11–12
6. **GL/Costing engine + Reports** (auto-JE posting, reconciliation, financial reports) — weeks 13–14
7. **Integrations** (Shopify sync, Authorize.Net, Mailgun) — weeks 15–17
8. **Document/email templates + admin UI** (template editors, settings UI) — week 18
9. **Migration tooling + Naked Kratom data import** — week 19
10. **Parallel run** — weeks 20–24
11. **Cutover** — week 25

### Pilot scope cuts (deferred until post-pilot)
For Naked Kratom specifically, the following can be skipped initially:

- ShipStation integration (manual labels for now)
- Customer portal (small customer base — direct contact works)
- Vendor portal
- Drop-ship module (Naked Kratom doesn't drop-ship)
- Pack hierarchy (40 SKUs are simple — no display/master/pallet)
- Build/assembly module (verify if Naked Kratom assembles anything)
- Multi-warehouse / stock transfers (single warehouse)
- Quantity break + cost-plus pricing (verify if Naked Kratom uses these)
- Lot/batch + bin tracking
- Custom report builder (canned reports only)
- Email scheduling
- 2FA enforcement (basic email/password sufficient)

After Naked Kratom is stable, add deferred features for second-pilot company.

## Second pilot recommendation

Don't roll out to all companies after Naked Kratom succeeds. Pick a **more complex** second pilot to stress-test:
- Multi-warehouse
- Drop-ship
- Pack hierarchy
- Higher SKU count
- Higher transaction volume

The 20K-SKU drop-ship company should NOT be the second pilot — too risky. Pick a mid-complexity company.

## Risk register

| Risk | Mitigation |
|------|-----------|
| FIFO/WAC math bugs | Hire bookkeeper / fractional CFO for 5–10 hrs to verify GL output during pilot. Comprehensive test suite for costing engine. |
| Authorize.Net integration quirks | Allocate 1–2 weeks. Use sandbox extensively. Have manual fallback. |
| Shopify webhook reliability | Scheduled reconciliation pull as backup. |
| Migration data quality | Reconciliation checks weekly. Don't cut over until balances match for 2+ consecutive weeks. |
| Performance at 20K SKU scale | Load test before second-pilot company migrates. Index strategy review. |
| Solo-build burnout | Realistic timeline. Don't underscope tests. Keep scope tight on pilot. |
| Old ERP cooperation | Confirm database export access early. Have backup plan (manual extraction). |
