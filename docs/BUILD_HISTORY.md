# Build History

Cumulative record of what's been built, when, and why. The slice-by-slice spec lives in `docs/01`–`docs/12`; this file is the implementation log keyed to commit hashes.

---

## Project overview

A custom multi-instance ERP replacing a legacy in-house Python ERP. Single codebase, deployed once per company (per-company Postgres, per-company subdomain, per-company Spaces bucket). First pilot is **Naked Kratom** — a small wholesale business with ~40 SKUs, single warehouse, no drop-ship, no portals. The build's industry context is B2B wholesale of smoke-shop supplies, glass, kratom, and THC-A supplements with growing B2C; that shapes payment-processor and shipping-carrier choices but doesn't otherwise leak into the schema.

---

## Tech stack (locked)

| Layer | Choice |
|---|---|
| Frontend + Backend | Next.js 15 (App Router) + TypeScript + Tailwind v4 + shadcn/ui on `@base-ui/react` |
| Database | PostgreSQL (DigitalOcean managed) |
| ORM | Prisma 6 |
| Auth | BetterAuth |
| Background jobs | Inngest |
| File storage | DigitalOcean Spaces (S3-compatible) via AWS SDK |
| Email | Mailgun |
| Hosting | DigitalOcean App Platform |
| PDF generation | Puppeteer (server-side HTML → PDF) |
| Testing | Vitest + Playwright (integration suite is Vitest-only; Playwright reserved for browser flows) |
| Validation | Zod |
| Date/time | date-fns |

---

## Architecture decisions

### Multi-instance, not multi-tenant
Each company is a separate Postgres database and subdomain. The codebase resolves the database connection from the request's subdomain at runtime. No `tenantId` column anywhere — referential integrity is enforced by the database, not by application-level scoping. Trade-off: per-company schema migrations run independently; benefit: one breach can't leak cross-company data.

### Money precision
Every cost/price field is `Decimal @db.Decimal(18, 5)`. Rounding happens only at display/total time. JavaScript `Number` is forbidden for monetary math — `Prisma.Decimal` or `decimal.js` everywhere. Currency is nullable per row, defaults to `"USD"` for the pilot.

### FIFO layer-based costing with WAC for reporting
- `FifoLayer` rows track cost-basis per `(variantId, warehouseId)`, oldest first, with `qtyRemaining` decremented as inventory consumes.
- `FifoConsumption` rows record the exact layers each `CONSUME` movement drew from. This is the source of truth for COGS and the basis for retroactive landed-cost adjustments.
- `WAC = Σ(qtyRemaining × unitCost) / Σ(qtyRemaining)` per bin, computed on demand for reports (never stored — would drift).
- Late landed cost lands on the most-recent layer; reverse-walks `FifoConsumption` to retroactively bump prior invoice COGS without rewriting closed JEs.

### Automatic journal posting
Every operational event (SO close, bill confirm, payment record, CM confirm, RMA credit) auto-posts a balanced JE through `lib/gl/post()`. The helper:
- Validates `Σ debits = Σ credits` and throws if not
- Resolves account codes → ids in one batched query
- Allocates a `JE-YYYY-NNNNN` sequence number (zero-padded but not truncated — overflow stays numerically correct)
- Honors the fiscal-period close gate, with `closedPeriodOverride` writing a `MANUAL_JE_POSTED` audit row

Direct `tx.journalEntry.create` is forbidden.

### Audit log, append-only, retained forever
Every sensitive action writes an `AuditLog` row via `lib/audit/audit()` — never direct DB writes. The helper captures `userId`, `entityType`, `entityId`, `action`, `beforeJson`, `afterJson`, `ipAddress`, optional `reason`. Reversal flows write *new* rows rather than mutate originals — the row sequence IS the trail.

### Soft-delete via Prisma middleware
All major entities have `deletedAt DateTime?`. Reads filter `deletedAt: null` by default; hard-delete is reserved for Super Admin and only when a dependency check returns clean.

### Encryption at rest for sensitive customer fields
`src/lib/crypto/index.ts` provides AES-256-GCM symmetric encryption keyed by `TENANT_FIELD_ENCRYPTION_KEY`. Used for the `CustomerDocument` payload and `CustomerPaymentMethod` Authorize.Net CIM tokens. Decrypts are audited (`PAYMENT_METHOD_DECRYPTED`, `DOCUMENT_DECRYPTED`). Key rotation is **not** implemented — single static key for the lifetime of an instance. Acceptable for pilot; must land before scaling.

### Bin locking for inventory mutations
Every operation that touches a `(variantId, warehouseId)` bin calls `lockBin(tx, variantId, warehouseId)` before reading — a Postgres advisory lock on the bin's hash. Serializes concurrent SO confirms / closes / receipts on the same SKU. `recomputeReservedForBin` and `recomputeOnHand` are the sanctioned ways to bump the denormalized counters.

### Drop-ship is commission, not traditional drop-ship
Drop-ship vendors are paid via commission *from* gross sales rather than us paying them. Drop-ship items have no inventory, no COGS, no AP. The vendor gets a shadow `Customer` record for AR purposes. (Deferred to v2 — not in pilot.)

### Hybrid PDF storage
On first send/email of an invoice, render PDF + store immutably in Spaces with the key on `Invoice.storedPdfKey`. Internal staff views render fresh from current data. Customer portal serves the stored PDF. Same pattern for other documents as they land.

### Service-layer Tx variants for composability
Operations that need to be atomic with their callers expose a `*Tx` variant taking `Prisma.TransactionClient` (e.g., `consumeInventoryTx`, `reversePaymentTx`, `generateInvoiceForClosedSOTx`). The non-Tx public function is a thin `$transaction` wrapper. This is how `closeSalesOrder` composes inventory consumption + invoice generation + COGS posting in one atomic block, and how `reopenSalesOrder` composes COGS reversal + payment reversal.

---

## Build history

### Backend phases

Phase numbering follows `CLAUDE.md`'s "Build phase order" tracker. Each phase corresponds to a `docs/0N-*.md` spec doc.

#### Phase 1 — Foundation
- `c163d73` — Initial spec setup (the entire `/docs` corpus landed first)
- `3fb1639` — Clean tenant schema (Prisma datasource, multi-instance plumbing)
- `e578951`–`d89c619` — Project bootstrap (package.json, tsconfig, Next config, Prisma client singleton)

#### Phase 2 — Products & Inventory
- `4c11871` — Product validation schemas
- `915a219` — Inventory service (initial)
- `3e057f5` — Warehouses service
- `00db853` — Products + Inventory migration
- `84c600d`, `543fbff`, `af879ec`, `81b5a8b`, `0b78877` — Public API routes
- `2375b2f`, `f7e85bb` — Tenant seed script
- `96cae5f` — Inventory movement ledger (schema)
- `0a81438` — Inventory movement service
- `4afe97e` — Ledger-based stock system (CONSUME/RECEIVE/ADJUST/TRANSFER, Tx variants, audit, advisory locks)

#### Phase 3 — Purchase Orders + Receipts (M:N model)
- `3974549`, `f204db6` — Schema + service + tests (one PO can produce many partial receipts; one receipt can fulfill lines across POs)
- `cc9cae9` — `lockBin` extracted into `locks.ts` (shared with the SO module)
- `04dfc3e` — First-allocation race fix in `getNextSequence`

#### Phase 4 — Sales Orders
- `4519ef6` — SO schema
- `5a9dd30` — Sales validation + pricing resolver scaffold (BASE_PRICE / MANUAL_OVERRIDE branches first)
- `72d1eda` — Customer stub (placeholder so SO can compile; replaced in Phase 5)
- `2becd7f`, `00cea8d` — SO service + API routes
- `7c6e376` — `INSUFFICIENT_STOCK_AT_CLOSE` audit row survives the rollback (outer-db write)
- `1937092`, `66a385e` — Integration tests + manual smoke script

#### Phase 5 — Customer master expansion
- `e0f6338` — `expand_customer_master` migration (citext + 2-stage backfill + 3 partial unique indices)
- `552ebd5` — Default payment terms + UNASSIGNED sales rep seeded
- `8e81bdf` — `PaymentTerm` + `SalesRep` services + routes + tests
- `8373ddd` — Field-level AES-256-GCM crypto helper
- `4a5417e` — Full customer validation schemas (master + sub-resources)
- `6a77254` — `CUSTOMER_SPECIFIC` branch added to the pricing resolver
- `ab8e678` — Customer stub replaced with full master + addresses + contacts
- `4a8b5b3` — `CustomerPriceOverride` service + CSV importer + UPSERT-only contract
- `1f5d93c` — `CustomerPaymentMethod` (Authorize.Net CIM tokens) + setPreferred + expiring query
- `f7d6df7` — `CustomerDocument` service with encrypted columns + audited decrypt path
- `d0b82c3` — Customer activity log + tags + categories
- `1f50f1e` — Customer-specific pricing wired through the SO flow

#### Phase 6 — Invoicing / AR
- `de79cce` — Core schema (`Setting`, `Invoice`, `Payment`, `CreditMemo`, `RMA`)
- `f9d196f` — `CreditMemoCategory` service
- `0208e2b` — `Setting` service + restocking-fee setting
- `f9096f3` — GL stub schema (`GlAccount`, `JournalEntry`, `JournalEntryLine` + 9 seeded accounts)
- `58051f2` — `lib/gl/post()` helper + `GlAccount` service
- `863f4c4` — Invoicing validation schemas
- `d633793` — `generateInvoiceForClosedSOTx` + AR JE posting wired into `closeSalesOrder`
- `8de250a` — `recordPayment` + `applyPaymentToInvoice` + `reversePayment` + cash-receipt JE
- `57d0ef0`, `9367897`, `1de193c` — `CreditMemo` DRAFT → CONFIRMED → VOIDED + confirm JE + FIFO auto-apply
- `7080115` — `RMA` state machine + `creditFromRma` atomic flow
- `48bf14b` — AR aging service (balance + per-customer buckets + summary)
- `574faa1`, `0bfee70` — Test flake fixes (test-owned entityId scoping)
- `12feb14` — End-to-end smoke script

#### Phase 7 — Costing engine (Parts 1–5)
- `858665c` — FIFO foundation schema (`FifoLayer`, `FifoConsumption`, `Warehouse.inventoryAccountId` FK)
- `8432d5c` — FIFO service foundation (Part 1A: layer create/consume helpers)
- `263af14` — Layer creation wired into `postReceipt` + `cancelReceipt` (Part 1B)
- `80df338` — FIFO consumption wired into `consumeInventoryTx` (Part 1C)
- `ebde760` — WAC computation service (Part 2)
- `9686b5d` — Retroactive COGS posting at SO close (Part 3)
- `ffccd36` — COGS reversal in `voidInvoice` + `creditFromRma` (Part 3.5)
- `7464786` — Late landed-cost retroactive adjustment (Part 4)
- `9a9e287` — `FifoLayer` backfill script + CLI (Part 5)

#### Pre-GUI audit pass
- `25ec743` — Back-end inventory audit (the audit doc, `docs/audits/2026-05-03-backend-inventory.md`)
- `e47e502` — GL counterpart leg fix in `postReceipt` + `createAdjustmentTx`
- `e15af88` — Module 02 audit fix: wire `audit()` in products/variants/warehouse services (stale TODO comment had been silently skipping audits)
- `11db3b4` — Module 05 audit fix #8 + #9: line-entry stock helper + SO duplicate-detect
- `11b3021` — Module 03/05/06 audit fix #4: credit-limit + AR-hold enforcement at SO confirm
- `88d3008` — Module 02/05 audit fix #5 + #10: `TIER_DISCOUNT` resolver + cancel rule

#### Commission engine
- `5e2ef96` — Slice A: schema + `Invoice.cogsAtClose` snapshot for MARGIN-basis math
- `ffac35e` — Slice B: accrual leg (rows written on each payment application)
- `3c815e4` — Slice C: reversal leg + per-rep report (negative-mirror rows on payment reversal; originals stay untouched)

#### Vendor master + Auth/RBAC
- `cd1238b` — Vendor master slice A: schema + CRUD + catalog
- `4edba42` — Vendor master slice B: encrypted payment methods
- `c47e465` — Auth + RBAC slice A: BetterAuth + `User` model + middleware + bootstrap
- `db2f593` — Auth + RBAC slice B: `requireAuth` / `requireSuperAdmin` / `auditCtxFromRequest`
- `d261439` — Auth + RBAC slice D: gate all 76 API routes on `requireAuth` + wire ctx

#### Phase 8 — Bills / AP
- `3009cd2` — Slice A: schema + GL chart additions
- `0c1cb16` — Slice B: `Bill` core service + API + tests
- `504204f` — Slice C: receipt → draft-bill auto-creation hook
- `82d71a9` — Slice D: `BillPayment` + `VendorCredit` services
- `53c4773` — Slice E: AP aging service + API + smoke script

#### Phase 9 — GL / Costing / Reports
- `af8ffb2` — Slice A: `FiscalPeriod` model + soft/hard close + `post()` gate
- `d74cc1b` — Slice B: trial balance, GL detail, journal report
- `4bfc4fb` — Slice C: balance sheet + income statement
- `ddfcb55` — Slice D: 5 reconciliation checks wired into `hardClosePeriod`
- `a0133f5` — Slice E: operational reports + 6 dashboard widgets + smoke

### GUI phases

GUI was built after the backend was solid. Each phase corresponds to a module's user-facing surface.

#### GUI 1 — Foundation
- `20950eb` — 1A: Tailwind v4 + shadcn/ui on `@base-ui/react`
- `ee59101` — 1B: auth-gated app shell + sidebar nav + user menu
- `fe33349` — 1C: dashboard widgets wired into UI
- `36b58e2` — 1D: login polish + nav stubs + loading/error/not-found

#### GUI 2 — Customers
- `0d7a753` — 2A: list page + Toaster
- `36614da` — 2B: detail page with tabbed layout
- `179ced0` — 2C: new-customer form
- `072e961` — 2D: edit form (reuses `CustomerForm` in edit mode)

#### GUI 3 — Sales Orders
- `8a3327a` — 3A: list page
- `0ae37e7` — 3B: detail page + lifecycle actions
- `69dea7a` — 3C: new SO form + pricing-resolve endpoint
- `65d26c9` — 3D: edit SO form (DRAFT-only at the time, reuses `OrderForm`)

#### GUI 4 — Products
- `2e8d4aa` — 4A: list page
- `b575965` — 4B: detail page
- `8e5d967` — 4C: new product form + unit columns
- `816e7f0` — 4D: edit form

#### GUI 5 — Reports
- `2f142dd` — 5A: reports hub + Trial Balance, Balance Sheet, Income Statement
- `b8514cf` — 5B: GL Detail, Journal, operational reports

#### GUI 6 — Vendors + POs + Receipts
- `c474389` — 6A: vendors list + new vendor form
- `c042ad5` — 6B: vendor detail, edit, Contacts + Addresses tabs
- `f8a7bd0` — 6C: vendor Products tab + Payment Methods tab with audited reveal
- `f951cad` — 6D: vendor POs tab + AP tab on detail page
- `9358967` — 6E: purchase orders list + new PO form
- `c23bb33` — 6F: PO detail page + edit + lifecycle actions
- `74c2883` — 6G: receive flow + receipt detail page

#### GUI 7 — Bills, Payments, Vendor Credits
- `0f0a9bc` — 7A: bills list + new/edit bill form
- `700cd1e` — 7B: bill detail page + lifecycle actions
- `787c510` — 7C: payments table + record-payment dialog + reverse payment
- `52e88a9` — 7D: vendor credits list + detail + new/edit + lifecycle
- `21b4769` — 7E: apply VC to bill + reverse application

#### GUI 8 — Admin
- `c0dd203` — 8A: admin hub + users list/create/edit
- `86b6252` — 8B: admin settings + GL accounts + payment terms
- `70bda48` — 8C: audit log + fiscal periods

### Document templates

- `bf49785` — Doc-A: shared print chrome (`DocumentShell` / `DocumentHeader`) + invoice + sales order documents
- `41e82ab` — Doc-B: PO + pick sheet + packing slip documents

### Bug-fix arc (post-GUI browser testing)

- `8e7794f` — Browser-test bug-fix pass (7 of 9 bugs fixed; #3 inline product create + #9 qty shipped deferred for design)
- `5ea8ef4` — Fix `ap.aging` pagination test flake (cross-file data contamination — added unlimited fetch + slice equivalence assertions)
- `fca72f0` — Bug #3: inline "+ Create product" quick-create on bill variant picker (new `Combobox` primitive wrapping `@base-ui/react/combobox`; `createProduct` extended to atomically seed a default variant)
- `009f590` — Bill PRODUCT-line description optional; JE regex accepts 6+ digits (sequence overflow fix in `gl.post.test.ts` + `fiscalPeriods.lifecycle.test.ts`)

### Status reversion + add lines (final pre-pilot slice)

- `81a5b0c` — SO close: inline per-line `qtyShipped` editor + invoice on shipped basis (bug #9). Auto-saves on blur via new `PATCH /api/sales-orders/[id]/lines/[lineId]`; `closeSalesOrder` defaults to the saved value; `generateInvoiceForClosedSOTx` switched from `qtyOrdered` → `qtyShipped` so partial shipments invoice correctly.
- `fcf9375` — Sales order reversion (un-dispatch, reopen) + add lines on confirmed. Schema migration: `Invoice.salesOrderId` → nullable (Postgres treats multiple NULLs as distinct under the unique index, so partial unique behavior preserved). Reopen flow: reverse COGS, restore inventory (with manual-ADJUST fallback for zero-FIFO lines), unlink invoice, restore reservations or zero per target. Add-lines flow: new `addSalesOrderLines` service for CONFIRMED orders with immediate reservation + credit-limit re-check.
- `53391a5` — Fix un-dispatch / reopen dialogs vanishing mid-flight. Root cause: dialogs were rendered inside `DropdownMenuContent`'s portal; when the menu auto-dismissed (operator's click on the dialog action landed outside the menu's content boundary), the menu portal unmounted and took the dialog's open state with it. Fix: lift dialog state up to `LifecycleActions`, render dialogs as siblings of the `DropdownMenu`.

---

## Current state

- **Tests**: 76 files, **934 passing** (Vitest integration suite). Typecheck clean, lint clean.
- **HEAD**: `53391a5` on `main`.
- **Total commits**: 146.

### Modules end-to-end functional
- **Foundation**: multi-instance schema, audit log, advisory locks, sequences, encryption at rest
- **Products & Inventory**: parent product + variant + warehouse, ledger-based stock with FIFO layers + WAC, audited movement service
- **Customer master**: types, addresses, contacts, payment terms, sales reps, credit limit + AR-hold, tax-exempt + resale cert, customer-specific pricing (CSV importer), CIM payment-method tokens, encrypted document storage, activity log, tags + categories
- **Sales Orders**: DRAFT → CONFIRMED → DISPATCHED → CLOSED + CANCELLED, reservation, credit-limit gate, qty-shipped inline editor, status reversion (un-dispatch, reopen with optional payment unapply), add-lines-on-confirmed
- **Purchase Orders + Receipts**: M:N model, partial receipts, receive-reverse
- **Invoicing / AR**: auto-invoice on SO close (billed on `qtyShipped`), AR JE, payment + apply + reverse, credit memo lifecycle with FIFO auto-apply, RMA + `creditFromRma` atomic flow, AR aging
- **Bills / AP**: bill lifecycle, receipt → draft-bill hook, bill payment with overpayment → auto-VC, vendor credit lifecycle with manual application, AP aging
- **GL / Costing / Reports**: FIFO layer engine, WAC reporting, retroactive COGS posting, late landed cost, fiscal period close (soft + hard) with reconciliation, all 8 reports + 6 dashboard widgets
- **Commission engine**: revenue + margin bases, accrual + reversal, per-rep report
- **Auth + RBAC**: BetterAuth, user model, every API route gated, bootstrap super-admin
- **Admin GUI**: users, GL accounts, payment terms, settings, audit log, fiscal periods

### Documents shipping today
- Invoice
- Sales order
- Purchase order
- Pick sheet
- Packing slip

### Reports shipping today
- Trial balance
- Balance sheet
- Income statement
- GL detail
- Journal
- Sales by customer
- Sales by item
- Inventory valuation
- Cash position

---

## Remaining work for pilot launch

Phases 10–14 in `CLAUDE.md`'s tracker.

1. **Integrations** — currently `⏳ CURRENT` in `CLAUDE.md`. The three remaining:
   - **Shopify** — pull orders + push fulfillment status
   - **Authorize.Net runtime** — CIM tokens already encrypted; runtime charge + refund paths need wiring
   - **Mailgun** — invoice + statement email send; PDF render-and-store hook on first send

2. **Document / email templates + admin UI** — operator-editable headers / footers / signature blocks per document type.

3. **Migration tooling + Naked Kratom data import** — `scripts/migrate-data.ts` per `docs/10-deployment-migration.md`. Needs source-schema mapping + a parallel-run report.

4. **Parallel run** — both ERPs running, operator enters every transaction in both, daily reconciliation. Duration TBD with the user.

5. **Cutover** — point production traffic at the new ERP. Old ERP read-only.

---

## Deferred post-pilot (`docs/11-deferred-v2-plus.md`)

Designed-against but explicitly **not** built for v1. Don't introduce schema or code that breaks these:

- **ShipStation integration** (manual labels for pilot)
- **Customer portal** (operator-facing only at pilot launch)
- **Vendor portal**
- **Drop-ship module** (architecture designed — commission-from-gross, not pay-out — but the implementation is post-pilot)
- **Pack hierarchy** (one variant = one sellable unit at pilot)
- **Multi-warehouse / stock transfers** (single-warehouse at pilot)
- **Quantity-break + cost-plus pricing rules** (the resolver has the branch shapes; the rule data + UI come later)
- **Lot / batch tracking**
- **Custom report builder** (canned reports only at pilot)
- **Email scheduling** (immediate send only at pilot)
- **Crypto key rotation** — currently a single static key per instance; needs key id stored alongside ciphertext + resolver registry + re-encrypt sweep before the next instance ships.

---

## Reference

- **Spec**: `docs/01-foundation.md` through `docs/12-glossary.md` (source of truth — do not deviate without discussion)
- **Audit doc**: `docs/audits/2026-05-03-backend-inventory.md` (pre-GUI audit findings and dispositions)
- **Build instructions for Claude Code**: `CLAUDE.md` (rules, tech stack lock, current phase tracker)
- **Migrations**: `prisma/tenant/migrations/` — history is preserved; the `_prisma_migrations` table records what's been applied
