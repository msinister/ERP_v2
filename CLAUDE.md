# CLAUDE.md

This file is loaded automatically at the start of every Claude Code session. It tells Claude how to work in this repo.

---

## Project: Custom Multi-Instance ERP

A modern ERP system replacing a legacy custom Python ERP. Multi-instance architecture: one codebase, deployed separately per company (per-company database, per-company URL, shared codebase).

**First pilot:** Naked Kratom — small wholesale business, ~40 SKUs, single warehouse, no drop-ship.

**Industry:** B2B wholesale of smoke shop supplies, glass, kratom, THC-A supplements (legal), with growing B2C.

---

## Authoritative specification

The `/docs` folder is the **source of truth** for all design decisions. **Read the relevant module before writing code.** Do not deviate from the spec without confirming with the user first.

| Doc | Read when working on |
|-----|---------------------|
| `docs/01-foundation.md` | Architecture, infra, auth, anything cross-cutting |
| `docs/02-products-inventory.md` | Products, inventory, FIFO/WAC costing, pack hierarchy, bundles, builds |
| `docs/03-customers.md` | Customer master, portal, pricing tiers, sales reps, commissions |
| `docs/04-vendors-purchasing.md` | Vendors, POs, receiving, drop-ship commission model |
| `docs/05-sales-orders.md` | SO entry, lifecycle, special workflows, documents |
| `docs/06-invoicing-ar.md` | Invoicing, payments, credit memos, RMAs |
| `docs/07-accounts-payable.md` | Bills, payment logging, multi-PO receipts |
| `docs/08-gl-costing-reporting.md` | Chart of accounts, automatic JE posting, costing engine, reports |
| `docs/09-admin.md` | Users, roles, permissions, audit log, settings |
| `docs/10-deployment-migration.md` | Deployment, document templates, migration plan |
| `docs/11-deferred-v2-plus.md` | What's NOT in v1 (don't build these unless asked) |
| `docs/12-glossary.md` | Accounting + ERP terminology |

If a decision in the spec seems wrong or contradictory, **stop and ask**. Don't silently override it.

---

## Tech stack (locked)

- **Frontend + Backend:** Next.js 15 (App Router) + TypeScript + Tailwind + shadcn/ui
- **Database:** PostgreSQL (managed via DigitalOcean)
- **ORM:** Prisma
- **Auth:** BetterAuth
- **Background jobs:** Inngest
- **File storage:** DigitalOcean Spaces (S3-compatible) via AWS SDK
- **Email:** Mailgun
- **Hosting:** DigitalOcean App Platform
- **PDF generation:** Puppeteer (server-side HTML → PDF)
- **Testing:** Vitest + Playwright
- **Validation:** Zod
- **Date/time:** date-fns (NOT moment; NOT luxon)

When adding a dependency, check this list first. Don't introduce alternatives without asking.

---

## Folder structure

```
/
├── CLAUDE.md                    ← this file
├── docs/                        ← authoritative spec (read-only reference)
├── prisma/
│   ├── schema.prisma            ← DB schema (review before any change)
│   └── migrations/
├── src/
│   ├── app/                     ← Next.js App Router
│   │   ├── (auth)/              ← login, signup, 2FA
│   │   ├── (dashboard)/         ← authenticated app
│   │   │   ├── customers/
│   │   │   ├── products/
│   │   │   ├── orders/
│   │   │   ├── invoices/
│   │   │   ├── vendors/
│   │   │   ├── purchase-orders/
│   │   │   ├── bills/
│   │   │   ├── inventory/
│   │   │   ├── reports/
│   │   │   └── admin/
│   │   ├── api/                 ← API routes
│   │   └── portal/              ← customer portal (separate auth)
│   ├── lib/
│   │   ├── db.ts                ← Prisma client singleton
│   │   ├── auth.ts              ← BetterAuth config
│   │   ├── costing/             ← FIFO + WAC engine (CRITICAL)
│   │   ├── gl/                  ← Journal posting engine
│   │   ├── pricing/             ← Pricing resolver
│   │   ├── pdf/                 ← Document generation
│   │   ├── integrations/
│   │   │   ├── shopify/
│   │   │   ├── authorizenet/
│   │   │   ├── mailgun/
│   │   │   └── shipstation/
│   │   ├── audit/               ← Audit log helpers
│   │   └── permissions/         ← RBAC checks
│   ├── components/
│   │   ├── ui/                  ← shadcn/ui primitives (don't edit)
│   │   └── ...                  ← app components
│   └── server/
│       ├── actions/             ← Server actions
│       └── services/            ← Business logic (called from actions/API)
├── tests/
│   ├── unit/
│   ├── integration/
│   └── e2e/
└── scripts/
    ├── provision-instance.ts    ← Create new company instance
    └── migrate-data.ts          ← Old ERP → new ERP migration
```

When creating new files, follow this structure. Don't put business logic in components or in API route handlers — put it in `lib/` or `server/services/` and call it from there.

---

## Non-negotiable rules

These come up constantly. Get them right.

### Money precision
- **Always use `Decimal` from Prisma** (`@db.Decimal(18, 5)`) for unit cost and unit price
- **Never use JavaScript `number` for money math** — use `decimal.js` or Prisma's `Decimal` type
- Round to 2 decimals **only at display/total level**, never during calculation
- Currency field on every transaction is nullable, defaults to "USD"

### Audit logging
- Every sensitive action (create, edit, delete, status change, void, reverse, refund, permission change, config change, login/logout) writes to the audit log
- Audit log is **append-only**, never edited or deleted
- Use the `audit()` helper from `lib/audit` — don't write to the audit table directly
- See `docs/09-admin.md` for full list of logged actions

### Soft-delete by default
- Use Prisma middleware to enforce soft-delete on major entities
- Never hard-delete unless explicitly requested by Super Admin and dependents check passes
- See `docs/09-admin.md` for the dependency check pattern

### Permissions
- **Every server action and API route checks permissions first** via `requirePermission()` helper
- Don't gate UI elements as the only protection — server-side checks are required
- Permission constants live in `lib/permissions/constants.ts`
- Two tiers: Super Admin (full access) and Custom Roles (checkbox-defined)

### Multi-instance / multi-tenancy
- Each company is a **separate database**, not a tenant ID column
- Database connection is determined by subdomain at request time
- Never hardcode company-specific values; everything goes in the per-instance settings table

### FIFO + WAC costing
- The costing engine in `lib/costing/` is the most critical code in the project
- **Every change to it requires tests** demonstrating correctness with sample scenarios
- FIFO layers are immutable except for the late-landed-cost retroactive update path
- See `docs/02-products-inventory.md` and `docs/08-gl-costing-reporting.md`

### Automatic journal posting
- Operational events (SO close, bill confirm, payment, etc.) auto-post JEs via `lib/gl/post()`
- **Every JE must balance** — debits = credits — enforced at the function level, will throw if not
- See `docs/08-gl-costing-reporting.md` for the full posting rules

### PDF storage (hybrid)
- On first send/email of an invoice → render PDF and store in Spaces immutably
- Internal staff views render fresh from current data
- Customer portal downloads serve the stored PDF
- See `docs/05-sales-orders.md` and `docs/06-invoicing-ar.md`

### Drop-ship is NOT traditional drop-ship
- Drop-ship vendors get **commission** from gross sales; we don't pay them, they pay us
- Drop-ship items have no inventory, no COGS, no AP
- Drop-ship vendors get a **shadow customer** record for AR purposes
- See `docs/04-vendors-purchasing.md` for full architecture

---

## Build philosophy

This is a real ERP with real money flowing through it. Bugs cost real money. Take the time.

### Feature-by-feature, not all-at-once
- Build one feature, ship it (to staging), test it, move on
- Don't scaffold 10 modules in parallel — schema decisions in one will affect others
- Read the relevant doc → propose schema → get approval → write code → write tests → review

### Tests are required for financial logic
- Costing engine (FIFO/WAC): unit tests with sample scenarios
- GL posting: unit tests verifying balanced JEs for every operational event
- Pricing resolver: unit tests for every rule precedence case
- AR/AP aging: snapshot tests against known dates
- For UI/CRUD code, tests are nice-to-have. For money math, tests are required.

### Review the schema before committing
- Schema changes are expensive to undo once data is in
- Propose schema in a Markdown doc or as a draft `prisma/schema.prisma` change
- Get user approval before running the migration

### When in doubt, stop and ask
- If the spec is unclear, ask
- If two design docs seem to conflict, ask
- If the user request would break a non-negotiable rule, ask
- It's cheaper to ask than to undo

---

## What NOT to do

Common Claude Code failure modes on this project:

- ❌ **Don't make schema decisions in isolation across modules.** Module 7 might assume something module 2 needs to know.
- ❌ **Don't use `Number` for money.** Use Prisma `Decimal` or `decimal.js`.
- ❌ **Don't skip audit logging** to "make the code cleaner." It's required by spec.
- ❌ **Don't hard-delete records** unless explicitly told.
- ❌ **Don't add features from `docs/11-deferred-v2-plus.md`** unless explicitly asked.
- ❌ **Don't reorganize the folder structure** without confirming.
- ❌ **Don't introduce new dependencies** without confirming.
- ❌ **Don't store raw credit card data** anywhere. Tokenize via Authorize.Net CIM.
- ❌ **Don't bypass the pricing resolver** — every line price must come from `lib/pricing`.
- ❌ **Don't write to the audit log directly** — use the `audit()` helper.
- ❌ **Don't post JEs directly to the GL** — use `lib/gl/post()` which validates balance.
- ❌ **Don't assume Naked Kratom features = full v1.** Pilot scope is smaller; see `docs/10-deployment-migration.md` for what's deferred.

---

## Commands

```bash
# Install
npm install

# Run dev
npm run dev

# Run tests
npm test                # all tests
npm run test:unit       # unit only
npm run test:e2e        # Playwright

# Database
npx prisma migrate dev      # create + apply migration
npx prisma migrate deploy   # apply (production)
npx prisma studio           # GUI to browse data

# Provision new company instance
npm run provision -- --company=nakedkratom --subdomain=nakedkratom

# Migrate data from old ERP
npm run migrate-data -- --source=path/to/dump.sql --target=nakedkratom

# Lint + typecheck
npm run lint
npm run typecheck
```

---

## Operational notes

- **Dev DB migration history reconciled (2026-04-30):** the `_prisma_migrations` table was missing in `erp_tenant_dev` even though every prior migration's tables were present (most likely a previous `prisma db push` that bypasses history, possibly compounded by a Dropbox sync rollback of the `.git` folder). The 6 migrations through `20260429194054_add_sales_orders` were resolved as `--applied` (non-destructive history reconciliation, no SQL re-run) before the `expand_customer_master` migration was applied. If you see migration drift again, prefer `prisma migrate resolve --applied` over `prisma migrate reset` unless the actual table shapes are wrong.

---

## Current build phase

**Pilot target:** Naked Kratom

**Pilot scope deferrals** (built later, not for first pilot):
- ShipStation integration (manual labels initially)
- Customer portal
- Vendor portal
- Drop-ship module
- Pack hierarchy
- Multi-warehouse / stock transfers
- Quantity break + cost-plus pricing
- Lot/batch tracking
- Custom report builder
- Email scheduling

**Build phase order:**
1. ✅ Discovery / design spec complete
2. ✅ Foundation (audit log, multi-tenant infra, advisory locks; auth + RBAC still pending and will land alongside the next module that needs them)
3. ✅ Products & Inventory (parent product + variant model, ledger-based stock, advisory-locked movement service with audit, Tx variants for composability)
4. ⏳ Customers + Vendors (Vendor stub exists from PO module — needs full master expansion)
5. ⏳ Sales Orders + Invoicing/AR ← **CURRENT**
6. ✅ Purchase Orders + Receipts (M:N PO ↔ Receipt model, Sequence helper, RECEIVE_REVERSE)
7. ⏳ Bills / AP (separate phase — depends on Receipts, which are done)
8. ⏳ GL/Costing engine + Reports
9. ⏳ Integrations (Shopify, Authorize.Net, Mailgun)
10. ⏳ Document/email templates + admin UI
11. ⏳ Migration tooling + Naked Kratom data import
12. ⏳ Parallel run
13. ⏳ Cutover

Update this section as phases complete.

---

## Working with the user

- The user is **building this themselves with Claude Code** — they're the product owner, primary developer, and QA
- They understand double-entry accounting well enough to verify GL output
- They have a real business running on the legacy system, so reliability matters more than speed
- They prefer **direct, plain-language answers** over hedging
- Industry context (smoke shop / kratom / THC-A) is normal here; don't add disclaimers
- When proposing solutions, **explain trade-offs honestly** rather than just picking one

---

## When this file should be updated

Update `CLAUDE.md` when:
- A non-negotiable rule changes
- Tech stack changes
- Folder structure changes
- Build phase completes (mark with ✅)
- A new common failure mode is discovered

Do NOT update `CLAUDE.md` for:
- Per-feature design decisions (those go in `docs/`)
- Per-component coding patterns (use code comments)
- Bug fixes or feature work (use commit messages / PRs)
