# Back-end inventory audit — 2026-05-03

**Baseline:** commit `9a9e287` (Costing engine Part 5: FifoLayer backfill script + CLI), main branch, working tree clean, 446/446 tests green (44 files, 34.76s).

**Method:** read-only pass. For each module: SCOPE → SERVICE LAYER (with parameters + completeness notes) → SCHEMA → TEST COVERAGE → API LAYER → MISSING → PILOT-READY VERDICT → PERMISSION GATING. Pilot deferrals (drop-ship, customer portal, vendor portal, ShipStation, multi-warehouse, pack hierarchy, lot/batch, build/assembly, qty-break + cost-plus pricing, custom report builder, email scheduling) are excluded from gap counts.

---

## SUMMARY

### Audit verdict counts

| Module | Verdict | One-line |
|---|---|---|
| 01 Foundation | ⚠️ PARTIAL | audit/sequences/locks/crypto/Decimal solid; auth + RBAC + soft-delete middleware + provisioning script all 0% |
| 02 Products & Inventory | ⚠️ PARTIAL | costing engine strong (~109 tests); pricing resolver incomplete (3 of 6 rules); master-data CRUD un-audited (🐛); bundles + reorder fields missing |
| 03 Customers | ⚠️ PARTIAL | most complete module (~82 tests, 11 services, 20+ APIs); credit limit + AR hold stored but never enforced; commission engine + tier-discount-storage missing |
| 04 Vendors & Purchasing | split — ✅ READY for PO + Receipt lifecycle (~24 tests) / ❌ NOT STARTED for Vendor master | Vendor schema is a stub; no service, no API, no contacts/payment-methods/catalog |
| 05 Sales Orders | ⚠️ PARTIAL | lifecycle is the most carefully built piece outside costing (~28 tests, advisory locks deadlock-safe, INSUFFICIENT_STOCK_AT_CLOSE pattern); credit-limit bypass + duplicate helper + OnHand/Available helper missing; two deliberate scope cuts await user buy-in |
| 06 Invoicing & AR | ⚠️ PARTIAL leaning STRONG | most heavily tested (~177 tests); full auto-invoice + payments + CMs + RMAs + AR aging; missing late fees + statements + refund flows + getOpenSosNotInvoicedTotal |
| 07 Accounts Payable | ❌ NOT STARTED | expected — CLAUDE.md flags as CURRENT phase; Module 06 is the design template; surfaces the receipt-time GL leg gap |
| 08 GL / Costing / Reporting | split — ❌ NOT STARTED for slice proper / ⚠️ PARTIAL for incidental foundation | `post()` + 9 seeded accounts + auto-JE wired across AR/COGS; COA hierarchy + period close + year-end + manual JE + all reports + dashboards 0%; **two GL counterpart-leg gaps in already-shipped code** |
| 09 Admin / Settings UI | ❌ NOT STARTED | Setting service + AuditLog schema solid; user/role/permission/auth/audit-search/hard-delete all 0%; depends on Module 01 master prereq |

**Tally:** 9 modules total — 0 fully ✅ READY / 5 ⚠️ PARTIAL (01, 02, 03, 05, 06) / 2 ❌ fully NOT STARTED (07, 09) / 2 SPLIT verdict (Module 04: PO+Receipt READY, Vendor master NOT STARTED; Module 08: `post()` foundation PARTIAL, slice proper NOT STARTED).

### Two SUMMARY-level findings carried forward across the audit

1. **Auth + RBAC + soft-delete middleware + provisioning is the master prereq for write-surface GUI.** Every module's API routes carry `// TODO: wire requirePermission()`. Read-only GUI screens (lists, detail views, dashboards) can ship in parallel with this build behind a simple "is logged in?" stub.
2. **Read-only screens can ship in parallel.** Listing screens, dashboards, view-only detail pages — none of them block on the full RBAC stack landing, only on a logged-in check.

### Highest-priority back-end gaps to close BEFORE GUI

Ordered by priority. Each item: name, scope, size, leverage.

**#1 — GL COUNTERPART LEG FIX (Modules 07 + 08)**
- Scope: `postReceipt` missing `DR Inventory / CR Accrued Receipts`; `createAdjustmentTx` missing `DR Inventory Adjustment Expense / CR Inventory`; both reverse paths.
- Size: ~80 lines + ~15 tests + 2 GL account seeds (2020 Accrued Receipts, 5200 Inventory Adjustment Expense).
- Leverage: **Trial balance ties for ALL inventory-side events.** Pilot parallel-run reconciliation per `docs/10` requires trial balance to tie for 2+ consecutive weeks; with these gaps it can't tie regardless of operator care. Ranked above credit-limit and the audit bug because every other gap is feature-missing or feature-mis-implemented; these two are "the books don't balance for already-shipped paths." Single-commit slice, independent of the full AP slice.

**#2 — MODULE 02 AUDIT BUG**
- Scope: `products.ts` / `variants.ts` / `warehouse.ts` carry stale `// TODO: wire audit() once lib/audit exists` even though `lib/audit/audit.ts` exists and is used everywhere else; CRUD mutations skip audit logging.
- Size: ~6 lines per service file × 3 files = ~18 lines.
- Leverage: Prevents GUI from silently shipping audit-gap mutations from day one. Smallest tractable fix in the entire audit.

**#3 — AUTH + RBAC + SOFT-DELETE MIDDLEWARE + PROVISIONING (Module 01)**
- Scope: BetterAuth integration + `User` / `Role` / `Permission` / `RolePermission` / `UserRole` / `Session` / `Account` / `VerificationToken` schema; `requirePermission()` helper + permission constants taxonomy (see canonical list below); soft-delete Prisma middleware; `scripts/provision-instance.ts`; password policy validator.
- Size: Slice-sized (1-2 weeks).
- Leverage: Master prereq for ALL write-surface GUI work. Read-only screens can ship in parallel with this build.

**#4 — CREDIT LIMIT + AR HOLD ENFORCEMENT (Modules 03 + 05 + 06)**
- Scope: `getOpenSosNotInvoicedTotal(db, customerId)` helper (~15 lines, lib/ar/openSos.ts) + structured `CreditLimitExceededError` class + wire into `createSalesOrder` + `confirmSalesOrder`.
- Size: ~50 lines + ~15 tests.
- Leverage: Closes the credit-limit loop. `arBalanceForCustomer` already returns the AR side; just need the in-flight SO total + wire-in. Manager-override path waits for RBAC; basic block-on-breach can ship now. Confirmed at three call sites (Module 03 §03.O/P, Module 05 §05.N, Module 06 §06.W).

**#5 — TIER_DISCOUNT DATA + RESOLVER WIRE-IN (Modules 02 + 03)**
- Scope: Pick storage location (recommended: Setting key `tier_discount_percentages` mapping `CustomerType → discount%`); wire TIER_DISCOUNT case into `resolvePrice`; revisit "lowest of applicable" semantic vs current priority-order per spec.
- Size: ~80 lines + ~25 tests.
- Leverage: Wholesale-first pilot needs blanket tier discounts. Without this, every SO line falls through to BASE_PRICE for any customer that should get a tier discount. Three storage options open (Setting, CustomerCategory, new TierDiscount table) — Setting recommended for simplicity.

**#6 — VENDOR MASTER CRUD (Module 04)**
- Scope: Vendor master CRUD service + API + contacts + payment methods (encrypted, using `customerDocuments` pattern) + product catalog. Mirrors Customer master shape but smaller (no portal, no shadow-customer drop-ship complexity, no CIM integration for pilot).
- Size: ~4-6 days solo with Claude Code.
- Leverage: Unblocks all vendor-side GUI work. PO entry depends on it. Today vendor records have to be created via raw SQL.

**#7 — REAL-TIME OnHand/Available HELPER (Module 05)**
- Scope: `getLineEntryStock(db, variantId, warehouseId)` returning `{ onHand, reserved, available }` for SO line entry display.
- Size: ~30 lines + ~5 tests.
- Leverage: SO line entry GUI needs this for stock context display per spec; without it every line entry does a multi-call dance.

**#8 — DUPLICATE-ORDER HELPER (Module 05)**
- Scope: `duplicateSalesOrder(db, sourceId, ctx)` → new DRAFT SO with same lines/discounts; new SO #, dates + shipping reset.
- Size: ~50 lines + ~5 tests.
- Leverage: Common workflow per spec ("Duplicate" button); small fix.

### Recommended GUI screen order

Based on backend strength: Module 06 strongest; Module 03 close behind; Module 05 ready behind prereqs (#3 + #4 + #5).

**PHASE 1 — parallel with Auth/RBAC build (#3)**
- Login screen (waits for #3 to land)
- Read-only inventory list / detail
- Read-only customer list / detail
- Read-only PO list / detail
- Read-only invoice list / detail with payment history
- Customer aging detail + aging summary widget (Module 06's `agingForCustomer` + `agingSummary` are render-only data)

**PHASE 2 — after #3 lands (only)**
- Customer master CRUD (full create/edit/disable)
- Sales rep + payment term + customer category admin
- Restocking fee + negative-inventory-allowed admin
- Audit log search + filter + export (Module 09's missing read path)

None of Phase 2's items needs #1 (GL leg blocks only inventory write paths), #2 (audit bug blocks only products/variants/warehouses), or #4 (credit-limit blocks only SO create/confirm). Phase 2 starts as soon as #3 lands and runs IN PARALLEL with #1 / #2 / #4 / #5 work. This enables a two-track build: one track on RBAC + customer screens, another track on the small back-end fixes. Both tracks converge before Phase 3 unlocks.

**PHASE 3 — after Phase 2 + #5 + #7 + #8**
- Sales order entry — DRAFT through CLOSED with line-entry stock context
- Payment recording (record, apply, reverse)
- Credit memo create / confirm flow
- RMA workflow (state machine UI)

**PHASE 4 — after #6 (Vendor master)**
- Vendor master CRUD
- PO entry through receipt
- Receipt posting workflow

**PHASE 5 — after AP slice + GL slice land**
- Bill entry + vendor payment recording
- Vendor credit workflow
- Financial reports (Trial Balance, P&L, Balance Sheet, Cash Flow, GL Detail, Journal)
- Operational dashboards

### Permission constants taxonomy

Canonical list consolidated from Modules 02–08's (h) sections, grouped by domain. To be authored as `src/lib/permissions/constants.ts` when Module 01's RBAC slice lands.

```text
# Customer
customers.read
customers.write
customers.read_sensitive_documents          # cleartext EIN/SSN/DL access
customers.import_price_overrides            # bulk CSV — high blast radius

# Sales Order
salesOrders.read
salesOrders.create
salesOrders.edit_draft
salesOrders.confirm
salesOrders.dispatch
salesOrders.close
salesOrders.cancel
salesOrders.manual_price_override
salesOrders.override_credit_hold            # pairs with credit-limit fix (#4)
salesOrders.soft_delete

# Inventory
inventory.read
inventory.adjust
inventory.transfer_initiate                 # multi-warehouse deferred but constant defined for v1+
inventory.transfer_receive
inventory.recalc_fifo                       # admin trigger of backfillFifoLayers

# Product / Variant / Warehouse
products.read
products.write
variants.read
variants.write
warehouses.read
warehouses.write

# Vendor / PO
vendors.read
vendors.write
vendors.read_sensitive_payment_info         # encrypted ACH/wire/check info
purchaseOrders.read
purchaseOrders.create
purchaseOrders.confirm
purchaseOrders.cancel
receipts.read
receipts.create
receipts.post
receipts.cancel

# Bill / AP (when slice lands)
bills.read
bills.create
bills.confirm
bills.void
bills.cancel
vendorPayments.read
vendorPayments.record
vendorPayments.reverse
vendorPayments.apply
vendorCredits.read
vendorCredits.create_draft
vendorCredits.confirm
vendorCredits.cancel
vendorCredits.apply
ap.read_aging
ap.read_cash_requirements

# Invoice / AR
invoices.read
invoices.void
payments.read
payments.record
payments.apply
payments.reverse
creditMemos.read
creditMemos.create_draft
creditMemos.confirm
creditMemos.void
creditMemos.apply
rmas.read
rmas.create
rmas.transition
rmas.credit
ar.read_aging

# GL / Reporting
gl.read_accounts
gl.write_accounts
gl.post_manual_je                           # heavily restricted
gl.reverse_je
gl.close_period_soft
gl.close_period_hard
gl.override_closed_period                   # master key — permission + reason
gl.close_year_end
gl.read_trial_balance
gl.read_income_statement
gl.read_balance_sheet
gl.read_cash_flow
gl.read_general_ledger
gl.read_journal_report

# Reports
reports.run_operational
reports.build_custom                        # deferred
reports.schedule                            # deferred

# Dashboard
dashboard.read

# Admin
admin.read_audit_log
admin.export_audit_log                      # CSV export — separate from read
admin.write_settings
admin.write_users
admin.write_roles
admin.system_health                         # recalc utilities, orphan detection, etc.
admin.hard_delete                           # Super Admin gate, requires reason

# Settings (per-key writes can ride under admin.write_settings or have own gates)
settings.write_restocking_fee_default
settings.write_negative_inventory_allowed
# (more keys land as registry expands per Module 09 §09.P)
```

### Open user questions

1. **Commission engine for Naked Kratom.** Do their sales reps work on commission, or are they salaried? If commissioned, the engine (Module 03 §03.M/N) is fix-before-GUI. If salaried, defer entirely.
2. **Module 05 deliberate scope cuts.** Both are documented in code with intentional error messages — confirm acceptable for pilot or fix:
   a. **DRAFT-only updates** (spec wants any-pre-CLOSED-status). Workaround: cancel + recreate (loses SO number history).
   b. **Post-CLOSED cancellation refused entirely** (spec wants allowed-with-confirmation). Workaround: RMA path.
3. **Wholesale application + backorder queue staff-side flows.** Both are tied to the deferred portal in spec, but each has a staff-side workflow that could land without the portal. Cheap to ship the data model + admin-only UI; hard to retrofit later. Yes for pilot or defer with portal?
4. **Tier discount % storage.** Three options: Setting (recommended — single tenant-wide map of CustomerType → discount %, no schema change), CustomerCategory (add discount-% column), or new `TierDiscount` table. Pick one before #5 starts.
5. **Refund handling for pilot.** Rely on `reversePayment` + manual check workflow (acceptable, with bank-reconciliation gap), or build refund-via-AP-entry path before pilot? Authorize.Net runtime is deferred regardless; the question is whether the manual-AP path is needed pre-cutover.

### Pilot deferrals (re-confirmed from `docs/10`)

Items in this list don't count as gaps:

- **ShipStation integration** (manual labels for now)
- **Customer portal** entirely (and all portal-tied features: dispute flag, auto-pay, deposit-as-prepay UX, backorder portal flow)
- **Vendor portal** entirely
- **Drop-ship module** entirely (commission, shadow customer, JE pairs, monthly invoicing, late fees, auto-split at Confirmed, manual split-by-vendor, drop-ship vendor catalog feeds)
- **Pack hierarchy** (base unit / display / master / pallet)
- **Build / assembly module** (BOM, work orders, partial builds, assembly costing)
- **Multi-warehouse / stock transfers** (per-warehouse inventory accounts, two-step transfer workflow, multi-warehouse fulfillment splits, multi-warehouse PO bulk-edit)
- **Quantity break + cost-plus pricing** (resolver branches, per-tier qty-break tables)
- **Lot / batch / expiration tracking**
- **Custom report builder** (drag-drop UI; canned reports only for pilot)
- **Email scheduling** (no recurring report emails)
- **2FA enforcement** (basic email/password sufficient; spec defers IP-fingerprint trigger and authenticator app)
- **Authorize.Net runtime integration** (token-storage schema is correct; live API calls deferred)
- **Mailgun runtime integration** (template rendering deferred to template phase)
- **Recurring bill templates** (explicit v1 spec cut, not pilot-only)
- **3-way match enforcement** (warning-only is v1 stance)
- **1099-NEC reporting** (v2+)
- **ACH/wire/check printing automation** (v2+)
- **Bank reconciliation** (v2+)

### Cross-cutting design observations — gold-standard patterns

These six patterns showed up as the strongest design choices in the audited code; reuse as templates when adjacent slices land:

1. **`CreditApplication` design (Module 06)** — single source of truth for "this dollar applied to that dollar." `kind` enum (PAYMENT_TO_INVOICE / CREDIT_TO_INVOICE), nullable paymentId / creditMemoId, two partial unique indices on `(paymentId, invoiceId)` and `(creditMemoId, invoiceId)` filtered by `reversedAt IS NULL` — prevents multi-applying while live. Reversed apps kept (not deleted) so audit trail survives. **Template for `BillPaymentApplication` when AP slice lands.**

2. **Encrypted-at-rest with audited cleartext read (Module 03 — `customerDocuments`)** — gold-standard per user feedback. AES-256-GCM via `lib/crypto`; `redactForAudit` strips ciphertext + IV from every audit/activity payload; `readEncryptedValue` writes SENSITIVE_READ AuditLog row BEFORE decrypt attempt (tampered-ciphertext attempts get logged); Cache-Control: no-store on the HTTP cleartext endpoint; caller-obligation contract documented in long header comment. **Template for `BankAccount` (Module 09) and `VendorPaymentMethod` (Module 04) when those slices land.**

3. **`arBalance` vs `unappliedCreditBalance` returned separately, never netted (Module 06)** — a customer with no open invoices and $50 unapplied returns `{ arBalance: 0, unappliedCreditBalance: 50 }`, not `{ arBalance: -50 }`. Two complementary fields preserve the operational distinction between "they owe us" and "we owe them." **Template for AP side: `apBalance` vs `vendorCreditBalance` separately, never netted.**

4. **Atomic close-with-COGS-post-and-invoice-generation (Module 05 `closeSalesOrder`)** — one transaction wraps consume → SOLine update → status flip → reserved recompute → `generateInvoiceForClosedSOTx` → `postCogsForInvoiceTx`. Either all succeed or all roll back. INSUFFICIENT_STOCK_AT_CLOSE audit row written via outer-db client AFTER inner-tx rollback so the visibility signal survives. **Template for Bill-confirm-and-AP-post when AP slice lands.**

5. **`lib/gl/post()` as single sanctioned JE path (Module 08)** — XOR-per-line + non-negative validation; balance check at full Decimal precision; idempotency on `(entityType, entityId, description)` with `reversedAt:null`; batched account-code resolution; `JE-YYYY-NNNNN` numbering; optional backdated `postedAt`; `createdAt` never overridden. CLAUDE.md non-negotiable: never call `tx.journalEntry.create` directly. **Reuse for all auto-JE — receipt-leg fix, adjustment-leg fix, AP slice, manual JE, period close, year-end close.**

6. **Self-healing recompute helpers** — `recomputeReservedForBin` (Module 05), `recomputeAmountPaidForInvoice` (Module 06), `recomputeQtyReceivedForPoLine` (Module 04), `recomputeOnHand` (Module 02). Each derives a denormalized counter from a SUM over its source-of-truth rows; clamps negative drift to 0 with warn-log; never mutated by direct `update` outside the helper. **Template for AP-side equivalents: `apBalanceForVendor`, `recomputeAppliedAmountForBill`, `recomputeAmountPaidForBill`.**

---

## Module 01 — Foundation

### (a) SCOPE

Per `docs/01-foundation.md` and CLAUDE.md non-negotiables, v1 requires:

| ID | Capability |
|---|---|
| 01.A | Multi-instance architecture: per-company DB, per-company subdomain, per-company file storage, per-company users |
| 01.B | Provisioning script — spin up new company instance in ~1 hour |
| 01.C | Money precision — `Decimal(18,5)` for unit cost/price, USD-only v1, nullable `currency` field |
| 01.D | Audit logging — every sensitive action (CREATE/UPDATE/DELETE/STATUS_CHANGE/VOID/REVERSE/REFUND/PERMISSION_CHANGE/CONFIG_CHANGE/LOGIN/LOGOUT) with timestamp, user, action, entity, before/after, IP, reason; append-only |
| 01.E | Soft-delete by default — major entities flagged inactive; hard-delete only for Super Admin with passing dependency check |
| 01.F | Permissions — two-tier (Super Admin + Custom Roles), checkbox-defined, server-side checks via `requirePermission()` helper |
| 01.G | Self-serve admin (config tables editable without dev) — substance lives in Module 09; cross-cutting infra (Setting model) lives here |
| 01.H | Authentication — email/password, 2FA on unrecognized IP, optional authenticator app, password policy (8 chars, upper/lower/numbers/special), no expiration, no auto-logout. **Pilot deferral: 2FA enforcement (per `docs/10`).** |
| 01.I | Sequence helper (used cross-module for PO#, Receipt#, SO#, Invoice#, CM#, Payment#, JE#, RMA#) |
| 01.J | Advisory locks (used cross-module for inventory bin contention + SO reservation/consume) |
| 01.K | Field-level encryption for sensitive customer scalars (EIN, SSN, DL number) |

### (b) SERVICE LAYER

| Scope | File | Function(s) | Parameters | Completeness notes |
|---|---|---|---|---|
| 01.D | `src/lib/audit/audit.ts` | `audit(client, args)` | `client: AuditClient`, `args: { action: AuditAction, entityType: string, entityId: string, before?: unknown, after?: unknown, ctx?: { userId?, ipAddress?, reason? } }` | Does NOT pull userId from session (no auth yet — caller passes it). Does NOT auto-capture IP (caller passes it). |
| 01.I | `src/lib/sequences/sequences.ts` | `getNextSequence(tx, args)` | `tx: Prisma.TransactionClient`, `args: { name: string, prefix: string, useYear: boolean, now?: Date }` | Format `PREFIX-YYYY-NNNNN` (annual reset, 5-digit pad) or `PREFIX-NNNNNNN` (no reset, 7-digit pad). Idempotent first-allocation seed. Does NOT support custom format strings or per-warehouse subsequences. |
| 01.J | `src/server/services/locks.ts` | `lockKey(s)`, `lockBin(tx, variantId, warehouseId)`, `lockBinsOrdered(tx, variantId, warehouseA, warehouseB)` | `s: string` → int32; `tx`, `variantId`, `warehouseId(s): string` | Uses `pg_advisory_xact_lock(int4, int4)` keyed on (variant, warehouse) sha256 prefix. Does NOT support arbitrary lock keys (only the bin pattern). Does NOT support session/connection-level locks. |
| 01.K | `src/lib/crypto/index.ts` | `encrypt(plaintext)`, `decrypt(ciphertext, iv)` | `plaintext: string` → `{ciphertext, iv}` (base64); `ciphertext, iv: string` → plaintext | AES-256-GCM, 96-bit IV, 128-bit auth tag. Single static key from `TENANT_FIELD_ENCRYPTION_KEY` env. Does NOT support key rotation (CLAUDE.md flags as acceptable-for-pilot, must add before scaling). Does NOT emit `SENSITIVE_READ` audit row — that's the caller's job. |
| 01.A | `src/lib/db.ts` | `db: PrismaClient` (module-level singleton) | n/a | Single Prisma client per process pointed at `TENANT_DATABASE_URL`. Multi-instance is realized at deployment time (one process per company, separate env var per deploy), NOT via subdomain → DB routing inside one process. No tenant resolver, no per-request DB switching. Adequate for the pilot's single-tenant deploy model; will need rework if multi-tenant-in-one-process is ever desired. |
| 01.C | (schema-enforced) | n/a | n/a | Every money column in `prisma/tenant/schema.prisma` is `@db.Decimal(18, 5)`. Service code uses Prisma's `Decimal` (decimal.js). No central money helper exists, but the convention is consistently applied — verified against schema. |
| 01.B | ❌ MISSING | — | — | `scripts/provision-instance.ts` is referenced in CLAUDE.md but does not exist. Existing scripts dir contains only manual test scripts and the FIFO backfill CLI. |
| 01.E | ❌ MISSING (centralized) | — | — | No Prisma middleware enforces soft-delete query filtering. CLAUDE.md says "Use Prisma middleware to enforce soft-delete on major entities" — not implemented. Each service hand-writes `where: { deletedAt: null }`. No hard-delete dependency-check helper exists. |
| 01.F | ❌ MISSING | — | — | `src/lib/permissions/` directory does not exist. `requirePermission` / `hasPermission` / `checkPermission` are not defined anywhere. Every API route in `src/app/api/` carries a literal `// TODO: wire requirePermission() once lib/permissions exists` comment. |
| 01.H | ❌ MISSING | — | — | No BetterAuth integration. No login / logout / signup endpoints. No password hashing. No session model. No 2FA scaffolding. No password-policy validator. |

### (c) SCHEMA

Models present in `prisma/tenant/schema.prisma`:

- ✅ `AuditLog` — full spec match: `userId`, `action` (enum w/ all required values), `entityType`, `entityId`, `beforeJson`, `afterJson`, `reason`, `ipAddress`, `createdAt`, plus indexes on `(entityType, entityId, createdAt)` / `(userId, createdAt)` / `(action, createdAt)` / `createdAt`.
- ✅ `Sequence` — generic monotonic counter with optional annual reset.
- ✅ `Setting` — generic admin key/value store (JSON value validated by per-key Zod schemas in service layer). `updatedBy` is nullable until auth ships.
- ⚠️ Soft-delete: `deletedAt: DateTime?` is present on every major entity (Product, ProductVariant, Warehouse, Vendor, Customer, PurchaseOrder, Receipt, SalesOrder, Invoice, Payment, CreditMemo, Rma, GlAccount, FifoLayer, etc.) — schema is consistent, but lacks centralized middleware enforcement.

❌ Missing entirely:
- `User` / `Account` / `Session` / `VerificationToken` (BetterAuth schema doesn't exist)
- `Role` / `Permission` / `RolePermission` / `UserRole`
- No FK on any `userId` / `createdById` / `postedById` / `appliedById` / `reversedBy` field — they're plain `String?` placeholders. CLAUDE.md / schema comments confirm this is intentional ("users live in BetterAuth's auth schema, not the tenant schema").

### (d) TEST COVERAGE

| File | Test count | Covers |
|---|---|---|
| `tests/unit/crypto.test.ts` | 8 `it(`s | Round-trip encrypt/decrypt, IV uniqueness, auth-tag tampering rejection, IV-length validation, ciphertext-too-short rejection, empty plaintext, key-loading errors |
| `tests/integration/sequences.test.ts` | 4 `it(`s | Monotonic increment, annual reset, idempotent first-allocation under contention, format/padding |

Indirect coverage (no dedicated test file):
- `audit()` helper — exercised by every service-layer test that triggers an audited mutation (lifecycle, duplicates, void, reverse paths). No isolated unit test of the helper itself; coverage is incidental.
- Advisory locks (`lockBin` / `lockBinsOrdered`) — exercised by `tests/integration/movements.concurrency.test.ts`, `tests/integration/salesOrders.concurrency.test.ts`. No isolated lock unit test.
- Money precision (Decimal columns) — verified implicitly by COGS / GL / WAC / pricing tests.

NOT covered:
- Soft-delete enforcement (no test that an "accidentally" un-filtered query would leak deleted rows — because there's no middleware to test).
- Auth (nothing to test).
- RBAC (nothing to test).
- Provisioning (nothing to test).
- Subdomain routing (nothing to test).

### (e) API LAYER

❌ No `src/app/api/auth/**` routes
❌ No `src/app/api/users/**` routes
❌ No `src/app/api/admin/**` routes (no roles, no permissions, no audit-log read endpoint)

⚠️ `src/app/api/settings/restocking-fee-default/route.ts` exists as a single key-specific endpoint — generic settings CRUD does not exist yet.

### (f) MISSING / STUBBED

- [ ] `BetterAuth` integration — install, config, schema, login/logout/signup endpoints
- [ ] `User`, `Role`, `Permission`, `RolePermission`, `UserRole`, `Session` models (or BetterAuth's prescribed schema variant)
- [ ] `src/lib/permissions/` directory — `requirePermission()`, `hasPermission()`, permission constants
- [ ] Server-side permission middleware for API routes (every route currently carries the TODO comment)
- [ ] Soft-delete Prisma middleware (`$use` or extension) — required by CLAUDE.md non-negotiable rule
- [ ] Hard-delete dependency-check helper (Super-Admin path)
- [ ] `scripts/provision-instance.ts` — referenced in CLAUDE.md, does not exist
- [ ] Subdomain → DB-URL resolver (or explicit doc that multi-instance is deployment-only and inline routing won't be built)
- [ ] Password policy validator (8 chars, upper/lower/numbers/special)
- [ ] Login / logout audit emission (depends on auth landing first)
- [ ] User attribution wiring on every `createdById` / `userId` / `postedById` / `appliedById` / `reversedBy` field (currently nullable plain strings)
- [ ] Crypto key rotation (deferred-acceptable for pilot per CLAUDE.md, listed for completeness)
- [ ] Generic `Setting` CRUD endpoint (single-key endpoint exists but no admin list/edit path)
- [ ] 2FA (deferred for pilot per `docs/10`; tracked here so it's not lost — does NOT count against pilot verdict)

### (g) PILOT-READY VERDICT

**⚠️ PARTIAL.**

Cross-cutting infra that's actually exercised by other modules — audit, sequences, advisory locks, crypto, money precision — is solid and tested. But the user/auth/RBAC stack is empty: no `User` model, no `requirePermission()` helper, no login. That's blocking for any GUI write surface. Soft-delete middleware and the provisioning script are also missing per CLAUDE.md non-negotiables.

The deployment-time multi-instance model (one process per company, separate `TENANT_DATABASE_URL`) is functional in tests, so 01.A is "fine for pilot" even without subdomain routing.

### (h) PERMISSION GATING

**No permission gating in the foundation layer.** Every service assumes the caller has authorized. API routes uniformly carry `// TODO: wire requirePermission() once lib/permissions exists`. This is the single largest blocker for GUI work — read-only listing screens can ship behind a simple "is logged in?" check, but every write screen needs `requirePermission()` callable on the server boundary first.

Recommendation: before opening any GUI write screens, build:
1. BetterAuth integration + `User` / `Role` / `Permission` schema
2. `src/lib/permissions/{constants,require}.ts` with the permission checkbox names from `docs/09-admin.md`
3. Server-action / API-route middleware that calls `requirePermission()` for every mutation
4. Soft-delete Prisma middleware

Read-only GUI work can run in parallel with that build-out.

---

## Module 02 — Products & Inventory

### (a) SCOPE

Per `docs/02-products-inventory.md`, v1 requires (with pilot deferrals removed):

| ID | Capability | Pilot? |
|---|---|---|
| 02.A | Product types: SIMPLE, DROP_SHIP, SERVICE | partial — DROP_SHIP deferred |
| 02.B | Parent-product / child-variant model — variants own SKU/inventory/costing; product owns marketing fields | ✅ |
| 02.C | Product CRUD (create / update / archive / list / get-by-id / get-by-sku) | ✅ |
| 02.D | Variant CRUD (create / update / archive / list-for-product / get-by-id) | ✅ |
| 02.E | Warehouse CRUD | ✅ |
| 02.F | Inventory quantities tracked per (variant, warehouse): On Hand, Reserved, Available, On Order, In Transit | ✅ |
| 02.G | Inventory movements: ADJUST, RECEIVE, CONSUME, TRANSFER_OUT/IN, RECEIVE_REVERSE, RMA_RETURN | ✅ |
| 02.H | FIFO layers — created on RECEIVE, consumed oldest-first by CONSUME, deterministic tiebreaker | ✅ |
| 02.I | WAC — recomputed per (variant, warehouse), used for cost-plus + reference display | ✅ |
| 02.J | Last purchase cost — last PO price per (variant, warehouse) | ✅ |
| 02.K | Landed cost at receipt time — UNIT_COUNT, VALUE, WEIGHT, BOX_COUNT allocation methods bake into FIFO + WAC | partial — UNIT_COUNT + VALUE wired, WEIGHT + BOX_COUNT throw "deferred" |
| 02.L | Late landed cost retroactive — apply across receipts, mutate FifoLayer cost, post backdated COGS adjustment JEs, reversal path | ✅ |
| 02.M | RMA returns to inventory — new layer at original sale's FIFO cost | ✅ (lives in cogsReversal) |
| 02.N | Pricing resolver — 6 rules, runs all applicable, picks lowest, logs which rule fired | partial — only 3 of 6 wired (rules below) |
| 02.O | Negative inventory flag — tenant-wide default ALLOW, configurable per-warehouse / per-product | partial — tenant-wide flag exists; per-warehouse / per-product overrides do not |
| 02.P | Stock transfer two-step workflow (initiate at WH-A → in-transit → complete at WH-B with check-in) | DEFERRED (multi-warehouse) |
| 02.Q | Pack hierarchy (base unit / display / master / pallet) | DEFERRED |
| 02.R | Bundles (proportional price allocation, explode on order entry) | NOT pilot-deferred — gap |
| 02.S | Build / assembly (BOM, work orders, partial builds) | DEFERRED |
| 02.T | Lot / batch / expiration | DEFERRED |
| 02.U | Drop-ship costing (no FIFO, no COGS, commission model) | DEFERRED |
| 02.V | Reorder point per product / sales velocity inputs (downstream reports live in Module 08) | NOT pilot-deferred — schema gap |
| 02.W | Inventory adjustment reason taxonomy (breakage / loss / found / etc.) | NOT pilot-deferred — schema gap |
| 02.X | Stock context line `OnHand / Available` on internal docs | DEFERRED (PDF/template concern, Module 9) |
| 02.Y | Shopify sync rules (Shopify owns marketing; ERP owns inventory/cost/pricing) | DEFERRED (integrations phase) |

Pilot pricing rules (subset of 02.N) — only MANUAL_OVERRIDE, CUSTOMER_SPECIFIC, BASE_PRICE need to ship for pilot per the resolver's TODO comment, since QTY_BREAK / COST_PLUS are deferred and TIER_DISCOUNT / PROMO are not on the pilot deferral list but are still wired-by-deferral in the resolver.

### (b) SERVICE LAYER

| Scope | File | Function(s) | Parameters | Completeness notes |
|---|---|---|---|---|
| 02.C | `src/server/services/products.ts` | `createProduct(db, input)`, `updateProduct(db, id, input)`, `getProduct(db, id)`, `getProductBySku(db, sku)`, `listProducts(db, opts)`, `archiveProduct(db, id)` | `db: PrismaClient`, `input: ProductCreateInput` (Zod-validated) / `ProductUpdateInput`, `id: string`, `sku: string`, `opts: { skip?, take?, includeArchived? }` | 🐛 BUG (deferred): no `audit()` call on create/update/archive despite stale `// TODO: wire audit() once lib/audit exists` comment — audit helper exists and is used elsewhere. CLAUDE.md non-negotiable says master-data create/edit/delete must audit. Does NOT support: image attachments, tags, country-of-origin / HS-code / hazmat / production-tag / vendor-of-record fields (none in schema). Does NOT support hard-delete or restore-from-archive. |
| 02.D | `src/server/services/variants.ts` | `createVariant(db, input)`, `updateVariant(db, id, input)`, `getVariant(db, id)`, `listVariantsForProduct(db, productId, opts)`, `archiveVariant(db, id)` | `db`, `input: VariantCreateInput`/`VariantUpdateInput`, `id`/`productId: string`, `opts: { includeArchived? }` | 🐛 BUG (deferred): same un-audited mutation problem as products. Does NOT support: variant-level images, weight override, manufacturer-part-number editing (column exists in schema only on PurchaseOrderLine, not on Variant — schema gap vs. spec). |
| 02.E | `src/server/services/warehouse.ts` | `createWarehouse`, `updateWarehouse`, `getWarehouse`, `listWarehouses`, `archiveWarehouse` | `db`, `input: WarehouseCreateInput`/`Update`, `id`, `opts: { includeArchived? }` | 🐛 BUG (deferred): same un-audited mutation problem. Does NOT enforce single-warehouse pilot constraint (no Setting gating). |
| 02.F | `src/server/services/inventory.ts` | `getInventory(db, variantId, warehouseId)`, `listInventoryByVariant(db, variantId)`, `listInventoryByWarehouse(db, warehouseId, opts)` | `db`, ids, `opts: { skip?, take? }` | Read-only. Does NOT compute Available (`onHand - reserved`) — caller subtracts. Does NOT expose On Order (compute via PO query) or In Transit (compute via TRANSFER_OUT − TRANSFER_IN with no completion timestamp). |
| 02.G/H | `src/server/services/movements.ts` | `recomputeOnHand`, `createAdjustmentTx`, `receiveInventoryTx`, `consumeInventoryTx`, `transferInventoryTx`, `reverseReceiveTx`, plus public non-Tx wrappers (`createAdjustment`, `receiveInventory`, `consumeInventory`, `transferInventory`, `reverseReceive`) | each `Tx` variant: `(tx: Prisma.TransactionClient, input, ctx?: AuditContext)`; non-Tx wrappers wrap in `db.$transaction(...)` | All audit-logged. All advisory-locked via `lockBin` / `lockBinsOrdered`. CONSUME implements outcome-first decision tree (covered_by_layers / covered_by_onhand_no_layers / negative_allocation / throw). Transfer is **single-atomic OUT+IN**, NOT the two-step initiate-then-receive workflow the spec requires for multi-warehouse — but multi-warehouse is pilot-deferred so this is acceptable for now. Does NOT: emit GL entries for adjustments (deferred — Module 8 will add adjustment-specific JE posting). Does NOT: tag adjustments with reason category (breakage/loss/found) — only free-text `notes`. |
| 02.H | `src/server/services/fifoLayers.ts` | `createFifoLayerOnReceiveTx`, `consumeFromLayersTx`, `getOldestLayer`, `createFifoLayerForReturnTx` | `tx`, params per function | Layers immutable except via Part-4 landedCost mutation. CHECK constraint in schema enforces `qtyRemaining = qtyReceived - qtyConsumed`. SELECT FOR UPDATE serializes concurrent consumes. |
| 02.I | `src/server/services/wac.ts` | `computeWac(client, variantId, warehouseId)`, `getLastPurchaseCost(client, variantId, warehouseId)` | `client: PrismaClient \| Prisma.TransactionClient` | Pure compute (no cache column). Per-warehouse correctly. Does NOT support tenant-wide WAC; per-warehouse only. |
| 02.K/L | `src/server/services/landedCost.ts` | `applyLandedCostToReceipts(db, input, ctx?)`, `reverseLandedCostAllocation(db, allocationId, reason, ctx?)` | `db`, `input: { receiptIds, totalLandedCost, allocationMethod, notes? }` | UNIT_COUNT + VALUE wired. WEIGHT + BOX_COUNT throw "deferred to future slice." Does NOT gate on closed accounting periods (deferred — Module 8). Reverse path uses `originalUnitCost` snapshots. |
| 02.M | `src/server/services/cogsReversal.ts` | `reverseCogsForInvoiceTx(tx, invoiceId, ctx?)`, `reverseCogsForCreditMemoTx(tx, creditMemoId, ctx?)` | `tx`, ids, ctx | Restoration to inventory via new RMA_RETURN movement + new FifoLayer at consumption-derived cost. Goods-back / loss-reclass / pure-AR routing branches per CM category. |
| 02.N | `src/lib/pricing/resolve.ts` | `resolvePrice(tx, input)` | `tx`, `input: { variantId, customerId, qty: Decimal, manualUnitPrice?: Decimal \| null }` | Only **3 of 6** rules wired: MANUAL_OVERRIDE, CUSTOMER_SPECIFIC, BASE_PRICE. Missing: TIER_DISCOUNT (CustomerType blanket %), PROMO (date-bounded). Pilot-deferred: QTY_BREAK, COST_PLUS. Currently priority-order, NOT lowest-of-applicable per spec — but the resolver's own TODO acknowledges this. |
| 02.O | `src/server/services/negativeInventory.ts` | `getNegativeInventoryAllowed(client)` | `client` | Reads `Setting('negative_inventory_allowed')`. Tenant-wide only. Does NOT support per-warehouse or per-product overrides per spec. |
| 02.G | `src/server/services/backfillFifoLayers.ts` | `backfillFifoLayers(db, opts)` | `db`, `opts: { overrides?, dryRun?, ... }` | Repairs RECEIVE movements without FifoLayers (pre-Phase-1A receives or test fixtures). Per-movement transactional. Skip reasons: irrecoverable_no_cost_data, negative_qty, untracked_consume_in_bin, transaction_failed. |
| 02.J | `src/server/services/cogsPosting.ts` | `postCogsForInvoiceTx(tx, invoiceId, ctx?)` | `tx`, invoiceId, ctx | Wires DR 5100 / CR <warehouse-Inventory> JE per (invoice, warehouse). Idempotent. Lives more naturally in Module 8 (GL/Costing) but listed here too because it consumes Module 02's FIFO data. |
| 02.R Bundles | ❌ MISSING | — | — | No `Bundle` model, no bundle-explode service, no proportional-price allocator. Schema lacks the BOM-style table needed. |
| 02.V Reorder | ❌ MISSING | — | — | No `reorderPoint` / `reorderQty` field on Product or ProductVariant. No sales-velocity computer. Reports for "reorder suggestions" / "slow-moving" / "dead stock" don't exist (Module 8 territory but inputs land here). |
| 02.W Adjustment reasons | ❌ MISSING (taxonomy only) | — | — | `InventoryMovement.reference + notes` are free-text. No enum/category for adjustment reasons. Spec lists "breakage / loss / found stock" — not enumerated. |

### (c) SCHEMA

Models supporting Module 02:

- ✅ `Product` (parent), `ProductVariant` (child) — variant-level SKU, parent owns marketing fields. Note: schema lacks `manufacturerPartNumber` on Variant (only PO line carries it), and lacks `countryOfOrigin`, `hsCode`, `hazmat`, `productionTag`, `images`, `tags`, `vendor` (primary-vendor FK).
- ✅ `Warehouse` — code/name/active/inventoryAccountId.
- ✅ `InventoryItem` — `(variantId, warehouseId)` keyed; `onHand` + `reserved` Decimal(18,5). No `inTransit` column (compute via TRANSFER_OUT/IN).
- ✅ `InventoryMovement` — full enum coverage including RECEIVE_REVERSE and RMA_RETURN; `transferGroupId` for paired legs; indexes on `(variantId, warehouseId, createdAt)` etc.
- ✅ `FifoLayer` — qtyReceived/qtyConsumed/qtyRemaining/unitCost/receivedDate; CHECK constraint in DB; sourceReceiptLineId / sourceMovementId @unique; landed-cost mutation supported.
- ✅ `FifoConsumption` — per-layer breakdown of CONSUME; mutability rule documented (mutable until invoice.cogsPosted=true).
- ✅ `LandedCostAllocation` + `LandedCostAllocationLine` + `LandedCostAllocationReceipt` (M:N).
- ✅ `Setting` (used by negativeInventory).
- ❌ Missing entirely: `Bundle`, `BundleComponent`, `Assembly`/`BomComponent`, `WorkOrder`, `Lot`, `Batch`, `PackHierarchy` — all DEFERRED but called out so the gap list is explicit.
- ❌ `reorderPoint` / `reorderQty` fields on Product or Variant.
- ⚠️ Per-warehouse / per-product negative-inventory flag overrides — schema doesn't carry these.

### (d) TEST COVERAGE

Direct integration tests (counts via `it(`/`test(` block grep):

| File | Tests | Covers |
|---|---|---|
| `tests/integration/movements.concurrency.test.ts` | 1 | Concurrent CONSUME serialization on a bin (advisory-lock proof) |
| `tests/integration/movements.tx-variants.test.ts` | 3 | Tx-variant composability (caller passes own tx) |
| `tests/integration/fifoLayers.test.ts` | 12 | Layer create on receive, oldest-first consume, partial fills, sourceReceiptLineId / sourceMovementId enforcement |
| `tests/integration/consumeInventoryFifo.test.ts` | 10 | CONSUME outcome decision tree (covered_by_layers / covered_by_onhand_no_layers / negative_allocation / throw) |
| `tests/integration/wac.test.ts` | 11 | computeWac correctness across receive/consume/transfer; getLastPurchaseCost ordering and POSTED filter |
| `tests/integration/landedCost.test.ts` | 17 | Apply UNIT_COUNT + VALUE; layer-cost mutation; FifoConsumption mutability rule; cogsPosted=true → backdated JE; reverse from snapshot; reversal of reversal idempotency |
| `tests/integration/cogsPosting.test.ts` | 11 | Forward COGS post per (invoice, warehouse); idempotency; zero-COGS skip; service+drop-ship contributions |
| `tests/integration/cogsReversal.test.ts` | 17 | voidInvoice → full reversal; CM goods-back / loss-reclass / pure-AR paths; pro-rata on FifoConsumption denominator |
| `tests/integration/backfillFifoLayers.test.ts` | 14 | All recovery cases (movement / receipt_line / override); skip reasons; per-movement-tx isolation |
| `tests/integration/negativeInventoryAllowed.test.ts` | 3 | Setting present/absent/invalid-shape behavior |
| `tests/integration/pricing.resolve.test.ts` | 5 | MANUAL_OVERRIDE wins; BASE_PRICE fallback; null-basePrice error; negative manual rejected |
| `tests/integration/pricing.customer-specific.test.ts` | 5 | CUSTOMER_SPECIFIC override wins over BASE; soft-deleted override falls through; partial-unique-index correctness |

Total Module-02-direct: ~109 tests.

NOT covered (because the underlying capability doesn't exist):
- Bundle explode + proportional price allocation
- Build/assembly costing (deferred)
- Lot/batch FIFO (deferred)
- Two-step stock transfer workflow (deferred)
- TIER_DISCOUNT pricing rule
- PROMO pricing rule
- Lowest-of-applicable resolver semantics
- WEIGHT / BOX_COUNT landed cost allocation methods
- Per-warehouse / per-product negative-inventory overrides
- Adjustment reason taxonomy
- Reorder-point / sales-velocity inputs

### (e) API LAYER

| Path | Verbs | Notes |
|---|---|---|
| `src/app/api/products/route.ts` | GET (list), POST (create) | TODO permission |
| `src/app/api/products/[id]/route.ts` | GET, PATCH, DELETE (archive) | TODO permission |
| `src/app/api/products/[id]/variants/route.ts` | GET (list), POST (create) | TODO permission |
| `src/app/api/variants/[id]/route.ts` | GET, PATCH, DELETE (archive) | TODO permission |
| `src/app/api/warehouses/route.ts` + `[id]/route.ts` | full CRUD | TODO permission |
| `src/app/api/inventory/route.ts` | GET (root) | |
| `src/app/api/inventory/by-variant/[variantId]/route.ts` | GET | |
| `src/app/api/inventory/by-warehouse/[warehouseId]/route.ts` | GET | |
| `src/app/api/inventory/{adjust,receive,consume,transfer}/route.ts` | POST | All four movement endpoints exist |

❌ No API for: pricing resolver (consumed only by SO line creation, not exposed to GUI). No API for: FIFO layers (admin-readonly view will be needed). No API for: WAC / last cost (display in product detail screen will need this). No API for: landed cost apply / reverse. No API for: backfill (CLI-only via `npm run backfill-fifo-layers`).

### (f) MISSING / STUBBED

- [ ] 🐛 Audit logging on Product / Variant / Warehouse mutations (helper exists, services skip it — stale TODO comments)
- [ ] TIER_DISCOUNT rule in pricing resolver (CustomerType blanket %)
- [ ] PROMO rule in pricing resolver (date-bounded)
- [ ] Lowest-of-applicable resolver semantics (currently priority-order)
- [ ] WEIGHT and BOX_COUNT landed cost allocation methods
- [ ] Bundle model + bundle-explode service + proportional-price allocator
- [ ] `reorderPoint` / `reorderQty` schema fields (downstream reorder-suggestion report lives in Module 8 but inputs land here)
- [ ] Adjustment reason taxonomy (enum or category table)
- [ ] Per-warehouse / per-product negative-inventory flag overrides
- [ ] Variant-level `manufacturerPartNumber` / images / weight override fields
- [ ] Product-level `countryOfOrigin` / `hsCode` / `hazmat` / `productionTag` / `vendorId` (primary vendor) fields
- [ ] API for pricing resolver, FIFO layers, WAC/last-cost, landed cost apply / reverse
- [ ] DEFERRED (call out only, do NOT count against pilot): drop-ship, pack hierarchy, build/assembly, lot/batch, two-step stock transfer

### (g) PILOT-READY VERDICT

**⚠️ PARTIAL.**

The costing engine and inventory ledger are extensively tested and production-shaped (~109 direct tests, FIFO + WAC + landed cost + COGS post/reverse all green). What blocks "ready" is:

1. **Audit gap on master-data mutations** — actual bug (helper exists, services skip it). Counts against pilot because CLAUDE.md flags audit as non-negotiable.
2. **Pricing resolver is incomplete** — TIER_DISCOUNT and PROMO not wired; lowest-of-applicable not implemented. TIER_DISCOUNT in particular is essential for wholesale pilot (customer types map to tier %s).
3. **Bundle model missing** — not in pilot deferral list, real gap.
4. **Reorder fields missing** — needed for inventory ops, not pilot-deferred.
5. **APIs for reads that the GUI will need** — pricing, WAC/last cost, FIFO inspection.

Inventory and costing are the strongest module in the codebase. Master-data CRUD is the weakest layer of an otherwise solid module.

### (h) PERMISSION GATING

Movement endpoints (adjust/receive/consume/transfer) carry the `// TODO: wire requirePermission()` comment uniformly. Movement service functions take a `ctx?: AuditContext` (userId, ipAddress, reason) but do not consult any permission helper — they trust the caller. Master-data CRUD (products/variants/warehouses) likewise carries the TODO and skips audit entirely.

For GUI build:
- Read endpoints (list/get for products, variants, warehouses, inventory by-variant/by-warehouse) are safe behind a "is logged in?" check.
- Write endpoints (create/update/archive product/variant/warehouse, adjust/receive/consume/transfer inventory) MUST gate on permission before opening any GUI write screen — these are the most dangerous endpoints in the codebase (they mutate stock + cost layers with money implications).

🐛 **BUG (deferred):** Stale `// TODO: wire audit() once lib/audit exists` comments in `products.ts` / `variants.ts` / `warehouse.ts` cause master-data CRUD to skip audit logging despite the helper being available. CLAUDE.md non-negotiable rule says master-data mutations must audit. Listing here so it's tracked; not fixing during this audit per process discipline.

---

## Module 03 — Customers

### (a) SCOPE

Per `docs/03-customers.md`, v1 requires (with portal-related items deferred per `docs/10`):

| ID | Capability | Pilot? |
|---|---|---|
| 03.A | Customer master — auto code (CUST-YYYY-NNNNN), unique display name (citext), type (5 wholesale/retail enums), required salesRep + paymentTerm + billing address + default ship-to | ✅ |
| 03.B | Duplicate-detection helper at create (name substring match, same-city prioritized) | ✅ |
| 03.C | Customer addresses — billing + multiple shipping, "exactly one default per kind" invariant, soft-delete | ✅ |
| 03.D | Customer contacts — unlimited, "exactly one isPrimary per customer" invariant | ✅ |
| 03.E | Documents — RESALE_PERMIT / BUSINESS_LICENSE / RESALE_CERT / EIN / SSN / DRIVERS_LICENSE / OTHER. Encrypted-at-rest for EIN/SSN/DL. Audited cleartext read. "Documents expiring in 30 days" widget | ✅ |
| 03.F | Customer types drive default pricing tier (5-value enum) — schema field present | ✅ |
| 03.G | Tier-blanket discount % storage + resolution | ❌ schema gap (no discount-% column anywhere) |
| 03.H | Customer-specific price overrides — manual CRUD + bulk CSV (UPSERT-only contract) | ✅ |
| 03.I | Cost-plus % per customer (`costPlusPercent` Decimal) — schema captured, resolver branch not wired | partial — pilot DEFERRED for COST_PLUS rule |
| 03.J | Stored payment methods — Authorize.Net CIM tokens only, "exactly one isPreferred per customer", expiration-tracking helper | partial — schema + CRUD ✅; Authorize.Net runtime integration DEFERRED |
| 03.K | Sales rep assignment (required FK on Customer) + permanent UNASSIGNED fallback rep | ✅ |
| 03.L | Sales rep CRUD (code, name, email, active, userId placeholder, commissionBasis, commissionPercent, groupId placeholder) | ✅ |
| 03.M | Commission earning logic (on payment received, partial-proportional, margin uses COGS-at-close, refunds reverse) | ❌ MISSING |
| 03.N | Commission report (per-rep, per-period, columns: earned/pending/reversed/net) | ❌ MISSING |
| 03.O | Credit limit per customer (nullable = no limit) — field stored | partial — schema ✅, **enforcement at SO entry MISSING** |
| 03.P | AR hold per customer (block new orders when AR > X days past due) — field stored | partial — schema ✅, **enforcement MISSING** |
| 03.Q | Manager override + reason on credit-limit / AR-hold breach | ❌ MISSING (depends on RBAC) |
| 03.R | Tax-exempt + resale cert number | ✅ schema only |
| 03.S | Sticky internal notes (print on every internal doc for that customer) | partial — `internalNotes` field stored; PDF rendering deferred |
| 03.T | Activity log — auto entries (field-change tracked) + manual entries; distinct from AuditLog | ✅ |
| 03.U | Tags (free-form citext, autocomplete) and Categories (admin-managed list) | ✅ |
| 03.V | Statements (open balance + full activity, on-demand, PDF + email) | ❌ MISSING (overlaps Module 06) |
| 03.W | Payment terms admin (Net 30 / COD / Prepay / 50% deposit / Pay on shipping / Bill later) | ✅ |
| 03.X | Wholesale application flow (public form → application record → staff approval → customer + portal user creation) | DEFERRED (portal-tied, but admin-side approval flow could land sans portal — flagged) |
| 03.Y | Customer portal (login, AR view, invoice payment, order placement, address management, payment-method management, statement generation, dispute, auto-pay) | DEFERRED |
| 03.Z | Backorder queue (line cancelled with reason, queued, notified on stock-back, lower-of pricing on re-order) | DEFERRED (portal-tied, partial staff-side flow may need to land — flagged) |
| 03.AA | Drop-ship vendor "shadow customer" record | DEFERRED |

### (b) SERVICE LAYER

| Scope | File | Function(s) | Parameters | Completeness notes |
|---|---|---|---|---|
| 03.A / 03.T | `src/server/services/customers.ts` | `createCustomer(db, input, ctx?)`, `updateCustomer(db, id, input, ctx?)`, `softDeleteCustomer(db, id, ctx?)`, `getCustomer(db, id)`, `listCustomers(db, filters)`, `findDuplicateCandidates(db, args)`, `documentsExpiringWithin(db, days)` | `db: PrismaClient`, `input: CreateCustomerInput \| UpdateCustomerInput` (Zod), `ctx: AuditContext`, `filters: { active?, type?, salesRepId?, tagId?, categoryId?, q?, skip?, take? }`, `args: { name, city?, limit? }` | Composite create writes customer + addresses + contacts + tags + categories in one tx. Soft-delete refuses if any non-deleted SalesOrder references customer. ACTIVITY_TRACKED_FIELDS = `[creditLimit, arHoldDays, taxExempt, salesRepId, paymentTermId, type]` — changes on these fields write both AuditLog AND CustomerActivity rows (intentional dual-write). Other field changes audit-only. Does NOT enforce credit limit / AR hold (those are read-only fields here; SO service should consult them but doesn't — see 03.O/P below). |
| 03.C | `src/server/services/customerAddresses.ts` | `addAddressTx`, `addAddress`, `updateAddress`, `softDeleteAddress`, `setDefaultAddress`, `listAddresses` | tx/db, customerId, address payload, ctx | "Exactly one isDefault per (customerId, kind) among non-deleted rows" — service-enforced + partial unique index. Tx variant for composability. |
| 03.D | `src/server/services/customerContacts.ts` | `createContactTx`, `createContact`, `updateContact`, `softDeleteContact`, `setPrimaryContact`, `listContacts` | tx/db, customerId, contact payload, ctx | "Exactly one isPrimary per customer among non-deleted rows" — service-enforced + partial unique index. |
| 03.E | `src/server/services/customerDocuments.ts` | `createDocument(db, customerId, input, ctx?)`, `softDeleteDocument`, `getDocumentMetadata`, `listDocumentsForCustomer`, `findDocumentsExpiringWithin`, `readEncryptedValue(db, documentId, ctx?)` | db, customerId, `input: CreateDocumentInput` (Zod, discriminated by `kind`), ctx | `readEncryptedValue` writes SENSITIVE_READ AuditLog row BEFORE attempting decryption (audit-first pattern: tampered-ciphertext attempts get logged regardless). `redactForAudit` strips ciphertext + IV from all audit / activity payloads. Sensitive-kind detection via SENSITIVE_KINDS set. Encryption happens OUTSIDE the tx so cleartext exits scope at fn return. Caller obligation documented in long header comment ("never log, never persist, never re-emit"). Does NOT support: file upload to Spaces (caller passes `storageKey`); document download URL signing (deferred to Spaces integration). |
| 03.H | `src/server/services/customerPriceOverrides.ts` | `createOverride`, `updateOverride`, `softDeleteOverride`, `getOverride`, `listOverridesForCustomer`, `bulkImportFromCsv(db, customerId, csvText, ctx?)` | db, customerId, override payload (or csvText), ctx | UPSERT-only CSV contract: rows present in CSV insert/update; rows absent are LEFT ALONE (never deleted via import). Per-row error collection without aborting whole import. Partial unique index on (customerId, variantId) ignoring soft-deleted rows. |
| 03.J | `src/server/services/customerPaymentMethods.ts` | `createPaymentMethod`, `updatePaymentMethod`, `softDeletePaymentMethod`, `setPreferred`, `getPaymentMethod`, `listPaymentMethodsForCustomer`, `findPaymentMethodsExpiringWithin` | db, customerId, payment-method payload, ctx | Stores Authorize.Net CIM customerProfileId + paymentProfileId only. Schema input rejects payloads that look like raw card numbers. "Exactly one isPreferred per customer among non-deleted rows" — partial unique index. Does NOT call Authorize.Net API (token creation/management deferred to integration phase). |
| 03.T | `src/server/services/customerActivities.ts` | `addManualEntry`, `listActivity` | db, customerId, summary, ctx | Manual entries (sales rep call notes etc.). Auto entries are written by other services (customers, documents, price-overrides). |
| 03.U tags | `src/server/services/customerTags.ts` | `searchTags`, `listTagsForCustomer`, `assignTag`, `unassignTag` | db, customerId, label/tagId | Free-form, autocomplete-driven. Tags created lazily on first use. Citext label uniqueness. |
| 03.U cats | `src/server/services/customerCategories.ts` | `createCategory`, `updateCategory`, `softDeleteCategory`, `getCategory`, `listCategories`, `assignCategory`, `unassignCategory`, `listCategoriesForCustomer` | db, category payload or (customerId, categoryId), ctx | Admin-managed list with stable `code`. Soft-delete refuses if any non-deleted assignment references the category. |
| 03.K/L | `src/server/services/salesReps.ts` | `createSalesRep`, `updateSalesRep`, `softDeleteSalesRep`, `getSalesRep`, `listSalesReps` | db, payload, ctx | Permanent UNASSIGNED rep undeletable; soft-delete refuses if any non-deleted Customer references rep. Stores commissionBasis / commissionPercent / groupId — but NO commission compute uses them. |
| 03.W | `src/server/services/paymentTerms.ts` | `createPaymentTerm`, `updatePaymentTerm`, `softDeletePaymentTerm`, `getPaymentTerm`, `listPaymentTerms` | db, payload, ctx | Seeded with Net 30 / COD / Prepay / 50% deposit / Pay on shipping / Bill later (Net 30) by migration; seed file re-asserts on every run. |
| 03.M/N Commission | ❌ MISSING | — | — | No commission computation service. SalesRep schema has the fields; no service reads them. Nothing accrues commission on payment received, computes margin, applies group-rate fallback, or aggregates a per-rep / per-period report. |
| 03.O/P Credit limit + AR hold | ❌ MISSING (enforcement) | — | — | `Customer.creditLimit` and `Customer.arHoldDays` are persisted but no service consults them. `salesOrders.ts` does NOT grep-match on either field — order entry / confirm / close paths bypass these guards. CLAUDE.md / spec require: at SO entry, check `(currentArBalance + openSosNotInvoiced + thisOrderTotal) <= creditLimit`; if exceeded, block + manager override + reason. None of this is wired. **Real gap, not pilot-deferred.** |
| 03.Q Manager override | ❌ MISSING | — | — | Depends on RBAC (Module 01). |
| 03.V Statements | ❌ MISSING | — | — | No `generateOpenBalanceStatement` / `generateFullActivityStatement` service. Module 06 has AR aging — that's the underlying data, but no statement renderer or PDF emit path. Likely lands with PDF/template phase. |
| 03.X Wholesale application | ❌ MISSING | — | — | No `WholesaleApplication` model. No service. Pilot can substitute with manual customer creation (which works), but the spec's staff-approval workflow (single button creates customer + portal user + Shopify customer + welcome email) is not present. |
| 03.Z Backorder queue | ❌ MISSING | — | — | No `BackorderQueue` model. No service. Spec defines a staff-side backorder workflow (add to next order, lower-of pricing) that doesn't strictly require a portal — but no scaffolding exists. |

### (c) SCHEMA

Models supporting Module 03:

- ✅ `Customer` — full spec match: `code`, citext-unique `name`, `type` enum (5 values), `salesRepId` + `paymentTermId` (required FKs), `creditLimit`, `arHoldDays`, `taxExempt`, `resaleCertNumber`, `primaryPhone`, `primaryEmail`, `internalNotes`, `shopifyCustomerId`, `costPlusPercent`, `active`, `deletedAt`. Indexes on `(type)`, `(salesRepId)`, `(active, deletedAt)`, `(shopifyCustomerId)`.
- ✅ `CustomerAddress` — kind (BILLING/SHIPPING), isDefault, label, full address fields, attention, phone, deletedAt.
- ✅ `CustomerContact` — name, role (free-text), email/phone/mobile, isPrimary, deletedAt.
- ✅ `CustomerPriceOverride` — `(customerId, variantId)` partial-unique-active, currency, notes, deletedAt.
- ✅ `CustomerPaymentMethod` — Authorize.Net CIM tokens only, brand/last4/expirationMonth/Year, isPreferred partial-unique-active.
- ✅ `CustomerDocument` — kind enum (7 values), encryptedValue + iv (sensitive scalars), storageKey + fileName + contentType (file attachments), expiresOn, deletedAt.
- ✅ `CustomerActivity` — kind (AUTO/MANUAL), summary, detailJson, createdById.
- ✅ `CustomerCategory` (code-keyed admin list) + `CustomerCategoryAssignment` (M:N).
- ✅ `CustomerTag` (citext label) + `CustomerTagAssignment` (M:N).
- ✅ `SalesRep` — code, name, email, active, userId placeholder, commissionBasis, commissionPercent, groupId placeholder.
- ✅ `PaymentTerm` — code-keyed, label, netDays.

❌ Missing entirely:
- `WholesaleApplication` model (deferred-with-flag — see scope note)
- `BackorderQueue` model (deferred-with-flag)
- `SalesRepGroup` model (placeholder `groupId` field exists, no model)
- Any Customer-level "blanket discount %" column (TIER_DISCOUNT data plumbing) — pilot blocker if TIER_DISCOUNT lands
- Any `User` ↔ `SalesRep` link (the `userId` placeholder is just a string, no FK)
- `Disputed` flag on Invoice (per portal "dispute invoice" feature) — deferred with portal

### (d) TEST COVERAGE

| File | Tests | Covers |
|---|---|---|
| `tests/integration/customers.lifecycle.test.ts` | 8 | Create / update / softDelete / list; sequence allocation; tracked-field activity emission; SO-reference dependency check |
| `tests/integration/customers.duplicates.test.ts` | 4 | findDuplicateCandidates: substring match, same-city prioritization, limit handling |
| `tests/integration/customers.addresses.test.ts` | 4 | Add / update / softDelete / setDefault; "exactly one default per kind" invariant |
| `tests/integration/customers.contacts.test.ts` | 4 | Add / update / softDelete / setPrimary; "exactly one primary" invariant |
| `tests/integration/customers.documents.test.ts` | 12 | Sensitive-kind encryption; SENSITIVE_READ audit emission; redactForAudit; expiration window query; non-sensitive file metadata path |
| `tests/integration/customers.paymentMethods.test.ts` | 10 | CIM token CRUD; isPreferred invariant; expiration window; raw-card-number rejection |
| `tests/integration/customers.priceOverrides.test.ts` | 11 | Manual CRUD; CSV bulk import (UPSERT contract, per-row errors, header errors); partial unique index behavior |
| `tests/integration/customers.activity.test.ts` | 7 | Manual entries; AUTO entries from tracked field changes; chronological listing |
| `tests/integration/customers.tags-categories.test.ts` | 11 | Tag autocomplete + lazy create; category CRUD + dependency check; assign / unassign |
| `tests/integration/salesReps.test.ts` | 6 | Create / update / softDelete; UNASSIGNED rep undeletable; customer-reference dependency check |
| `tests/integration/paymentTerms.test.ts` | 5 | Create / update / softDelete; Customer-reference dependency check |

Total Module-03-direct: ~82 tests. Strong coverage on what's implemented.

NOT covered (because the underlying capability doesn't exist):
- Credit limit / AR hold enforcement at SO entry
- Manager override path
- Commission accrual on payment received
- Commission report aggregation
- Margin-based commission with COGS-at-close
- Wholesale application creation / approval workflow
- Backorder queue + lower-of pricing
- Statement generation (open balance / full activity)
- Tier discount % resolution

### (e) API LAYER

Comprehensive customer-side API surface:

| Path | Verbs | Notes |
|---|---|---|
| `/api/customers` | GET (list w/ filters), POST (create) | TODO permission |
| `/api/customers/[id]` | GET, PATCH, DELETE (soft-delete) | TODO permission |
| `/api/customers/[id]/activity` | GET (list), POST (manual entry) | |
| `/api/customers/[id]/documents` | GET, POST | |
| `/api/customers/[id]/documents/[did]` | GET (metadata), DELETE | |
| `/api/customers/[id]/documents/[did]/cleartext` | GET (audited cleartext read) | Cache-Control: no-store enforced |
| `/api/customers/[id]/payment-methods` | GET, POST | |
| `/api/customers/[id]/payment-methods/[pmid]` | GET, PATCH, DELETE | |
| `/api/customers/[id]/payment-methods/[pmid]/set-preferred` | POST | |
| `/api/customers/[id]/price-overrides` | GET, POST | |
| `/api/customers/[id]/price-overrides/[oid]` | PATCH, DELETE | |
| `/api/customers/[id]/price-overrides/import-csv` | POST | |
| `/api/customers/[id]/categories` | GET, POST (assign) | |
| `/api/customers/[id]/categories/[categoryId]` | DELETE (unassign) | |
| `/api/customers/[id]/tags` | GET, POST (assign) | |
| `/api/customers/[id]/tags/[tagLabel]` | DELETE (unassign) | |
| `/api/customer-categories`, `/api/customer-categories/[id]` | full CRUD | |
| `/api/customer-tags` | GET (search), no per-tag mutation route | |
| `/api/payment-terms`, `/api/payment-terms/[id]` | full CRUD | |
| `/api/sales-reps`, `/api/sales-reps/[id]` | full CRUD | |

❌ No API for: credit limit / AR hold checks (because the service doesn't enforce them); manager override; commission report; wholesale application; backorder queue; statement generation; documents-expiring widget endpoint (though `documentsExpiringWithin` service exists, no HTTP wrapper).

✅ Cross-reference correction: `arBalanceForCustomer` + `agingForCustomer` ARE wrapped via `/api/customers/[id]/ar-balance` and `/api/customers/[id]/aging` — those endpoints exist (live in Module 06's surface but mounted under the customer path). The earlier "no HTTP wrapper" claim in this section was wrong; the gap is only on the `documentsExpiringWithin` / `findPaymentMethodsExpiringWithin` widgets.

### (f) MISSING / STUBBED

Real gaps (counted against pilot):
- [ ] Credit limit enforcement at SO entry/confirm + manager override path
- [ ] AR hold enforcement at SO entry/confirm + manager override path
- [ ] Tier blanket-discount-% storage location (Setting? CustomerCategory? new table?) — pilot blocker if TIER_DISCOUNT (Module 02) lands
- [ ] Commission computation service (accrual on payment received, partial-proportional, margin-COGS-at-close, refund reversal)
- [ ] Commission report (per-rep / per-period earned/pending/reversed/net columns)
- [ ] Statement generation (open balance + full activity)
- [ ] HTTP wrapper for documentsExpiringWithin (dashboard widget needs an endpoint)
- [ ] HTTP wrapper for paymentMethodsExpiringWithin

Properly deferred (NOT counted against pilot — portal/integration-tied):
- Customer portal entirely (03.Y)
- Wholesale application table + approval flow (03.X) — flagged: admin-only approval flow could land sans portal if needed
- Backorder queue (03.Z) — flagged: staff-side workflow could land sans portal
- Authorize.Net runtime integration (token CRUD storage exists; live API calls deferred)
- Drop-ship shadow customer (03.AA)

### (g) PILOT-READY VERDICT

**⚠️ PARTIAL.**

Customer master, addresses, contacts, documents (with proper encryption + audited cleartext path), tags, categories, price overrides (manual + CSV), payment-method tokens, sales reps, payment terms — all of it has full CRUD with audit + activity log + soft-delete with dependency check. ~82 direct tests. This is the most complete module in the codebase.

What blocks "ready":
1. **Credit limit + AR hold enforcement is missing** — fields stored, never read. Order entry can create orders that exceed credit limits silently. Real gap.
2. **Commission engine doesn't exist** — fields stored, no compute. Pilot Naked Kratom may or may not need it depending on whether their reps work on commission; worth confirming with the user.
3. **Tier discount % data plumbing** — needs a place to live before Module 02's TIER_DISCOUNT can land.
4. **Wholesale application + backorder queue** — staff-side flows could be useful for pilot even without portal; worth a deliberate scope call.

### (h) PERMISSION GATING

All customer API routes carry the `// TODO: wire requirePermission()` placeholder. Customer service functions take `ctx: AuditContext` but no permission check. The customer documents cleartext read endpoint is the highest-risk surface — it returns decrypted sensitive scalars (EIN/SSN/DL) and writes a SENSITIVE_READ audit row. That endpoint MUST gate on a `customers.read_sensitive_documents` permission before opening any GUI. The other customer endpoints can ship behind a generic `customers.read` / `customers.write` gate. The price-override CSV import endpoint should require `customers.import_price_overrides` (high blast radius, bulk overwrite of pricing data).

---

## Module 04 — Vendors & Purchasing

### (a) SCOPE

Per `docs/04-vendors-purchasing.md`, v1 requires (with pilot deferrals — drop-ship entirely, vendor portal entirely, multi-warehouse PO splits, MOQ enforcement, lead-time tracking — removed):

| ID | Capability | Pilot? |
|---|---|---|
| 04.A | Vendor master — auto ID, contact info, multiple payment-method records (ACH/wire/check + bank routing/account encrypted at rest), payment terms, active/inactive | ❌ stub only |
| 04.B | Vendor contacts (multiple per vendor, free-text role) | ❌ MISSING |
| 04.C | Vendor product catalog — vendor SKU, latest cost, current WAC, vendor pack size; allow multi-vendor with explicit primary flag; one-off products on PO not in catalog | ❌ MISSING (MOQ + lead-time deferred per pilot) |
| 04.D | Cost change handling — auto-accept; threshold-based flash alert in "cost change alerts" inbox | ❌ MISSING |
| 04.E | PO lifecycle — DRAFT → CONFIRMED → DISPATCHED → CLOSED, plus PARTIALLY_RECEIVED interim, plus CANCELLED | partial — DISPATCHED state missing from schema; rest wired |
| 04.F | PO numbering (PO-YYYY-NNNNN auto-allocated) | ✅ |
| 04.G | PO line fields: variant, vendor SKU, manufacturer part #, qty, unit cost, expected receive date, destination warehouse, line notes | ✅ |
| 04.H | Multi-warehouse on one PO (lines per-line warehouse + bulk-edit toggle) | DEFERRED (multi-warehouse) |
| 04.I | PO approval (no threshold; permission-gated only) | partial — schema fine; permission gate depends on RBAC |
| 04.J | Auto-suggest POs from low stock (off by default; reorder point + sales velocity → draft POs) | ❌ MISSING |
| 04.K | Multi-PO Receipt model (Receipt is M:N to POs via PO line FK on ReceiptLines, NOT 1:1 to PO) | ✅ |
| 04.L | Receipt lifecycle — DRAFT → POSTED → CANCELLED (with consumed-layer guard) | ✅ |
| 04.M | Partial receiving (the norm) — qty received < ordered, actual unit cost may differ from PO, immediate inventory + FIFO layer | ✅ |
| 04.N | Over/under receiving — allowed with `wasOverReceived` flag, no block | ✅ |
| 04.O | Damaged on receipt — receive partial + reject damaged + trigger vendor credit memo | ❌ MISSING (vendor credit memo path) |
| 04.P | Landed cost AT RECEIPT time — freight + customs + handling allocated by UNIT_COUNT / WEIGHT / VALUE / BOX_COUNT into FIFO + WAC immediately | ❌ MISSING (`postReceipt` does not accept landed-cost inputs; the LATE landed cost path in Module 02 is the only landed-cost surface today) |
| 04.Q | Late landed cost (covered in Module 02 — `applyLandedCostToReceipts` + `reverseLandedCostAllocation`) | ✅ via Module 02 |
| 04.R | Customs/duty same flow as freight | ❌ MISSING (depends on 04.P) |
| 04.S | Drop-ship vendor architecture (commission, shadow customer, JE pair, monthly invoice, late fees) | DEFERRED |
| 04.T | Vendor portal | DEFERRED |
| 04.U | Vendor feeds (Shopify+Matrixify primary; manual CSV w/ mapping wizard secondary) | DEFERRED (integrations phase) |
| 04.V | Backdated `receivedAt` on postReceipt | ❌ MISSING (TODO comment in receipts.ts:219-221) |

### (b) SERVICE LAYER

| Scope | File | Function(s) | Parameters | Completeness notes |
|---|---|---|---|---|
| 04.A vendor master | ❌ STUB ONLY | — | — | `prisma/tenant/schema.prisma` model `Vendor` is explicitly labeled "Minimal vendor stub. Full Vendor master ... lands in its own slice." Fields: `id, code, name, active, deletedAt, createdAt, updatedAt`. **No service file exists** — no `src/server/services/vendors.ts`. POs and Receipts FK against this stub. |
| 04.B vendor contacts | ❌ MISSING | — | — | No model, no service. |
| 04.C vendor product catalog | ❌ MISSING | — | — | No `VendorProductCatalog` model. PO lines carry `vendorSku` and `manufacturerPartNumber` per-line, but there's no vendor-keyed catalog table that tracks per-vendor cost / pack-size / primary-vendor flag. |
| 04.D cost change | ❌ MISSING | — | — | No service, no Setting key for threshold, no alert inbox. |
| 04.E/F/G/I | `src/server/services/purchaseOrders.ts` | `createPurchaseOrder(db, input, ctx?)`, `updatePurchaseOrder(db, id, input, ctx?)`, `confirmPurchaseOrder(db, id, ctx?)`, `cancelPurchaseOrder(db, id, input, ctx?)`, `softDeletePurchaseOrder(db, id, ctx?)`, `getPurchaseOrder(db, id)`, `listPurchaseOrders(db, filters)`, `recomputeQtyReceivedForPoLine(tx, poLineId)`, `computePoStatus(tx, purchaseOrderId)`, `applyComputedPoStatus(tx, purchaseOrderId, ctx?)` | `db: PrismaClient`, `id: string`, `input` (Zod), `ctx: AuditContext`, filters `{ vendorId?, status?, skip?, take? }` | Sequence-allocated PO-YYYY-NNNNN. UPDATE only allowed in DRAFT (wholesale-replace lines). CONFIRM transitions DRAFT → CONFIRMED with `confirmedAt`. CANCEL refuses CLOSED, refuses already-CANCELLED, refuses any with active receipt lines. SOFT-DELETE only allowed for DRAFT or CANCELLED. Status auto-computed from receipt totals (CONFIRMED → PARTIALLY_RECEIVED → CLOSED) by `applyComputedPoStatus`. Does NOT: support DISPATCHED/SHIPPED state (schema enum doesn't have it); validate vendor minimum order; check cost-change threshold; carry per-line warehouse beyond what's already there (multi-warehouse on one PO works at schema level — each line has `warehouseId` — but no bulk-edit helper); auto-suggest from low stock. |
| 04.K/L/M/N | `src/server/services/receipts.ts` | `createDraftReceipt`, `updateDraftReceipt`, `postReceipt`, `cancelReceipt`, `getReceipt`, `listReceipts`, plus internal `validateReceiptLines` | `db`, `id`, `input` (Zod), `ctx`, filters | Multi-PO model: each ReceiptLine optionally points at a PurchaseOrderLine, validates same-vendor + status-allows-receive (CONFIRMED or PARTIALLY_RECEIVED). Receipt vendorId + warehouseId match enforced per-line. POST flow: status flip first → per-line `receiveInventoryTx` → unitCost rewrite on movement → `createFifoLayerOnReceiveTx` → recompute affected PO lines → recompute affected PO statuses. Returns `wasOverReceived` flag. CANCEL refuses if any layer has been consumed. Soft-deletes clean layers + soft-deletes receipt lines + reverses movements via RECEIVE_REVERSE + recomputes PO statuses. Does NOT: accept backdated `receivedAt` (TODO at line 219-221); accept landed-cost inputs (freight/customs/handling) at receipt time; route damaged-on-receipt to a vendor credit memo. |
| 04.O damaged-on-receipt | ❌ MISSING | — | — | No vendor credit memo flow. Damaged units would currently need to be received and then adjusted via a separate `createAdjustmentTx`, with no linkage to vendor accountability. |
| 04.P landed cost at receipt | ❌ MISSING | — | — | `postReceipt` does NOT accept freight/customs/handling inputs. Late landed cost works retroactively (Module 02) but the at-receipt path is not wired. |

### (c) SCHEMA

Models supporting Module 04:

- ⚠️ `Vendor` (stub) — `id, code, name, active, deletedAt, createdAt, updatedAt`. No `paymentTerms`, no `paymentMethods`, no `defaultPaymentMethod`, no `commissionPercent` (drop-ship deferred), no `minimumOrderAmount`, no `costChangeThresholdPercent`. Schema comment: "Minimal vendor stub ... EXPAND LATER."
- ✅ `PurchaseOrder` — `number`, `vendorId`, `status` (5-value enum), `expectedReceiveDate`, `currency`, `notes`, `createdById`, `confirmedAt`, `closedAt`, `cancelledAt`, `deletedAt`. Indexes on `(vendorId, status)`, `(status, expectedReceiveDate)`, `(deletedAt)`.
- ✅ `PurchaseOrderLine` — full set of fields per spec (variant, warehouse, qty ordered/received, unit cost, vendor SKU, manufacturer part #, notes, deletedAt).
- ✅ `Receipt` — number, vendorId, warehouseId, status (3-value), receivedAt, postedById, notes, deletedAt. Note: Receipt's `warehouseId` is one-per-receipt — multi-warehouse-per-receipt would need rework, but multi-warehouse is pilot-deferred so this is fine.
- ✅ `ReceiptLine` — receiptId, **optional** `purchaseOrderLineId` (M:N realized via this nullable FK), variantId, warehouseId (must equal receipt's warehouseId per validator), qtyReceived, unitCost, `inventoryMovementId @unique`, notes, deletedAt.
- ✅ `LandedCostAllocation` + lines + receipts (M:N) — for the LATE landed cost path. The AT-RECEIPT path has nowhere to plug in; it would either reuse this model or need a separate `ReceiptLandedCost` table.

❌ Missing entirely:
- `VendorContact` — none
- `VendorPaymentMethod` (encrypted ACH/wire/check info) — none
- `VendorProductCatalog` (per-vendor cost/pack-size/primary flag) — none
- `Bill` (the AP-side mirror of Invoice — Phase 8 territory but called out so the gap is explicit)
- `CostChangeAlert` (inbox model)
- `PoSuggestion` / `ReorderSuggestion` (auto-suggest output)
- DISPATCHED value missing from `PurchaseOrderStatus` enum (real if minor schema gap vs. spec's 4-state lifecycle)
- DROP_SHIP-related shadow-customer link, commission rate, commission GL accounts (deferred entirely)

### (d) TEST COVERAGE

| File | Tests | Covers |
|---|---|---|
| `tests/integration/purchaseOrders.test.ts` | 9 | Create / update (DRAFT only) / confirm / cancel (with active-receipt-line guard) / soft-delete; sequence allocation; status recompute; CANCELLED-after-CLOSED refusal |
| `tests/integration/receipts.test.ts` | 15 | Multi-PO line attachment; vendor-mismatch refusal; PO status not-receivable refusal; warehouse mismatch; post-flow (movement + FifoLayer creation); over-receive flag; cancel-with-clean-layers; cancel-with-consumed-layer refusal; PO status recomputation after post / cancel |

Total Module-04-direct: 24 tests. Strong on what's implemented.

NOT covered (capability doesn't exist):
- Vendor master CRUD
- Vendor contacts
- Vendor payment methods
- Vendor product catalog
- Cost change auto-accept + threshold alert
- Auto-suggest POs from low stock
- DISPATCHED status transition
- Backdated receivedAt
- Landed cost at receipt time
- Damaged-on-receipt → vendor credit memo
- Bills (Phase 8)
- Drop-ship (deferred)
- Vendor portal (deferred)

### (e) API LAYER

| Path | Verbs | Notes |
|---|---|---|
| `/api/purchase-orders` | GET (list w/ filters), POST (create) | TODO permission |
| `/api/purchase-orders/[id]` | GET, PATCH, DELETE (soft-delete) | |
| `/api/purchase-orders/[id]/confirm` | POST | |
| `/api/purchase-orders/[id]/cancel` | POST | |
| `/api/receipts` | GET, POST (createDraft) | |
| `/api/receipts/[id]` | GET, PATCH (update DRAFT) | |
| `/api/receipts/[id]/post` | POST | |
| `/api/receipts/[id]/cancel` | POST | |

❌ **No API at all for: vendors, vendor contacts, vendor payment methods, vendor product catalog, cost change alerts, PO suggestions, bills, vendor commissions.** Vendors are a complete API blackhole — POs and Receipts FK against vendor stubs that nothing creates or maintains via HTTP.

### (f) MISSING / STUBBED

Real gaps (counted against pilot — NOT in deferral list):
- [ ] Vendor master CRUD service + API (currently a stub Prisma model with no surface)
- [ ] Vendor contacts model + service + API
- [ ] Vendor payment methods (encrypted ACH/wire/check info) — uses the same `lib/crypto` pattern as customer documents (template available)
- [ ] Vendor product catalog (per-vendor cost / pack-size / primary-flag for multi-vendor); PO entry would consume this for cost defaulting + multi-vendor disambiguation
- [ ] Cost change auto-accept service + threshold-alert inbox + Setting key for threshold percent
- [ ] At-receipt landed cost — `postReceipt` should accept `{ freight?, customs?, handling?, allocationMethod }` and write a LandedCostAllocation row at the same time, NOT separately as a "late" allocation. Currently the only path is the retroactive Part-4 path.
- [ ] Damaged-on-receipt → vendor credit memo (depends on Bills/AP module landing first; the vendor-credit-memo concept is the AP mirror of customer credit memo)
- [ ] Backdated `receivedAt` parameter on postReceipt (FifoLayer.receivedDate currently mirrors `new Date()` — works for "right now" receives but blocks user-backdated FIFO scenarios)
- [ ] DISPATCHED state in PurchaseOrderStatus enum (small migration; status gate in `applyComputedPoStatus` would need a DISPATCHED branch tied to a vendor-confirms-shipping action)
- [ ] Auto-suggest POs from low stock (off-by-default per spec; depends on Module 02's missing `reorderPoint` field)
- [ ] Settings/admin for vendor minimum order, vendor cost-change threshold

Properly deferred (NOT counted against pilot):
- Drop-ship vendor architecture (entirely)
- Vendor portal (entirely)
- Multi-warehouse on PO line UX (schema supports it; bulk-edit helper deferred)
- MOQ enforcement (deferred per pilot)
- Lead-time tracking (deferred per pilot)
- Vendor feeds + mapping wizard (deferred to integrations phase)
- Bills (Phase 8 — Module 07)

### (g) PILOT-READY VERDICT

**❌ NOT STARTED** for vendor master / contacts / payment methods / product catalog / cost change.

**✅ READY** for PurchaseOrder + Receipt lifecycle on top of vendor stubs.

The PO + Receipt lifecycle is well-built: ~24 integration tests, multi-PO Receipt model is correctly realized, status recomputation is centralized, cancel guards are in place, advisory locks compose correctly with movements/FifoLayer. The gap is the **vendor side itself** — there is literally no vendor service or API surface. POs and Receipts FK against vendor rows that someone has to create via raw SQL or a fixture script today.

Two real gaps beyond the "no vendor surface" issue:
1. **At-receipt landed cost** — `postReceipt` doesn't accept freight/customs/handling, only the late path works. For Naked Kratom this might be fine (most kratom shipments would not have freight billed separately at receive time), but the spec calls for both paths.
2. **Backdated receivedAt on postReceipt** — FIFO position currently always mirrors wall-clock. If migration imports historical receipts, they'll all sort to "today" in FIFO order, which is wrong.

### (h) PERMISSION GATING

PO + Receipt API routes carry the uniform `// TODO: wire requirePermission()`. Service functions take `ctx: AuditContext` but no permission check.

Highest-risk surfaces:
- `postReceipt` — mutates inventory + creates FIFO layers (cost layers feeding all future COGS)
- `cancelReceipt` — soft-deletes layers + reverses movements (only allowed when no consumption has happened, but still: any cancel after partial sales would be silently refused; UI needs to surface that)
- `cancelPurchaseOrder` — refuses if active receipt lines but is otherwise unrestricted
- `confirmPurchaseOrder` — sends signal to vendor (when integration lands); should require `purchaseOrders.confirm` permission specifically since it's the "place the order with the vendor" act
- Future: vendor payment methods (encrypted bank info, when wired) MUST gate on `vendors.read_sensitive_payment_info` analogous to customer documents cleartext read

For GUI:
- Vendor-side write screens cannot ship — there's no service or API to call.
- PO + Receipt write screens can ship behind permission gates (`purchaseOrders.create` / `purchaseOrders.confirm` / `purchaseOrders.cancel` / `receipts.create` / `receipts.post` / `receipts.cancel`).
- Read screens (PO list, PO detail, Receipt list, Receipt detail) can ship behind a generic `purchaseOrders.read` / `receipts.read`.

---

## Module 05 — Sales Orders

### (a) SCOPE

Per `docs/05-sales-orders.md`, v1 requires (with pilot deferrals — drop-ship auto-split, customer portal, Shopify integration, ShipStation, multi-warehouse, qty-break, cost-plus — removed):

| ID | Capability | Pilot? |
|---|---|---|
| 05.A | SO numbering — auto SO-YYYY-NNNNN; Invoice number = SO number | ✅ |
| 05.B | Lifecycle: DRAFT → CONFIRMED → DISPATCHED → CLOSED + CANCELLED (any pre-CLOSED) | ✅ |
| 05.C | Inventory commit timing: Confirmed (Available→Reserved); Closed (OnHand decreases, Reserved zero) | ✅ |
| 05.D | Pickup orders skip DISPATCHED (CONFIRMED → CLOSED accepted directly) | ✅ |
| 05.E | Order sources — STAFF, PORTAL, SHOPIFY (enum present; only STAFF wired) | partial — STAFF only; PORTAL/SHOPIFY DEFERRED |
| 05.F | Order entry required fields: customer, sales rep (auto-fill), source warehouse, ship-to | partial — `customerId`, `warehouseId` required; sales rep / ship-to defaulting from customer record NOT wired (free-text `shippingAddress` only) |
| 05.G | Order entry optional fields: bill-to, order date, promised ship date, customer PO, customer notes, internal notes, order-level discount | ✅ |
| 05.H | Line entry — type SKU with autocomplete + line-level fields (variant, qty, unit price, discount, customer note, internal note, source warehouse) | ✅ at service level (SKU autocomplete is GUI concern) |
| 05.I | Real-time inventory display on line entry: OnHand + Available for source warehouse | ❌ MISSING (no service helper) |
| 05.J | Pricing resolver consumed at line creation, with `priceRule` recorded per line | ✅ — but **inherits Module 02's gap**: only MANUAL_OVERRIDE / CUSTOMER_SPECIFIC / BASE_PRICE wired; TIER_DISCOUNT + PROMO not |
| 05.K | Quantity break auto-apply mid-entry | DEFERRED (qty-break) |
| 05.L | Manual price override on line — no manager approval, always logged | ✅ — `manualUnitPrice` parameter, resolver records MANUAL_OVERRIDE, audited |
| 05.M | Order-level discount — % OR $ (mutually exclusive) | ✅ Zod-enforced |
| 05.N | Credit limit + AR hold enforcement at SO entry/confirm | ❌ MISSING (`salesOrders.ts` has zero references to either field — Module 03 gap re-confirmed at this call site) |
| 05.O | Duplicate-order helper | ❌ MISSING (small gap, not pilot-deferred) |
| 05.P | Edit rules — editable in any pre-CLOSED status with audit | partial — implementation deliberately narrows to DRAFT-only ("Cancel + recreate" is documented escape hatch); spec is broader. Scope cut, not a bug |
| 05.Q | Cancellation — any pre-CLOSED state; un-commit inventory; post-Closed cancel allowed with prompt | partial — pre-CLOSED ✅; post-CLOSED is **refused entirely** (forces RMA path); spec allows post-CLOSED with confirmation. Scope cut, not a bug |
| 05.R | INSUFFICIENT_STOCK_AT_CLOSE visibility audit (rolls-back-then-records-on-outer-db) | ✅ |
| 05.S | Multi-warehouse fulfillment / split-by-warehouse | DEFERRED |
| 05.T | Auto-split at Confirmed (drop-ship → child orders) | DEFERRED |
| 05.U | Manual split-by-vendor button | DEFERRED |
| 05.V | Combine orders | NOT supported per spec |
| 05.W | Quote = Draft (no separate model) | ✅ |
| 05.X | Shipping & handling — calculated at pack stage via ShipStation | DEFERRED — manual `shippingAmount` + `handlingAmount` accepted on close |
| 05.Y | Per-box dimensions/weight/tracking; multiple boxes per order | ❌ MISSING schema (no `SalesOrderBox` model) — DEFERRED-acceptable for pilot (manual labels), but called out |
| 05.Z | Documents — SO PDF, Pick Sheet, Packing Slip, Invoice PDF | DEFERRED (template/PDF phase, Module 9) |
| 05.AA | Auto-invoice on SO close | ✅ (lives in Module 06; closeSalesOrder calls `generateInvoiceForClosedSOTx`) |
| 05.BB | Auto-COGS posting on SO close | ✅ (lives in Module 02/08; closeSalesOrder calls `postCogsForInvoiceTx`) |

### (b) SERVICE LAYER

| Scope | File | Function(s) | Parameters | Completeness notes |
|---|---|---|---|---|
| 05.A/B/C/G/H/J/L/M | `src/server/services/salesOrders.ts` | `createSalesOrder(db, input, ctx?)` | `db: PrismaClient`, `input: CreateSalesOrderInput` (Zod), `ctx: AuditContext` | Sequence-allocated SO-YYYY-NNNNN. Resolves every line via `resolvePrice` (no bypass). Source defaults STAFF. orderDate auto-stamps. Order-level discount mutually exclusive % vs $ (Zod). Does NOT: check credit limit / AR hold; resolve sales rep / ship-to from customer record (free-text `shippingAddress` only); apply CustomerType-based tier discount (Module 02 resolver gap). |
| 05.P | same | `updateSalesOrder(db, id, input, ctx?)` | `db, id, input: UpdateSalesOrderInput, ctx` | DRAFT-only wholesale-replace lines; refuses post-DRAFT updates with explicit "Cancel + create" message. Spec calls for editable-in-any-pre-CLOSED — this is a deliberate pilot scope cut documented in code comment. |
| 05.B/C | same | `confirmSalesOrder(db, id, ctx?)` | `db, id, ctx` | DRAFT → CONFIRMED. Locks every distinct (variant, warehouse) bin in deterministic sort order (deadlock-safe under concurrent confirm/close). Sets `qtyReserved = qtyOrdered` per line, then recomputes `InventoryItem.reserved` per bin via `recomputeReservedForBin`. Refuses if no lines. Does NOT: check credit limit / AR hold; auto-split drop-ship lines (DEFERRED). |
| 05.B | same | `dispatchSalesOrder(db, id, ctx?)` | `db, id, ctx` | CONFIRMED → DISPATCHED. Stamps `dispatchedAt`. Pure status transition; no inventory action (reservation already in place). |
| 05.B/C/AA/BB/R | same | `closeSalesOrder(db, id, input?, ctx?)` | `db, id, input?: CloseSalesOrderInput, ctx` | Accepts CONFIRMED **and** DISPATCHED as legal source statuses (pickup-orders-skip-DISPATCHED). For each line: `consumeInventoryTx` → record `inventoryMovementId` on SOLine + zero qtyReserved + set qtyShipped. Status flip → recompute reserved per bin → `generateInvoiceForClosedSOTx` → `postCogsForInvoiceTx`. INSUFFICIENT_STOCK_AT_CLOSE: caught by outer try/catch, written via outer `db` client AFTER tx rollback so the visibility signal survives. Optional `shippingAmount` / `handlingAmount` overrides at close. |
| 05.Q | same | `cancelSalesOrder(db, id, input, ctx?)` | `db, id, input: CancelSalesOrderInput, ctx` | Refuses CLOSED ("use RMA/Returns instead") and already-CANCELLED. For CONFIRMED/DISPATCHED: zero qtyReserved on every line + recompute reserved per bin. `cancelReason` recorded in audit row. |
| 05.B | same | `softDeleteSalesOrder(db, id, ctx?)` | `db, id, ctx` | Only allowed for DRAFT or CANCELLED (refuses CONFIRMED/DISPATCHED/CLOSED). |
| 05.C | same | `recomputeReservedForBin(tx, variantId, warehouseId)` | `tx`, ids | Source of truth for `InventoryItem.reserved` is `SUM(SalesOrderLine.qtyReserved)` over un-deleted lines whose parent SO is in {CONFIRMED, DISPATCHED}. Self-heals; clamps negative drift to 0 with warn-log. Same pattern as `recomputeQtyReceivedForPoLine`. |
| Reads | same | `getSalesOrder`, `listSalesOrders` | `db, id` / `db, filters: { customerId?, status?, skip?, take? }` | Standard reads; lines included with `deletedAt: null` filter. |
| 05.O Duplicate | ❌ MISSING | — | — | No `duplicateSalesOrder` helper. Spec wants "Duplicate" button that copies lines/prices/discounts as-is, new SO number, status DRAFT, dates+shipping reset. Real gap. |
| 05.I OnHand/Available | ❌ MISSING | — | — | No service helper exposing OnHand + Available for a (variant, warehouse) at line-entry time. `getInventory` returns the raw `InventoryItem` row; caller must subtract `reserved` from `onHand`. GUI line-entry will need a dedicated helper. |
| 05.N Credit limit / AR hold | ❌ MISSING | — | — | Zero references to `creditLimit` or `arHoldDays` in `salesOrders.ts`. createSalesOrder + confirmSalesOrder both bypass these checks. Same gap surfaces from Module 03. |

### (c) SCHEMA

Models supporting Module 05:

- ✅ `SalesOrder` — `number`, `customerId`, `warehouseId`, `status` (5-value enum), `source` (3-value enum), `currency`, `customerPo`, `promisedShipDate`, `orderDate`, `orderDiscountPercent`, `orderDiscountAmount`, `shippingAmount`, `handlingAmount`, `shippingAddress` (free-text — schema comment notes this will be replaced with a proper Address relation when the customer master slice deepens), `customerNotes`, `internalNotes`, `createdById`, lifecycle timestamps (`confirmedAt`, `dispatchedAt`, `closedAt`, `cancelledAt`), `cancelReason`, `deletedAt`. Indexes on `(customerId, status)`, `(status, orderDate)`, `(warehouseId)`, `(deletedAt)`.
- ✅ `SalesOrderLine` — `variantId`, `warehouseId` (per-line, supports multi-warehouse), `qtyOrdered`, `qtyReserved`, `qtyShipped`, `unitPrice`, `priceRule` (PriceResolutionRule enum), `discountPercent`, `discountAmount` (mutually exclusive), `customerNote`, `internalNote`, `inventoryMovementId @unique` (set at close), `deletedAt`. Indexes on `(salesOrderId)`, `(variantId, warehouseId)`, `(deletedAt)`.
- ✅ `SalesOrderStatus` enum: DRAFT, CONFIRMED, DISPATCHED, CLOSED, CANCELLED — full spec match.
- ✅ `SalesOrderSource` enum: STAFF, PORTAL, SHOPIFY — schema ready for sources that aren't wired yet.

❌ Missing entirely:
- `SalesOrderBox` model (per-box dimensions, weight, tracking number, multiple boxes per order)
- Drop-ship parent/child link (`parentSalesOrderId`) — DEFERRED
- Vendor split parent/child link — DEFERRED
- Quote-vs-Draft distinction — N/A (per spec, Draft IS quote)
- Schema-level FK from SO to a structured ship-to address — currently just free-text. Schema comment acknowledges this is a known follow-on.

### (d) TEST COVERAGE

| File | Tests | Covers |
|---|---|---|
| `tests/integration/salesOrders.lifecycle.test.ts` | 9 | DRAFT create with sequence; confirm flips reservation; dispatch; close with COGS post + auto-invoice; pickup-orders-skip-DISPATCHED; cancel from each pre-CLOSED state |
| `tests/integration/salesOrders.editguards.test.ts` | 4 | Update refused outside DRAFT; soft-delete refused outside DRAFT/CANCELLED; cancel refused on CLOSED; cancel refused on already-CANCELLED |
| `tests/integration/salesOrders.concurrency.test.ts` | 2 | Concurrent confirm + close on same bin serialize via advisory locks; deadlock-safe ordering |
| `tests/integration/salesOrders.cancel.test.ts` | 6 | Cancel from DRAFT (no inventory action); cancel from CONFIRMED (un-reserve); cancel from DISPATCHED (un-reserve); cancel reason audit; cancel-then-soft-delete |
| `tests/integration/salesOrders.reservation.test.ts` | 4 | recomputeReservedForBin; SUM-based source of truth; CLOSED excluded from roll-up; clamp-negative-to-0 self-heal |
| `tests/integration/salesOrders.customerPricing.test.ts` | 3 | CUSTOMER_SPECIFIC override on SO line; MANUAL_OVERRIDE wins over override; BASE_PRICE fallback |

Total Module-05-direct: 28 tests.

NOT covered (capability missing):
- Credit limit enforcement
- AR hold enforcement
- Duplicate-order helper
- Real-time OnHand/Available helper
- TIER_DISCOUNT pricing on SO line
- PROMO pricing on SO line
- Edit-after-Confirmed (deliberately scoped out)
- Post-CLOSED cancellation (deliberately scoped out)
- Auto-split drop-ship at Confirmed (DEFERRED)
- Manual split-by-vendor (DEFERRED)
- Multi-warehouse split-on-insufficient-stock (DEFERRED)
- Per-box dimensions/tracking entry (DEFERRED-acceptable)

### (e) API LAYER

| Path | Verbs | Notes |
|---|---|---|
| `/api/sales-orders` | GET (list w/ filters), POST (create) | TODO permission |
| `/api/sales-orders/[id]` | GET, PATCH (DRAFT only), DELETE (soft-delete) | |
| `/api/sales-orders/[id]/confirm` | POST | |
| `/api/sales-orders/[id]/dispatch` | POST | |
| `/api/sales-orders/[id]/close` | POST | Body: optional shipping/handling overrides |
| `/api/sales-orders/[id]/cancel` | POST | Body: cancel reason |

❌ No API for: duplicate-order helper, real-time inventory display at line entry, drop-ship auto-split (DEFERRED), split-by-vendor (DEFERRED), multi-warehouse split (DEFERRED), per-box entry (DEFERRED), document/PDF generation (DEFERRED).

### (f) MISSING / STUBBED

Real gaps (counted against pilot — NOT in deferral list):
- [ ] Credit limit + AR hold enforcement at createSalesOrder + confirmSalesOrder
- [ ] Duplicate-order helper service + `/api/sales-orders/[id]/duplicate` endpoint
- [ ] Real-time OnHand/Available helper for line entry (small `getLineEntryStock(db, variantId, warehouseId)` returning `{ onHand, reserved, available }`)
- [ ] Sales rep + ship-to defaulting from customer record at create (currently caller-supplied)
- [ ] Structured ship-to FK on SO (replace free-text `shippingAddress` with `customerAddressId` link)
- [ ] TIER_DISCOUNT and PROMO resolution on SO lines (via Module 02 resolver fix)

Properly deferred (NOT counted against pilot):
- Auto-split drop-ship at Confirmed (drop-ship entirely deferred)
- Manual split-by-vendor (drop-ship-tied)
- Multi-warehouse split-on-insufficient-stock (multi-warehouse deferred)
- Customer portal SO source (portal deferred)
- Shopify SO source (integrations phase)
- ShipStation integration + per-box dimensions/weight/tracking (deferred for pilot)
- SO PDF / Pick Sheet / Packing Slip / Invoice PDF (template phase)
- Edit-after-Confirmed (deliberate pilot scope cut documented in code)
- Post-CLOSED cancellation (deliberate pilot scope cut — RMA path is the alternative)
- Quantity break auto-apply (qty-break deferred)
- Cost-plus pricing snapshot (cost-plus deferred)

### (g) PILOT-READY VERDICT

**⚠️ PARTIAL.**

The lifecycle is the most carefully built piece in the codebase outside the costing engine. Advisory locks on every (variant, warehouse) bin in deterministic order (deadlock-safe), reservation as a denormalized counter with self-healing recompute, INSUFFICIENT_STOCK_AT_CLOSE audit row that survives tx rollback by writing on the outer db client, integration with auto-invoice + auto-COGS-post in the same transaction. ~28 direct tests including concurrency proofs.

What blocks "ready":
1. **Credit limit + AR hold enforcement is missing** — `createSalesOrder` and `confirmSalesOrder` both bypass these checks. Naked Kratom can ship orders that silently exceed credit limits today. Same gap as Module 03 §03.O/P, surfaced again at the call site.
2. **TIER_DISCOUNT not resolving** — wholesale-first business with 5 customer-type tiers will fall through to BASE_PRICE for every line unless the pilot is OK with manual-override-everything. Not a Module 05 gap proper, but the consequence shows up here.
3. **Two small omissions** — duplicate-order helper, real-time OnHand/Available for line entry. Both will be felt the moment GUI work starts.

The deliberate pilot scope cuts (DRAFT-only edits, no post-CLOSED cancel) are documented in code with explicit error messages and may be fine for pilot. Worth a deliberate confirmation before GUI work — "Cancel + recreate" as the only edit path is a UX choice that benefits from being intentional.

### (h) PERMISSION GATING

`/api/sales-orders/*` routes carry the uniform `// TODO: wire requirePermission()`. Service functions take `ctx: AuditContext` but no permission check.

Suggested permission constants for the GUI build:
- `salesOrders.read` — list/get
- `salesOrders.create` — DRAFT create
- `salesOrders.edit_draft` — DRAFT update
- `salesOrders.confirm` — DRAFT → CONFIRMED (the "send to warehouse" act)
- `salesOrders.dispatch` — CONFIRMED → DISPATCHED (warehouse role)
- `salesOrders.close` — CONFIRMED/DISPATCHED → CLOSED (the "ship + invoice + post COGS" act)
- `salesOrders.cancel` — pre-CLOSED cancel
- `salesOrders.manual_price_override` — gate on whether the line entry can supply a `manualUnitPrice`
- `salesOrders.override_credit_hold` (future, depends on credit-limit enforcement landing first) — manager-override permission for orders that exceed credit limit / AR hold
- `salesOrders.soft_delete` — DRAFT/CANCELLED only

Highest-risk surfaces:
- `closeSalesOrder` — consumes inventory + creates FifoConsumption rows + posts COGS JE + generates invoice (downstream AR effect)
- `confirmSalesOrder` — moves stock from Available to Reserved, blocking other orders
- `cancelSalesOrder` from DISPATCHED/CONFIRMED — un-reserves stock, may surprise warehouse mid-pick

---

## Module 06 — Invoicing & AR

### (a) SCOPE

Per `docs/06-invoicing-ar.md`, v1 requires (with portal/Authorize.Net runtime/auto-pay deferred):

| ID | Capability | Pilot? |
|---|---|---|
| 06.A | Auto-invoice on SO Closed; Invoice # = SO #; idempotent re-call | ✅ |
| 06.B | Invoice contents — lines snapshot at close-time, decoupled from SO so SO edits cannot mutate posted invoices | ✅ |
| 06.C | "Email Invoice" manual button → Mailgun to billing contact | DEFERRED (Mailgun integration phase) |
| 06.D | Hybrid PDF storage (first send → store; staff views → render fresh; portal/re-emails → serve stored) | DEFERRED (PDF/template phase) |
| 06.E | Payment methods — CC, ACH, Wire, Check, Cash, Money Order, Applied Credits | partial — schema enum complete; CC runtime DEFERRED |
| 06.F | Authorize.Net auth/capture/refund/void operations | DEFERRED (integrations phase) |
| 06.G | Partial payments; aging continues from original invoice date | ✅ |
| 06.H | Overpayments → unapplied credit on customer | partial — payment rows can have `appliedAmount < amount` (unapplied surplus); no dedicated "ovepayment-becomes-CM" promotion |
| 06.I | Deposits (proactive prepay) — same model as overpayments | partial — `recordPayment` with no `applications` produces an unapplied payment that's queryable via `unappliedCreditBalance`; no separate deposit entity |
| 06.J | Payment application — explicit invoice ref OR no-ref-with-soft-warning | ✅ at service level (no-ref path is `recordPayment` without `applications`); soft-warning UX-side only |
| 06.K | Auto-generated payment receipt PDF + email | DEFERRED |
| 06.L | Returned check / failed ACH / chargeback — manual reverse with reason | ✅ via `reversePayment` |
| 06.M | Credit memo categories — admin-managed list, `affectsInventory` flag, optional `lossAccountId` | ✅ |
| 06.N | RMA lifecycle: PENDING → APPROVED → IN_TRANSIT → RECEIVED → INSPECTED → CREDITED + REJECTED terminal | ✅ |
| 06.O | Returnless RMA (photo + invoice + qty → direct credit, no goods) | ✅ schema (`returnless` flag); confirmed via `creditFromRma` path |
| 06.P | Restocking fee — flat OR % of return value, configurable default + per-RMA override | ✅ |
| 06.Q | Partial RMA — proportional credit + invoice line `qtyReturned` tracker | ✅ |
| 06.R | RMA inventory effect — returns to inventory at original FIFO cost ONLY when CM confirmed; rejection writes off | ✅ via Module 02's `reverseCogsForCreditMemoTx` (goods-back / loss-reclass / pure-AR routing) |
| 06.S | Credit memo redemption — apply to future invoices; no refund-to-original-payment via CM (edit original invoice instead); CMs don't expire | ✅ |
| 06.T | Refund methods — gateway refund (within window) OR manual AP entry (past window) | DEFERRED (depends on Authorize.Net + AP module) |
| 06.U | AR aging — Current / 1-30 / 31-60 / 61-90 / 91+; per-customer detail + tenant-wide summary | ✅ |
| 06.V | Statements — open balance + full activity, on-demand, PDF + email | ❌ MISSING |
| 06.W | AR hold rules — block new orders when AR > X days past due, manager override | ❌ MISSING (carry-over from Module 03) |
| 06.X | Late fees — % of balance, off by default, manual or auto-applied | ❌ MISSING |
| 06.Y | Bad debt write-off — credit memo with "Bad Debt Write-off" category; no dedicated function | ✅ (achievable via existing CM flow + admin-created category) |
| 06.Z | Auto journal posting — Invoice/Payment/CM/Refund per spec table | partial — Invoice + Payment + CM all post; Refund-flow JEs depend on T |
| 06.AA | Invoice "Disputed" flag (set by portal dispute) | DEFERRED (portal-tied) |
| 06.BB | Customer portal AR features (view balance, pay, apply credits, deposit, dispute, auto-pay) | DEFERRED |

### (b) SERVICE LAYER

| Scope | File | Function(s) | Parameters | Completeness notes |
|---|---|---|---|---|
| 06.A/B/Z | `src/server/services/invoices.ts` | `generateInvoiceForClosedSOTx(tx, salesOrderId, ctx?)`, `recomputeAmountPaidForInvoice(tx, invoiceId)`, `voidInvoice(db, invoiceId, reason, ctx?)`, `getInvoice(db, invoiceId)`, `listInvoices(db, filters)` | tx/db, ids, `reason: string` (non-empty enforced), filters | Auto-fires from `closeSalesOrder` inside same tx. Idempotent on `Invoice.salesOrderId` unique. Snapshots SOLines into InvoiceLines (decoupled). Posts AR JE (DR 1210 / CR 4100 net of order discount + CR 4200 shipping + CR 4300 handling). Skips zero-amount legs. Void refuses if any non-reversed CreditApplication exists (caller must reverse first); refuses if any CM has `cogsReversed=true` (would double-reverse). Void posts mirror-sign JE + calls `reverseCogsForInvoiceTx` (Part 3.5) atomically. Does NOT: support split invoices ({SO}-1, {SO}-2); generate PDF or email; flip "Disputed" flag. |
| 06.E/G/H/I/J/L | `src/server/services/payments.ts` | `recordPayment(db, input, ctx?)`, `reversePayment(db, input, ctx?)`, `applyPaymentToInvoice(db, paymentId, invoiceId, amount, ctx?)`, `applyCreditToInvoice(db, creditMemoId, invoiceId, amount, ctx?)`, `getPayment`, `listPayments` | `db`, `input` (Zod), `ctx`, ids, amounts | Payment rows sequence-allocated `PMT-YYYY-NNNNN`. APPLIED_CREDIT method walks CMs FIFO (oldest-first by createdAt) and creates `CREDIT_TO_INVOICE` apps; payment row itself stays at `appliedAmount=0` (no PAYMENT_TO_INVOICE rows). Standard cash-receipt path posts DR Cash / CR AR JE first, then writes apps. Optional `applications: [{ invoiceId, amount }]` for explicit-ref payments; absent → unapplied (queryable via `arBalanceForCustomer.unappliedCreditBalance`). Reverse path uses payment-level advisory lock; restores AR balance; recomputes `recomputeAmountPaidForInvoice` per affected invoice. Does NOT: orchestrate Authorize.Net runtime calls; auto-suggest oldest-first for unallocated checks (UX concern); generate payment receipt PDF. |
| 06.M/N/O/P/Q/R/S | `src/server/services/creditMemos.ts` | `createCreditMemoDraftTx(tx, input, ctx?)`, `createCreditMemoDraft(db, input, ctx?)`, `confirmCreditMemoTx(tx, id, ctx?)`, `confirmCreditMemo(db, id, ctx?)`, `voidCreditMemo(db, id, reason, ctx?)`, `getCreditMemo`, `listCreditMemos` | tx/db, `input: CreateCreditMemoInput` (Zod), id, `reason: string`, ctx | DRAFT → CONFIRMED → VOIDED. Sequence-allocated `CM-YYYY-NNNNN`. Confirm posts AR-side JE (DR Sales Returns / CR AR; restocking fee leg if applicable) + calls `reverseCogsForCreditMemoTx` (Part 3.5) for goods-back / loss-reclass / pure-AR routing per category + auto-applies to linked invoice (FIFO over open invoices for the customer when no specific invoice). |
| 06.N/O/P/Q | `src/server/services/rmas.ts` | `createRma(db, input, ctx?)`, `transitionRma(db, id, action, ctx?)`, `creditFromRma(db, id, ctx?)`, `getRma`, `listRmas` | `db, id`, `input: CreateRmaInput`, `action` (enum-bounded transition), ctx | Sequence-allocated `RMA-YYYY-NNNNN`. State machine enforces legal transitions PENDING → APPROVED → IN_TRANSIT → RECEIVED → INSPECTED → CREDITED + REJECTED. `creditFromRma` is the atomic "create + confirm CM" flow tied to the RMA's invoice + lines + restocking fee. `returnless` flag short-circuits the transit/received/inspected stages. Per-RMA `restockingFeePercent` / `restockingFeeFlat` overrides default. |
| 06.U | `src/server/services/ar.ts` | `arBalanceForCustomer(db, customerId, asOf?)`, `agingForCustomer(db, customerId, asOf?)`, `agingSummary(db, asOf?, opts?)` | `db, customerId`, `asOf: Date`, `opts: { limit?, offset? }` | Read-only. Returns `{ arBalance, unappliedCreditBalance }` separately — never netted. Bucket boundaries match spec exactly. AgingSummary uses 3 grouped queries (NOT N+1) for unapplied credit lookup. PaymentTerm.netDays === null treated as immediately-due (COD/Prepay convention). |
| 06.M | `src/server/services/creditMemoCategories.ts` | `createCategory`, `updateCategory`, `softDeleteCategory`, `getCategoryById`, `getCategoryByCode`, `listCategories` | db, payload, ctx | Admin-managed CRUD with code-keyed stable identifier. Soft-delete refuses if any non-deleted CM references the category. |
| 06.P | `src/server/services/restockingFee.ts` | `getRestockingFeeDefault(db)`, `setRestockingFeeDefault(db, value, ctx?)`, `resolveRestockingFee(args)` | `db`, value: `{ percent?, flat? }`, args: per-RMA + default | Reads/writes `Setting('restocking_fee_default')`. `resolveRestockingFee` is pure — given per-RMA overrides + default, returns the effective fee. |
| 06.W AR hold | ❌ MISSING | — | — | Carry-over gap from Module 03/05 — `Customer.arHoldDays` stored, not consulted by any service. The AR-side data needed (open invoices + days-past-due) is now confirmed available via `arBalanceForCustomer` + `agingForCustomer`. |
| 06.V Statements | ❌ MISSING | — | — | No `generateOpenBalanceStatement` / `generateFullActivityStatement` service. |
| 06.X Late fees | ❌ MISSING | — | — | No service. No Setting key for default %. No `lateFeeApplied` field on Invoice. |
| 06.T Refunds | ❌ MISSING | — | — | No `refundPayment` / `refundViaGateway` / `refundViaApEntry` service. Depends on Authorize.Net runtime + AP module landing. |
| `getOpenSosNotInvoicedTotal` | ❌ MISSING | — | — | Critical for credit-limit enforcement (full formula = `arBalance + openSosNotInvoiced + thisOrderTotal ≤ creditLimit`). `arBalanceForCustomer` provides the AR side; the in-flight SO total has no helper. Confirmed missing via grep on `openSos` / `notInvoiced` / `inFlightTotal`. |

### (c) SCHEMA

Models supporting Module 06:

- ✅ `Invoice` — `number` (= SO number), `salesOrderId @unique`, `customerId`, `warehouseId`, `status` (OPEN / PARTIAL / PAID / VOIDED), `subtotal`, `orderDiscount`, `shippingAmount`, `handlingAmount`, `total`, `amountPaid`, `amountCredited`, `currency`, `invoiceDate`, `customerNotes`, `internalNotes`, `storedPdfKey`, `emailedAt`, `voidedAt`, `voidReason`, `cogsPosted`, `cogsReversed`, `deletedAt`. Indexes on `(customerId, status)`, `(status, invoiceDate)`, `(cogsPosted)`, `(deletedAt)`.
- ✅ `InvoiceLine` — snapshot of SOLine at close-time (deliberately decoupled). `salesOrderLineId` nullable so a line can outlive its SO. `qtyReturned` tracker for partial RMAs.
- ✅ `Payment` — `number`, `customerId`, `method` (7-value enum incl. APPLIED_CREDIT), `status` (RECORDED / REVERSED), `amount`, `appliedAmount`, `currency`, `receivedAt`, `reference`, `notes`, `reversedAt`, `reversedReason`, `deletedAt`. Indexes on `(customerId, receivedAt)`, `(status, receivedAt)`.
- ✅ `CreditMemo` — `number`, `customerId`, `invoiceId?` (nullable for unattached CMs), `status` (DRAFT / CONFIRMED / VOIDED), `categoryId`, `amount`, `restockingFee`, `netCredit`, `appliedAmount`, `currency`, `reason`, `issuedAt`, `voidedAt`, `voidReason`, `cogsReversed`. Per-CM idempotency for COGS reversal.
- ✅ `CreditMemoLine` — qty / unitPrice / lineTotal / description; nullable `invoiceLineId` (for un-linked CMs).
- ✅ `CreditMemoCategory` — `code`, `label`, `affectsInventory` flag, optional `lossAccountId` FK to GlAccount (for loss-reclass routing).
- ✅ `Rma` — `number`, `customerId`, `invoiceId`, `status` (7-value), `returnless` flag, `reason`, `restockingFeePercent`, `restockingFeeFlat`, lifecycle timestamps (approved/received/inspected/credited/rejected/rejectedReason), `creditMemoId @unique`, `deletedAt`.
- ✅ `RmaLine` — `invoiceLineId`, `qty`, `reason`.
- ✅ `CreditApplication` — single source of truth for "this dollar applied to that dollar." `kind` enum (PAYMENT_TO_INVOICE, CREDIT_TO_INVOICE), nullable `paymentId` / `creditMemoId`, `invoiceId`, `amount`, `appliedAt`, `appliedById`, `reversedAt`, `notes`. Two partial unique indices (filtered by `reversedAt IS NULL`) — prevent multi-applying the same payment or CM to the same invoice while live.
- ✅ `JournalEntry` + `JournalEntryLine` (stub for full GL slice) — used by the AR/COGS auto-posting paths.
- ✅ `GlAccount` (stub) — flat list, code-keyed, AccountType enum.
- ✅ `Setting` (used by restockingFee).
- ✅ `Sequence` (used by Invoice/Payment/CM/RMA numbering — though Invoice reuses SO number, no separate sequence allocator).

❌ Missing entirely:
- `LateFee` model OR `lateFeeAmount` field on Invoice
- `Disputed` flag on Invoice (`disputedAt` / `disputedReason`)
- `Statement` snapshot model (for served-from-storage statement docs analogous to invoice PDF storage)
- Split-invoice support — Invoice has `salesOrderId @unique`, so {SO}-1 / {SO}-2 child invoices for drop-ship splits would require relaxing that constraint (deferred-with-drop-ship-deferred)

### (d) TEST COVERAGE

| File | Tests | Covers |
|---|---|---|
| `tests/integration/invoices.lifecycle.test.ts` | 11 | Auto-generation on SO close; idempotency on re-call; line snapshot independence; AR JE shape (all 4 legs); voidInvoice (refuse-with-applied-payments / refuse-with-CM-cogs-reversed / mirror JE / cogs-reversal-call) |
| `tests/integration/payments.lifecycle.test.ts` | 14 | recordPayment with explicit-ref / no-ref / partial / over-applied; APPLIED_CREDIT FIFO over CMs; reversePayment restores AR + recomputes invoice status; advisory lock on payment id |
| `tests/integration/creditMemos.lifecycle.test.ts` | 16 | DRAFT → CONFIRMED → VOIDED state machine; auto-apply on confirm (FIFO over open invoices); restocking fee line; goods-back vs loss-reclass routing via category lossAccountId |
| `tests/integration/creditMemoCategories.test.ts` | 14 | CRUD; soft-delete dependency check; affectsInventory + lossAccountId interactions |
| `tests/integration/rmas.lifecycle.test.ts` | 25 | Full state machine + transitions; returnless path; restocking fee flat/percent; partial RMA proportional credit; creditFromRma atomic flow; reject path |
| `tests/integration/ar.aging.test.ts` | 25 | All 5 buckets at boundary days; arBalance vs unappliedCreditBalance separation; PaymentTerm.netDays null = COD; agingForCustomer detail rows; agingSummary roll-up; pagination; non-N+1 query shape |
| `tests/integration/restockingFee.test.ts` | 12 | Setting CRUD; resolveRestockingFee precedence (per-RMA override beats default) |
| `tests/integration/validation.invoicing.test.ts` | 38 | Zod schema validation: payment input, CM input, RMA input, restocking fee shapes |
| `tests/integration/gl.post.test.ts` | 13 | The `lib/gl/post` helper used by all of the above |
| `tests/integration/glAccounts.test.ts` | 9 | GlAccount CRUD + code-keyed lookups |

Total Module-06-direct: ~177 tests (largest module by test count).

NOT covered (capability missing):
- AR hold enforcement at SO entry/confirm
- Statement generation
- Late fee accrual
- Refund flows (gateway + manual AP)
- Invoice email + payment receipt PDF
- Dispute flag flip
- `getOpenSosNotInvoicedTotal` for credit-limit
- Split invoices

### (e) API LAYER

Comprehensive surface:

| Path | Verbs |
|---|---|
| `/api/invoices` | GET (list), no POST (auto-only) |
| `/api/invoices/[id]` | GET |
| `/api/invoices/[id]/void` | POST |
| `/api/payments` | GET (list), POST (recordPayment) |
| `/api/payments/[id]` | GET |
| `/api/payments/[id]/apply` | POST |
| `/api/payments/[id]/reverse` | POST |
| `/api/credit-memos` | GET, POST (createDraft) |
| `/api/credit-memos/[id]` | GET |
| `/api/credit-memos/[id]/confirm` | POST |
| `/api/credit-memos/[id]/apply` | POST |
| `/api/credit-memos/[id]/void` | POST |
| `/api/credit-memo-categories`, `[id]`, `by-code/[code]` | full CRUD |
| `/api/rmas` | GET, POST |
| `/api/rmas/[id]` | GET |
| `/api/rmas/[id]/transition` | POST |
| `/api/rmas/[id]/credit` | POST |
| `/api/customers/[id]/aging` | GET |
| `/api/customers/[id]/ar-balance` | GET |
| `/api/ar/aging-summary` | GET |
| `/api/settings/restocking-fee-default` | GET, PATCH |

❌ No API for: statement generation; late fee apply; refund; dispute toggle; payment receipt PDF; invoice email send; getOpenSosNotInvoiced.

### (f) MISSING / STUBBED

Real gaps (counted against pilot):
- [ ] `getOpenSosNotInvoicedTotal(db, customerId)` helper — half of the credit-limit formula
- [ ] AR hold enforcement at SO entry/confirm (depends on credit-limit fix landing — same hooks)
- [ ] Statement generation (open balance + full activity) — service, PDF render, email
- [ ] Late fees — service, Setting key for default %, optional `lateFeeAmount` column on Invoice or separate `LateFee` model
- [ ] Refund flows (gateway via Authorize.Net + manual AP entry past-window) — depends on Authorize.Net runtime + AP module
- [ ] Invoice email send via Mailgun (depends on Mailgun integration)
- [ ] Payment receipt PDF + email (depends on PDF/template phase)
- [ ] HTTP wrapper for `arBalanceForCustomer` is present (`/api/customers/[id]/ar-balance`); no equivalent for `getOpenSosNotInvoicedTotal` because the helper doesn't exist

Properly deferred (NOT counted against pilot):
- Authorize.Net runtime (auth/capture/refund/void)
- Customer portal AR features (view balance, pay, dispute, deposit, auto-pay)
- Auto-pay enrollment
- Hybrid PDF storage rendering
- Disputed flag (portal-tied)
- Split invoices for drop-ship ({SO}-1, {SO}-2)

### (g) PILOT-READY VERDICT

**⚠️ PARTIAL leaning STRONG.**

This module is the most heavily tested in the codebase (~177 tests across 10 files). Auto-invoice on SO close is idempotent and atomic with COGS posting. Payments support all 7 methods including `APPLIED_CREDIT` with FIFO walk over CMs. Reverse path restores AR + recomputes invoice status. CM lifecycle is full: DRAFT → CONFIRMED → VOIDED with goods-back / loss-reclass / pure-AR routing per category. RMA state machine + creditFromRma atomic flow. AR aging produces both per-customer detail and tenant-wide summary in 3 grouped queries (no N+1). Restocking fee resolver, `arBalanceForCustomer` returning the {balance, unapplied-credit} pair as separate fields without netting — consistently good design.

What blocks "ready":
1. **`getOpenSosNotInvoicedTotal` helper missing** — closing the credit-limit loop requires this. Roughly 15 lines of service code.
2. **Statement generation missing** — small business pilot may not need statements on day one (customers can read invoices directly), but "Customer Statement (open balance)" is on the documents list in `docs/10`.
3. **Late fees missing** — spec says "off by default"; deferral-acceptable but called out.
4. **Refund flows missing** — depends on Authorize.Net runtime + AP module landing.

This module is the strongest "GUI can ship behind it" module in the codebase — invoice list/detail, payment record, CM create/confirm, RMA workflow, aging detail/summary all have clean back-end + API surface today.

### (h) PERMISSION GATING

All Module 06 API routes carry `// TODO: wire requirePermission()`.

Suggested permission constants:
- `invoices.read` / `invoices.void`
- `payments.read` / `payments.record` / `payments.apply` / `payments.reverse`
- `creditMemos.read` / `creditMemos.create_draft` / `creditMemos.confirm` / `creditMemos.void` / `creditMemos.apply`
- `rmas.read` / `rmas.create` / `rmas.transition` / `rmas.credit`
- `ar.read_aging`
- `settings.write_restocking_fee_default`

Highest-risk surfaces:
- `voidInvoice` — reverses AR + reverses COGS + posts mirror JEs (refuses with applied payments or already-CM-cogs-reversed; need permission gate beyond that)
- `confirmCreditMemo` — creates AR-reduction JE + restores inventory at original FIFO cost
- `creditFromRma` — atomic CM-create-and-confirm; same impact as confirmCreditMemo
- `reversePayment` — restores AR balance, may surprise customers if a payment they thought was settled gets reversed
- `recordPayment` with APPLIED_CREDIT — moves CM credit onto an invoice; lower-risk but financial impact

---

## Module 07 — Accounts Payable

### (a) SCOPE

Per `docs/07-accounts-payable.md`, v1 requires:

| ID | Capability | Pilot? |
|---|---|---|
| 07.A | PO ↔ Receipt ↔ Bill M:N — one Bill can span multiple POs/Receipts; one Receipt can spawn multiple Bills (rare); one PO can be billed across multiple Bills | ✅ in scope |
| 07.B | Bill numbering — auto BILL-NNNNN; vendor invoice # stored as `vendorReference` | ✅ in scope |
| 07.C | Bill creation flow — Receipt auto-creates draft Bill (qty + cost from receipt); AP staff cross-references vendor invoice → adjusts → confirms | ✅ in scope |
| 07.D | Bill statuses — DRAFT → CONFIRMED → SHIPPED/IN_TRANSIT → RECEIVED/CLOSED → CANCELLED, plus separate Payment status (Unpaid → Partially Paid → Paid) | ✅ in scope |
| 07.E | Bill line fields — variant + qty + cost + last cost / WAC / on-hand-context refs + optional per-line freight + customs/duty + notes | ✅ in scope |
| 07.F | Non-PO bills (expense) — separate workflow; categorized (utility / rent / shipping expense / travel / office / professional services); GL account per line | ✅ in scope (basic expense logging) |
| 07.G | Recurring bills | DEFERRED for v1 per spec (NOT pilot deferral — explicit v1 cut) |
| 07.H | Payment recording (logging-only — no bank API, no check printing, no ACH initiation): date, amount, method, account/source, reference, notes | ✅ in scope |
| 07.I | Bill payment dashboard — vendor / bill # / vendor invoice # / dates / balances / status; multi-select batch | ✅ in scope (read-side aggregation) |
| 07.J | Overpayment → vendor credit on that vendor's account | ✅ in scope |
| 07.K | Vendor credits — DRAFT → CONFIRMED → CANCELLED; manual application to any bill (not auto-applied per pilot) | ✅ in scope |
| 07.L | Payment void/cancel — manual reverse with reason; bill returns to unpaid; audit | ✅ in scope |
| 07.M | Landed cost on bills — direct path (vendor quotes landed) + late-freight path (separate freight bill, link to receipts, back-allocate) | partial — late-freight COMPUTE exists in Module 02 (`applyLandedCostToReceipts`); Bill FK on `LandedCostAllocation.sourceBillId` is a placeholder TEXT awaiting the Bill model |
| 07.N | Auto journal posting — accrued receipts (DR Inv / CR Accrued Receipts at receipt) → match (DR Accrued Receipts / CR AP-Vendor at bill confirm) → DR AP / CR Cash on payment | ❌ MISSING (no JE posts on Receipt or Bill events today; postReceipt does NOT post a Goods-Received-Not-Invoiced JE) |
| 07.O | Drop-ship vendors NOT in AP (shadow customer in AR) | DEFERRED (drop-ship entirely deferred) |
| 07.P | AP aging — bucketed; cash requirements report (7/14/30/60 days) | ❌ MISSING |
| 07.Q | Vendor statements — open balance + ledger view | ❌ MISSING |
| 07.R | 3-way match (PO ↔ Receipt ↔ Bill quantity + price reconciliation) | DEFERRED for v1 per spec (warning-only path is the v1 stance) |
| 07.S | "Accrued Receipts" clearing account + aged-balance reconciliation report | ❌ MISSING |

### (b) SERVICE LAYER

| Scope | File | Function(s) | Parameters | Completeness notes |
|---|---|---|---|---|
| 07.A through 07.L | ❌ MISSING | — | — | **No `bills.ts`, no `ap.ts`, no `vendorPayments.ts`, no `vendorCredits.ts`.** Glob on `src/server/services/{bill,bills,ap}*.ts` returns no files. |
| 07.M (late freight) | `src/server/services/landedCost.ts` | `applyLandedCostToReceipts`, `reverseLandedCostAllocation` | (covered in Module 02) | `sourceBillId` parameter is a plain TEXT? string (e.g., vendor's invoice number for operator reference) — the Bill FK constraint will be added when the Bill model lands. Half-wired: the operator-friendly string field is in place; relational integrity awaits. |
| 07.N (auto JE) | ❌ MISSING for AP | — | — | `postReceipt` does NOT post a "Goods Received, Not Invoiced" JE today. The spec calls for DR Inventory / CR Accrued Receipts at receipt time, then DR Accrued Receipts / CR AP-Vendor at bill confirm. Currently inventory increases (via FifoLayer + InventoryItem.onHand) without any GL counterpart — the AR side of the costing engine posts COGS on close, but the AP side has no offset. **This is a real GL gap, not just a missing module.** Without the Accrued Receipts / AP-Vendor leg, the trial balance is incomplete: inventory is debited at receipt without a credit to AP. |

### (c) SCHEMA

❌ **No models for AP exist.**

Confirmed via `grep '^model (Bill|VendorPayment|VendorCredit)' prisma/tenant/schema.prisma` → no matches.

What's needed for the AP slice (per spec):
- `Bill` — number (auto), vendorId, vendorReference (vendor's invoice #), status (BILL_STATUS enum: DRAFT/CONFIRMED/SHIPPED/RECEIVED/CANCELLED), paymentStatus (UNPAID/PARTIAL/PAID), billDate, dueDate, currency, subtotal, freightTotal, customsTotal, taxTotal, total, amountPaid, amountCredited, vendorReference, notes, voidedAt, voidReason, deletedAt, createdAt, updatedAt
- `BillLine` — billId, variantId? (nullable for expense lines), purchaseOrderLineId?, receiptLineId?, glAccountId? (for expense lines), qty, unitCost, lineTotal, freightAllocation?, customsAllocation?, description, notes, deletedAt
- `BillExpenseCategory` — admin-managed list (utility/rent/shipping-expense/travel/office/professional-services), code-keyed
- `VendorPayment` — number (auto VPAY-NNNNN), vendorId, method (ACH/WIRE/CHECK/CASH), amount, appliedAmount, paidAt, reference (check #, wire ref), notes, status (RECORDED/REVERSED), reversedAt, reversedReason, deletedAt
- `VendorCredit` — number (auto VCM-NNNNN), vendorId, billId? (nullable for unattached credits), status (DRAFT/CONFIRMED/CANCELLED), amount, appliedAmount, reason, issuedAt, voidedAt
- `BillPaymentApplication` — analogous to `CreditApplication` on the AR side; "this dollar of vendor payment / credit was applied to that dollar of bill"
- `LandedCostAllocation.sourceBillId` — flip from TEXT? to FK referencing `Bill.id` once Bill lands
- New GL stub accounts: 2010 AP, 2020 Accrued Receipts (the clearing account); these are admin-creatable via existing `glAccounts` service

### (d) TEST COVERAGE

❌ **No AP tests exist.**

Confirmed: zero `tests/integration/{bill,ap,vendorPayment,vendorCredit}*.test.ts` files. Module-07-direct test count: 0.

### (e) API LAYER

❌ **No AP routes exist.**

Confirmed: `src/app/api/{bills,ap,vendor-payments}/**/*.ts` glob returns nothing.

### (f) MISSING / STUBBED

The whole module. Concretely:

- [ ] `Bill` + `BillLine` + `BillExpenseCategory` schema models
- [ ] `VendorPayment` + `BillPaymentApplication` schema
- [ ] `VendorCredit` schema
- [ ] Bill auto-create-draft from POSTED Receipt (small hook in `postReceipt` or a sibling service)
- [ ] Bill confirm flow + DR Accrued Receipts / CR AP JE post
- [ ] **Goods-Received-Not-Invoiced JE on Receipt post** — DR Inventory / CR Accrued Receipts. Currently missing. This is the cleanest slot for the inventory-side AP-counterpart leg.
- [ ] Vendor payment recording (logging-only) + DR AP / CR Cash JE
- [ ] Vendor credit DRAFT → CONFIRMED → CANCELLED + auto-apply on confirm (FIFO-over-bills, mirroring CM auto-apply pattern from Module 06)
- [ ] AP aging service (mirrors `arBalanceForVendor`, `agingForVendor`, `agingSummary` shapes from `src/server/services/ar.ts` — that template applies cleanly)
- [ ] Cash requirements report (next 7/14/30/60 days from open bill due dates)
- [ ] Vendor statements (open balance + ledger view)
- [ ] Accrued Receipts reconciliation report
- [ ] API surface — `/api/bills`, `/api/bills/[id]`, `/api/bills/[id]/confirm`, `/api/bills/[id]/cancel`, `/api/vendor-payments` (record + reverse), `/api/vendor-credits` + confirm/cancel, `/api/vendors/[id]/aging`, `/api/vendors/[id]/ap-balance`, `/api/ap/aging-summary`, `/api/ap/cash-requirements`
- [ ] FK conversion: `LandedCostAllocation.sourceBillId` from TEXT? to Bill FK
- [ ] Seed Accrued Receipts (2020) + Accounts Payable (2010) GL accounts via migration

Properly deferred per spec (NOT counted against pilot):
- Recurring bill templates
- 1099-NEC reporting
- ACH/wire/check printing automation
- Bank reconciliation
- Full expense module (approval workflow, receipt attachment, reimbursements)
- Auto-apply vendor credits
- Early payment discount tracking (2/10 Net 30)
- 3-way match enforcement (warning-only is the v1 stance)
- Payroll module

### (g) PILOT-READY VERDICT

**❌ NOT STARTED.**

Per CLAUDE.md, AP is the explicit "CURRENT" build phase: "8. ⏳ Bills / AP ← CURRENT (separate phase — depends on Receipts, which are done)." 0% built today is the expected state.

Beyond the missing module proper, the absence of AP exposes one operational concern that's NOT just a future-slice gap: the **GL is currently inventory-debit-without-credit at receipt time**. `postReceipt` creates a `FifoLayer` and increases `InventoryItem.onHand` but does NOT post `DR Inventory / CR Accrued Receipts`. So today's trial balance has Inventory growing every time a receipt posts, with no offsetting credit anywhere — until a future Bill + JE close that loop. For the pilot's parallel-run reconciliation phase (per `docs/10`), this matters because trial balance won't tie. Worth flagging as a "land alongside the AP slice" item, not a separate cleanup task.

The PO + Receipt strength on the upstream side means the AP slice has cleanly-defined inputs to consume. The CM/RMA + AR aging work in Module 06 is the design template — the AR side has `CreditApplication`, `arBalanceForCustomer`, `agingForCustomer`, `agingSummary`, FIFO-over-CMs in `applyFifoCmCreditTx`, and the AP side should mirror these shapes (`BillPaymentApplication`, `apBalanceForVendor`, `agingForVendor`, FIFO-over-vendor-credits). Roughly the same scope as Module 06 — high test count, multiple sub-services, comprehensive API.

### (h) PERMISSION GATING

N/A — no services exist to gate. When the slice lands, suggested constants (mirroring Module 06):

- `bills.read` / `bills.create` / `bills.confirm` / `bills.void` / `bills.cancel`
- `vendorPayments.read` / `vendorPayments.record` / `vendorPayments.reverse` / `vendorPayments.apply`
- `vendorCredits.read` / `vendorCredits.create_draft` / `vendorCredits.confirm` / `vendorCredits.cancel` / `vendorCredits.apply`
- `ap.read_aging` / `ap.read_cash_requirements`

Highest-risk surfaces (when built):
- `confirmBill` — posts AR-mirror JE (DR Accrued Receipts / CR AP-Vendor) and triggers cost-variance reconciliation against PO + Receipt
- `recordVendorPayment` — moves cash; logging-only but the bill-balance update is the financial mutation
- `reverseVendorPayment` — restores AP balance; same surprise potential as customer-side `reversePayment`
- `confirmVendorCredit` — creates DR AP / CR Vendor Credits Available; auto-applies to bills

---

## Module 08 — GL / Costing / Reporting

### (a) SCOPE

Per `docs/08-gl-costing-reporting.md`, v1 requires (with pilot deferrals — multi-warehouse inventory accounts, drop-ship commission accounts, custom report builder — removed):

| ID | Capability | Pilot? |
|---|---|---|
| 08.A | Chart of Accounts — 5-type structure (Asset/Liability/Equity/Revenue/Expense), code-keyed, admin self-serve | partial — flat 9-account stub seeded; full COA + admin self-serve UI gap |
| 08.B | COA hierarchy — tree with unlimited depth (parent → sub-accounts) | ❌ MISSING (no `parentId` field on `GlAccount`) |
| 08.C | Multi-warehouse inventory accounts (1300 / 1310 / ...) — auto-create on warehouse create | DEFERRED (multi-warehouse deferred; pilot single-warehouse uses 1310) |
| 08.D | `lib/gl/post()` helper — single sanctioned path for JE creation; balance check; XOR-per-line; idempotency on (entityType, entityId, description); account-code lookup; `JE-YYYY-NNNNN` numbering; optional backdated `postedAt` | ✅ |
| 08.E | Auto-JE on **SO Closed** (DR AR / CR Sales + Shipping Income + Handling Income) | ✅ via `generateInvoiceForClosedSOTx` |
| 08.F | Auto-JE on **SO Closed COGS** (DR COGS / CR Inventory per warehouse) | ✅ via `postCogsForInvoiceTx` |
| 08.G | Auto-JE on **Customer payment received** (DR Cash / CR AR) | ✅ via `recordPayment` (cash path; APPLIED_CREDIT correctly skips since cash didn't move) |
| 08.H | Auto-JE on **payment reverse** (mirror of G) | ✅ via `reversePayment` |
| 08.I | Auto-JE on **Credit Memo confirm** (DR Sales Returns / CR AR + COGS reversal routing) | ✅ via `confirmCreditMemoTx` + `reverseCogsForCreditMemoTx` |
| 08.J | Auto-JE on **Invoice void** (mirror of E + COGS reversal) | ✅ via `voidInvoice` + `reverseCogsForInvoiceTx` |
| 08.K | Auto-JE on **PO Receive** (DR Inventory / CR Accrued Receipts) | ❌ MISSING — `postReceipt` does NOT call `post()` (movements.ts has zero `post(` calls) |
| 08.L | Auto-JE on **Receive cancel** (mirror of K) | ❌ MISSING |
| 08.M | Auto-JE on **Bill confirmed** (DR Accrued Receipts / CR AP-Vendor) | ❌ MISSING (depends on AP slice) |
| 08.N | Auto-JE on **Bill paid** (DR AP / CR Cash) | ❌ MISSING (depends on AP slice) |
| 08.O | Auto-JE on **Inventory adjustment** (DR Inv Adjustment Expense / CR Inventory; reverse for found stock; reason required) | ❌ MISSING — `createAdjustmentTx` does NOT call `post()` |
| 08.P | Auto-JE on **Stock transfer** (DR Inv-WHB / CR Inv-WHA) | DEFERRED (multi-warehouse) |
| 08.Q | Auto-JE on **Build/assembly** (DR finished / CR components + labor) | DEFERRED |
| 08.R | Auto-JE on **Drop-ship commission earned + collected** | DEFERRED (drop-ship) |
| 08.S | Late landed cost — retroactive layer mutation + backdated COGS adjustment JE per (invoice, warehouse); reversal path with mirror JE; period gating | partial — UNIT_COUNT + VALUE wired, period gating MISSING (intentional — `landedCost.ts` TODO comment) |
| 08.T | Manual JE entry (admin) — permission-controlled, reason required, reversal capability, audit-logged | ❌ MISSING (no admin manual-JE service or API) |
| 08.U | Period close — soft (editable by accountants) and hard (manager override + reason) | ❌ MISSING (no `AccountingPeriod` model, no service) |
| 08.V | Year-end close — manual trigger; auto-zeros income+expense to retained earnings | ❌ MISSING (no service; no Equity/Retained Earnings account seeded) |
| 08.W | Fiscal year — default calendar; admin-configurable | ❌ MISSING (no Setting key for fiscal year) |
| 08.X | Trial Balance report | ❌ MISSING |
| 08.Y | Income Statement / P&L (date range; comparison periods) | ❌ MISSING |
| 08.Z | Balance Sheet (point in time) | ❌ MISSING |
| 08.AA | Cash Flow Statement (date range, indirect method) | ❌ MISSING |
| 08.BB | General Ledger (per account, all transactions) | ❌ MISSING |
| 08.CC | Journal Report (all JEs in date range) | ❌ MISSING |
| 08.DD | Comparison reports (this vs prior period; this vs same period last year; YTD vs prior YTD) | ❌ MISSING |
| 08.EE | Operational reports — sales by customer/item/rep/warehouse/category, top-by-X, profit margin, AOV, CLV, inventory valuation/aging/movement, slow-moving, dead stock | ❌ MISSING (operational reporting is 0%) |
| 08.FF | Reorder suggestions / inventory in transit / inventory with returns/defects reports | ❌ MISSING + depends on Module 02 reorder fields |
| 08.GG | Custom report builder — drag-and-drop, save+share, permission-gated | DEFERRED |
| 08.HH | Report scheduling — daily/weekly/monthly auto-email via Mailgun | DEFERRED |
| 08.II | Dashboard widgets — open SOs, open POs, AR/AP aging, today's sales, cash position, low stock, expiring cards/docs, sales rep dashboard, disputed invoices, unapplied payments | ❌ MISSING (depends on individual data services + admin UI) |
| 08.JJ | Sales tax — tracking only, no engine; resale cert storage; reports by state | partial — resale cert storage ✅ (Module 03); Sales Tax Payable account NOT seeded; tax-by-state report ❌ MISSING |
| 08.KK | Multi-currency — USD only v1; nullable `currency` field on transactions | ✅ schema ready (currency is nullable on every monetary entity) |
| 08.LL | Auto-create accounts on certain events (single-AR/AP-control approach with sub-ledger detail; per-vendor commission sub-account auto-create) | DEFERRED (drop-ship) |
| 08.MM | Reconciliation checks at period close (AR/AP control vs subledger; Inventory account vs FIFO sum; Cash vs payments; Accrued Receipts zero) | ❌ MISSING (depends on period-close + AP) |

### (b) SERVICE LAYER

| Scope | File | Function(s) | Parameters | Completeness notes |
|---|---|---|---|---|
| 08.D | `src/lib/gl/post.ts` | `post(tx, input)` | `tx: Prisma.TransactionClient`, `input: { entityType, entityId, description, lines: [{ accountCode, debit?, credit?, memo? }], postedAt? }` | Single sanctioned JE path. Validates per-line debit XOR credit + non-negative; balance check at full Decimal precision; (entityType, entityId, description) + `reversedAt:null` + `deletedAt:null` idempotency guard; batched account-code → id lookup; `JE-YYYY-NNNNN` sequence allocation; optional `postedAt` for backdated posts (used by late-landed-cost adjustments); `createdAt` is never overridden. |
| 08.A | `src/server/services/glAccounts.ts` | `createAccount`, `updateAccount`, `softDeleteAccount`, `getAccount`, `getAccountByCode`, `listAccounts` | db, payload (Zod), id, ctx | Stub-slice CRUD. Soft-delete refuses if ANY `JournalEntryLine` references the account (including reversed JEs — conservative stance acknowledged in code comment). Does NOT support: parent/child hierarchy (no `parentId` field); account renumbering (immutable `code`); multi-warehouse inventory account auto-create on warehouse create. |
| 08.E/J | `src/server/services/invoices.ts` | `generateInvoiceForClosedSOTx`, `voidInvoice` | (covered in Module 06) | Posts AR JE on close, mirror AR JE on void. |
| 08.F | `src/server/services/cogsPosting.ts` | `postCogsForInvoiceTx(tx, invoiceId, ctx?)` | `tx, invoiceId, ctx` | Posts DR 5100 / CR <warehouse-Inventory> per (invoice, warehouse). Idempotent via Invoice.cogsPosted flag + post()'s description-based guard. |
| 08.J | `src/server/services/cogsReversal.ts` | `reverseCogsForInvoiceTx`, `reverseCogsForCreditMemoTx` | `tx, id, ctx` | Goods-back / loss-reclass / pure-AR routing per CM category. Posts mirror JEs. |
| 08.G/H | `src/server/services/payments.ts` | `recordPayment` (forward post), `reversePayment` (mirror post) | (covered in Module 06) | 2 `post()` calls confirmed via grep. |
| 08.I | `src/server/services/creditMemos.ts` | `confirmCreditMemoTx` | (covered in Module 06) | Posts AR-side reduction JE; calls `reverseCogsForCreditMemoTx`. |
| 08.S | `src/server/services/landedCost.ts` | `applyLandedCostToReceipts`, `reverseLandedCostAllocation` | (covered in Module 02) | Backdated COGS adjustment JEs per (invoice, warehouse); reverse via mirror JEs. **Period gating: TODO comment acknowledges deferred — pilot has no period-close yet, so this hasn't been forced.** |
| 08.K/L receive JE | ❌ MISSING | — | — | `src/server/services/movements.ts` has **zero `post(` calls** (grep confirmed). `receiveInventoryTx`, `reverseReceiveTx`, `createAdjustmentTx`, `transferInventoryTx` all mutate inventory + write FifoLayer rows + write audit rows — no GL posts. |
| 08.O adjustment JE | ❌ MISSING | — | — | `createAdjustmentTx` does NOT post DR Inventory Adjustment Expense / CR Inventory. Spec requires reason field; service collects only free-text `notes`. |
| 08.M/N AP JEs | ❌ MISSING | — | — | Depends on AP slice (Module 07). |
| 08.T manual JE | ❌ MISSING | — | — | No admin-facing manual JE service. `post()` is internally callable but is intended for service-to-service auto-posting; the manual-entry path needs a wrapper that adds permission gate + reason field + admin-supplied debit/credit lines. |
| 08.U/V/W period close + year-end + fiscal year | ❌ MISSING | — | — | Grep on `AccountingPeriod` / `periodClose` / `softClose` / `hardClose` / `FiscalYear` returns only `landedCost.ts` + `cogsPosting.ts` (TODO comments referencing the future feature). No service, no schema model. |
| 08.X–08.DD financial reports | ❌ MISSING | — | — | Grep on `trialBalance` / `incomeStatement` / `balanceSheet` / `generalLedger` returns no service files. |
| 08.EE–08.FF operational reports | ❌ MISSING | — | — | No `reports/` directory under `src/server/services/`. |
| 08.II dashboard widgets | partial | — | — | Underlying data is queryable for some widgets (AR aging via `agingSummary`, open SOs via `listSalesOrders`, open POs via `listPurchaseOrders`, expiring cards/docs via `findPaymentMethodsExpiringWithin` / `documentsExpiringWithin`). No dashboard aggregator service or layout config. |

### (c) SCHEMA

GL-specific models present:

- ✅ `GlAccount` — code-unique, name, type (5-value `AccountType` enum), active, deletedAt. Indexes on `(type)`. **Missing**: `parentId` for hierarchy; `warehouseId` for multi-warehouse inventory accounts (deferred); `subaccountOf` / `controlAccount` flags.
- ✅ `JournalEntry` — number (JE-YYYY-NNNNN), entityType + entityId (operational source for drill-down), postedAt (default now()), description, reversedAt + reversedBy, deletedAt. Indexes on `(entityType, entityId)`, `(postedAt)`.
- ✅ `JournalEntryLine` — journalEntryId, accountId, debit + credit (both default 0; XOR enforced at service level via `post()`), memo. Indexes on `(journalEntryId)`, `(accountId)`.

Seeded GL accounts (9, via the `add_gl_stub` migration with stable hardcoded IDs):
- 1110 Cash / Bank (ASSET)
- 1210 Accounts Receivable (ASSET)
- 1310 Inventory - Main Warehouse (ASSET)
- 4100 Sales Revenue (REVENUE)
- 4200 Shipping Income (REVENUE)
- 4300 Handling Income (REVENUE)
- 4500 Sales Returns (REVENUE)
- 4600 Restocking Fee Income (REVENUE)
- 5100 Cost of Goods Sold (EXPENSE)

❌ Missing GL accounts that the spec requires for v1:
- 2010 Accounts Payable (LIABILITY) — needed for Module 07 + the 08.K Accrued-Receipts pair
- 2020 Accrued Receipts (LIABILITY) — needed for receipt-time JE pair (cross-references the Module 07 finding)
- 2100 Sales Tax Payable (LIABILITY) — needed for sales tax tracking (08.JJ)
- 3000 Owner's Equity / 3100 Retained Earnings (EQUITY) — needed for year-end close + balance sheet
- 5200 Inventory Adjustment Expense (EXPENSE) — needed for 08.O
- 5500 Bad Debt Expense (EXPENSE) — for the bad-debt-write-off CM category (Module 06 §06.Y)
- 4400 Commission Revenue (REVENUE) — DEFERRED with drop-ship
- 1220 Commission Receivable - Vendor X (ASSET sub-account) — DEFERRED with drop-ship
- 6000–9000 series Operating Expenses for non-PO bills (utilities, rent, etc.) — needed when Module 07's expense-bill workflow lands

❌ Missing entirely:
- `AccountingPeriod` model (period definition + soft/hard close state + close timestamp + close-by-userId + close reason)
- `FiscalYear` configuration (Setting key acceptable; no model needed)
- `Statement` model (if statements get the same hybrid-PDF storage shape as invoices)

### (d) TEST COVERAGE

| File | Tests | Covers |
|---|---|---|
| `tests/integration/gl.post.test.ts` | 13 | `post()` — XOR-per-line, non-negative, balance check, idempotency on (entityType, entityId, description), reversed-JE-doesn't-block, account-code resolution with deletedAt filter, batched lookup, JE numbering |
| `tests/integration/glAccounts.test.ts` | 9 | CRUD + soft-delete dependency check (any JournalEntryLine reference blocks) + listAccounts filtering |

Indirect coverage: every other module's GL-touching tests exercise `post()` end-to-end — `cogsPosting.test.ts` (11), `cogsReversal.test.ts` (17), `landedCost.test.ts` (17), `invoices.lifecycle.test.ts` (11), `payments.lifecycle.test.ts` (14), `creditMemos.lifecycle.test.ts` (16), `creditMemoCategories.test.ts` (14). The `post()` helper is among the most-exercised pieces of code in the repo.

NOT covered (capability missing):
- Receipt-time JE
- Inventory adjustment JE
- Stock transfer JE (deferred)
- Manual JE entry
- Period close
- Year-end close
- All financial reports
- All operational reports
- Dashboard widgets

### (e) API LAYER

| Path | Verbs | Notes |
|---|---|---|
| `/api/gl-accounts` | GET (list w/ filters), POST (create) | TODO permission |
| `/api/gl-accounts/[id]` | GET, PATCH, DELETE (soft-delete) | |
| `/api/gl-accounts/by-code/[code]` | GET | |

❌ No API for: manual JE entry, period close, year-end close, fiscal year config, trial balance, P&L, balance sheet, cash flow, GL detail, journal report, any operational report, any dashboard widget aggregator. The full reporting + close surface is 0% — only the GlAccount stub CRUD exists.

### (f) MISSING / STUBBED

The biggest module's biggest gap list. Real gaps (counted against pilot):

🐛 **Two GL-counterpart-leg gaps in already-shipped code (parallel to the Module 07 finding):**
- [ ] 🐛 `postReceipt` does not post `DR Inventory / CR Accrued Receipts`. **Inventory grows on every receive with no offsetting credit anywhere until a Bill closes the loop.** (Module 07 finding, repeated here for completeness — this lives equally in 07 and 08.)
- [ ] 🐛 `createAdjustmentTx` does not post `DR Inventory Adjustment Expense / CR Inventory` (or the reverse for found stock). **Adjustments mutate stock without any GL impact.** Same shape as the receive gap. Smaller scope (lower volume), same severity for trial-balance correctness.

Other real gaps:
- [ ] Seed missing GL accounts: 2010 AP, 2020 Accrued Receipts, 2100 Sales Tax Payable, 3000 Owner's Equity, 3100 Retained Earnings, 5200 Inventory Adjustment Expense, 5500 Bad Debt Expense
- [ ] COA hierarchy — `parentId` on `GlAccount`; tree query helpers; cycle detection
- [ ] `AccountingPeriod` model + `closePeriodSoft` + `closePeriodHard` + period-gate guard for `post()`
- [ ] Year-end close service (zero income+expense to retained earnings; lock year)
- [ ] Fiscal year Setting key + admin config
- [ ] Manual JE entry service + API + permission gate
- [ ] Trial Balance report service + API
- [ ] Income Statement / P&L report service + API + comparison-period support
- [ ] Balance Sheet report service + API
- [ ] Cash Flow Statement report service + API
- [ ] General Ledger report service + API
- [ ] Journal Report service + API
- [ ] Operational reports — sales by X, top-by-X, profit margin, AOV, CLV, inventory valuation/aging/movement, slow-moving, dead stock
- [ ] Dashboard widget aggregators + layout config
- [ ] Reconciliation checks at period close (AR control vs subledger, Inventory vs FifoLayer SUM, Cash vs payments, Accrued Receipts is zero)
- [ ] Sales tax payable account + by-state report
- [ ] Period gating on `landedCost.applyLandedCostToReceipts` (acknowledged TODO)
- [ ] Period gating on `cogsPosting.postCogsForInvoiceTx` (acknowledged TODO with `cogsPostingBlocked` field)

Properly deferred per spec (NOT counted against pilot):
- Multi-warehouse inventory accounts (1300/1310/...)
- Drop-ship commission accounts (1220/4400 sub-accounts)
- Stock transfer JE (multi-warehouse deferred)
- Build/assembly JE (deferred)
- Custom report builder
- Report scheduling

### (g) PILOT-READY VERDICT

**❌ NOT STARTED for the GL slice proper.**

⚠️ **PARTIAL** if you measure only what's been built incidentally to support other modules: the `post()` helper, the `GlAccount` stub CRUD, the 9 seeded accounts, and the auto-JE pattern wired into AR / COGS / payments / CMs / late landed cost. That foundation is solid (~22 dedicated GL tests + heavy indirect coverage from every AR test).

But what `docs/08` actually requires — COA hierarchy, period close, year-end close, manual JE, all 6 standard financial reports, all operational reports, dashboard widgets, reconciliation checks — is 0% built.

**Two blockers worth pulling forward:**
1. **The receipt-time GL leg gap** (carried from Module 07) — "books actually balance" fix. Smallest possible slice, biggest impact.
2. **The inventory-adjustment GL leg gap** — same shape, same fix pattern.

Both can land in the same micro-slice that seeds 2020 Accrued Receipts + 5200 Inventory Adjustment Expense and adds the 2 `post()` calls. Roughly the size of Part 3 of the costing engine.

Beyond those: pilot can run without period close (no formal close process planned for first 30–60 days of parallel run), without year-end close (Year 1 hasn't ended), without manual JE (rare in pilot), and without financial reports (accountant can run reports against trial balance once it ties — which requires the two gap fixes above). Operational reports are nice-to-have for the pilot operator; without them, the GUI dashboards are read-only stubs, which is acceptable launch shape.

### (h) PERMISSION GATING

`/api/gl-accounts/*` carry the uniform `// TODO: wire requirePermission()`. `post()` is a library-level helper — never directly exposed to HTTP, always called from service code, so its permission gating is the responsibility of the calling service.

Suggested permission constants when the full GL slice lands:
- `gl.read_accounts` / `gl.write_accounts`
- `gl.post_manual_je` — heavily restricted (accountant + manager)
- `gl.reverse_je` — admin-level (the existing `reversedAt` field implies this exists; service to do it does not yet)
- `gl.close_period_soft` / `gl.close_period_hard`
- `gl.override_closed_period` — manager + reason
- `gl.close_year_end`
- `gl.read_trial_balance` / `gl.read_income_statement` / `gl.read_balance_sheet` / `gl.read_cash_flow` / `gl.read_general_ledger` / `gl.read_journal_report`
- `reports.run_operational` (broad) + per-report fine-grained gates if needed
- `reports.build_custom` (deferred)
- `reports.schedule` (deferred)
- `dashboard.read` (per-widget gates can ride on the underlying entity permissions — e.g., AR aging widget gates on `ar.read_aging`)

Highest-risk surfaces (when built):
- Manual JE post — directly mutates the GL; permission + reason + audit are the safety net
- Period close (soft + hard) — gates every subsequent JE post
- Year-end close — locks the year; equity adjustments move from operations to the books permanently
- Override-closed-period — the master key; should require both permission and explicit reason

---

## Module 09 — Admin / Settings UI / Self-Serve Config

### (a) SCOPE

Per `docs/09-admin.md`, v1 requires (with template-phase items deferred per `docs/10`):

| ID | Capability | Pilot? |
|---|---|---|
| 09.A | Permission model — two-tier (Super Admin + Custom Roles); checkbox-defined granular permissions across Customer / SO / Inventory / Vendor-PO / Bill-AP / Invoice / RMA / GL / Reports / Admin | ❌ MISSING |
| 09.B | User CRUD — email, full name, phone, title, department, assigned warehouse, sales-rep flag + commission tier, enabled/disabled, last login, force-password-reset flag | ❌ MISSING |
| 09.C | Multi-instance access — one email = one login per company; cross-company login NOT supported | ✅ trivially (deployment-time per-tenant DB; see Module 01) |
| 09.D | Authentication — email + password | ❌ MISSING |
| 09.E | 2FA on unrecognized IP/device with system fingerprint; per-user always-on toggle; global enforcement Setting; email code default + authenticator app optional | DEFERRED for pilot per `docs/10` ("2FA enforcement deferred") |
| 09.F | Password policy — 8 chars min, upper/lower/numbers/special; no expiration; no history | ❌ MISSING |
| 09.G | Session management — no auto-logout | ❌ MISSING (but trivial once auth lands) |
| 09.H | Audit log entry contents (timestamp, user, action, entity, entityId, before/after, IP, reason) — append-only, retained forever | ✅ schema + helper (Module 01); read/search/filter/export UI MISSING |
| 09.I | Audit log UI — searchable, filterable (user/date/entity/action), CSV exportable, drill-down to record's full history | ❌ MISSING (no read API; no list endpoint; no CSV export) |
| 09.J | Soft-delete by default on major entities | ✅ at schema level; centralized middleware MISSING (Module 01); per-service hand-rolled across the codebase |
| 09.K | Hard-delete (Super Admin only) — explicit confirmation + reason logged; **blocked when dependents exist**; clickable list of dependents with counts | ❌ MISSING — no service. Each entity's soft-delete has its own dependency check (Customer ← SO, SalesRep ← Customer, etc.) but there's no hard-delete path or a unified "show dependents and offer cascade" surface |
| 09.L | Self-serve admin Settings — bank accounts, GL, payment terms, tax rates, late payment %, shipping methods, warehouses, handling fee tiers, reorder points, product categories, brands, CM/RMA/expense categories, commission rates, document/email templates, company info, fiscal year, AR threshold, negative inventory flag | partial — most CRUDs handled by per-domain services (paymentTerms, glAccounts, customerCategories, creditMemoCategories, salesReps, warehouse); no unified admin-settings surface; many spec items have no service |
| 09.M | Generic `Setting` service for tenant-wide single values (key/value with per-key Zod) | ✅ |
| 09.N | Document template editor — visual, live preview, edit text labels, add/remove/hide columns, logo upload, color scheme, footer | DEFERRED (template phase, Module 9 in build phasing) |
| 09.O | Email template editor — same approach as document templates; merge fields | DEFERRED (template phase) |
| 09.P | Configuration values registry — restocking fee, late fee, negative inventory, AR hold, qty break auto-apply, cost-change alert threshold, vendor min order warning, backorder queue expiration, 2FA enforcement, PDF storage strategy | partial — only `restocking_fee_default` + `negative_inventory_allowed` keys defined |
| 09.Q | System health — recalc FIFO layers (range or full); recalc WAC; recalc GL balances; verify referential integrity (orphan detection); re-sync Shopify; test integrations; backup status; view Inngest queue | partial — `backfillFifoLayers` script + CLI (Module 02 §02.G) covers FIFO recalc; `computeWac` is compute-on-demand (no recalc needed); rest MISSING |
| 09.R | Bank accounts admin (name, routing, account #, type) — encrypted at rest | ❌ MISSING (no model; no service; no encrypted storage path) |

### (b) SERVICE LAYER

| Scope | File | Function(s) | Parameters | Completeness notes |
|---|---|---|---|---|
| 09.M | `src/server/services/settings.ts` | `getSetting<T>(db, key, valueSchema)`, `setSetting<T>(db, key, value, valueSchema, ctx?)`, `listSettings(db)` | `db: PrismaClient`, `key: string`, `valueSchema: z.ZodType<T>`, value, ctx | Generic key/value with per-key Zod validation. ON-DISK shape uses strings for Decimals (precision-safe JSON round-trip through Postgres). Audited writes with before/after. Refuses corrupted JSON loudly (no silent default). Does NOT: enforce permissions; bulk-import settings; surface per-key registry as a list endpoint (registry exists in `src/lib/validation/settings.ts` but is not exposed). |
| 09.P | `src/lib/validation/settings.ts` | per-key Zod schemas + `SETTING_KEYS` constants + `settingValueSchemas` Map | n/a | Currently 2 keys: `RESTOCKING_FEE_DEFAULT`, `NEGATIVE_INVENTORY_ALLOWED`. Header comment explicitly notes "later admin settings (late_fee_default, ar_hold_default, etc.) get added here as they ship." |
| 09.H schema | (Module 01) | `audit()` helper | (covered) | Schema fields match spec exactly: `userId, action, entityType, entityId, beforeJson, afterJson, reason, ipAddress, createdAt`. Action enum has 16 values incl. SENSITIVE_READ, INSUFFICIENT_STOCK_AT_CLOSE, INVOICE_GENERATED, PAYMENT_REVERSED, RMA_STATUS_CHANGE. Indexes match spec's expected query shapes (`(entityType, entityId, createdAt)`, `(userId, createdAt)`, `(action, createdAt)`, `createdAt`). |
| 09.I audit log read | ❌ MISSING | — | — | No `searchAuditLog(db, filters)` service. No `/api/audit-log` endpoint. No CSV export endpoint. The data is queryable directly via Prisma but there's no sanctioned search surface for the admin UI to call. |
| 09.K hard-delete | ❌ MISSING | — | — | No `getDependentRecords(entityType, entityId)` helper. No `hardDelete(db, entityType, id, reason, ctx?)` service. The soft-delete services in each domain refuse on dependents (Customer ← SO; SalesRep ← Customer; PaymentTerm ← Customer; CreditMemoCategory ← CM; GlAccount ← JEL), but the per-domain checks are bespoke and not aggregated into a "show me everything that references X" view. |
| 09.A/B/D/F/G auth + RBAC + users | ❌ MISSING | — | — | (Module 01 finding: no BetterAuth; no User / Role / Permission / Session schema; no login/logout/signup; no password hashing; no `requirePermission`.) |
| 09.E 2FA | DEFERRED | — | — | Per `docs/10` pilot deferral list. |
| 09.Q system health | partial | (covered in Module 02) | n/a | `backfillFifoLayers(db, opts)` exists with structured result + CLI (`npm run backfill-fifo-layers`). `computeWac` is read-only on-demand (no cache → no recalc concept). `recomputeOnHand`, `recomputeReservedForBin`, `recomputeQtyReceivedForPoLine`, `recomputeAmountPaidForInvoice` exist as internal self-heal helpers but are not surfaced as admin actions. NO: GL-balance-recalc, orphan detection, Shopify re-sync, integration test panel, backup status, Inngest queue viewer. |
| 09.L per-domain settings CRUDs | partial | various | — | Per-domain services that double as admin Settings: `glAccounts.ts` (Module 08), `paymentTerms.ts` (Module 03), `salesReps.ts` (Module 03), `customerCategories.ts` (Module 03), `creditMemoCategories.ts` (Module 06), `warehouse.ts` (Module 02), `restockingFee.ts` (Module 06). Spec items NOT covered: bank accounts; tax rates; late payment %; shipping methods; handling fee tiers; reorder points (depends on Module 02 schema gap); product categories (free-text only on Product); brands; expense categories; commission rates (SalesRep has the fields, no admin %-config service); company info (logo, address, phone, email, website); fiscal year. |
| 09.R bank accounts | ❌ MISSING | — | — | No `BankAccount` model. No service. The `customerDocuments` encryption pattern (AES-256-GCM via `lib/crypto` + redactForAudit + audited cleartext read with SENSITIVE_READ) is the template that should apply when this lands. |

### (c) SCHEMA

Models supporting Module 09:

- ✅ `AuditLog` (Module 01) — full spec match.
- ✅ `Setting` — generic key/value/JSON.
- ✅ `Sequence` (Module 01) — used cross-cutting.

❌ Missing entirely:
- `User`, `Role`, `Permission`, `RolePermission`, `UserRole`, `Session`, `Account`, `VerificationToken` — the entire BetterAuth schema set
- `BankAccount` (with encrypted routing/account fields)
- `LoginAttempt` / `Device` / `IpFingerprint` — needed for 2FA-on-unrecognized trigger
- `EmailTemplate`, `DocumentTemplate` — DEFERRED
- `HandlingFeeTier` — needed for shipping/handling at pack stage
- `TaxRate` — sales tax tracking
- `Brand`, `ProductCategory` (admin-managed list rather than free-text on Product) — currently free-text fields on Product

### (d) TEST COVERAGE

| File | Tests | Covers |
|---|---|---|
| `tests/integration/settings.test.ts` | 6 | `getSetting` / `setSetting` / `listSettings`; per-key Zod validation; corrupted JSON throws; audit row written on set |

Indirect coverage (already counted in their own modules):
- `restockingFee.test.ts` (12) — per-key wrapper service + admin endpoint
- `negativeInventoryAllowed.test.ts` (3) — per-key wrapper
- `customers.documents.test.ts` (12) — encryption + SENSITIVE_READ pattern (the template for bank accounts)
- `glAccounts.test.ts` (9) — admin CRUD pattern

NOT covered (capability missing):
- Auth (login, logout, 2FA, password policy)
- RBAC (`requirePermission`, role CRUD, permission assignment)
- User CRUD
- Audit log search/filter/export
- Hard-delete with dependency cascade
- Bank accounts
- Most settings (10+ unimplemented keys)
- System health utilities (orphan detection, recalc GL balances, integration tests, etc.)

### (e) API LAYER

| Path | Verbs | Notes |
|---|---|---|
| `/api/settings/restocking-fee-default` | GET, PATCH | TODO permission; only one Setting endpoint |

Per-domain admin CRUDs that double as "settings" (covered in their own modules):
- `/api/gl-accounts/*` (Module 08)
- `/api/payment-terms/*` (Module 03)
- `/api/sales-reps/*` (Module 03)
- `/api/customer-categories/*`, `/api/customer-tags` (Module 03)
- `/api/credit-memo-categories/*` (Module 06)
- `/api/warehouses/*` (Module 02)

❌ No API for: users; roles; permissions; auth (login/logout/signup/2FA); audit log search; audit log export; hard-delete; bank accounts; most other settings (late fee / cost-change threshold / vendor min order / backorder expiration / 2FA enforcement / PDF storage strategy / fiscal year / company info / handling fee tiers / tax rates / brands / product categories admin / expense categories / shipping methods / reorder points); system health utilities.

### (f) MISSING / STUBBED

The biggest "everything is missing because Module 01 isn't built" module. Real gaps (counted against pilot):

- [ ] BetterAuth integration + `User` / `Role` / `Permission` / `RolePermission` / `UserRole` / `Session` / `Account` / `VerificationToken` schema (Module 01 master prereq; called out here for completeness)
- [ ] User CRUD service + API (`/api/users/*`, `/api/users/[id]/disable`, `/api/users/[id]/reset-password-flag`)
- [ ] Role CRUD + permission-checkbox assignment service + API
- [ ] `requirePermission()` library + permission constants taxonomy (collected from Modules 02–08 — see SUMMARY)
- [ ] Login / logout / signup / password-policy validator endpoints
- [ ] Audit log search service + `/api/audit-log` endpoint with filters (user, date, entity, action) + CSV export endpoint
- [ ] Hard-delete service (Super Admin only) — `getDependentRecords(entityType, id)` + `hardDelete(db, entityType, id, reason, ctx)` + dependency-cascade UI primitive
- [ ] BankAccount model + service + API + encrypted-at-rest storage (using `customerDocuments` pattern as template)
- [ ] Setting registry expansion — late_fee_default, ar_hold_default, cost_change_alert_threshold, vendor_min_order_warning_default, backorder_queue_expiration_days, two_fa_enforcement, pdf_storage_strategy, fiscal_year_start_month, company_info (logo, address, phone, email, website)
- [ ] HandlingFeeTier model + service (small/medium/large with per-tier dims and price)
- [ ] TaxRate model + service (sales tax tracking, by state)
- [ ] Brand + ProductCategory admin-managed lists (currently free-text on Product)
- [ ] Expense category admin (when AP non-PO bill workflow lands)
- [ ] Generic `Setting` CRUD HTTP surface (`/api/settings`, `/api/settings/[key]`) so the admin UI can iterate the registry
- [ ] System health admin endpoints — recalc FIFO (already CLI; needs `/api/admin/recalc-fifo`), recalc GL balances, orphan detection, integration test panel, Inngest queue viewer

Properly deferred (NOT counted against pilot):
- 2FA enforcement (per `docs/10` deferral list — IP-fingerprint trigger, email code, authenticator app)
- Document template editor (template phase)
- Email template editor (template phase)
- Re-sync from Shopify (integrations phase)
- Test integrations panel (integrations phase)
- Database backup status (DigitalOcean managed externally)
- Inngest queue viewer (Inngest dashboard handles externally)

### (g) PILOT-READY VERDICT

**❌ NOT STARTED** — same expectation as Module 01.

Module 09 is mostly admin UI surfaces for things that:
1. Don't have services yet (RBAC, period close from Module 08, bank accounts, most settings)
2. Have services but no admin-friendly read API (audit log search)
3. Are deferred to template phase (document templates, email templates)
4. Are managed externally for pilot (database backup, Inngest queue)

The generic `Setting` service is well-shaped and is the foundation any tenant-wide config will sit on. The per-key Zod registry is the right design — adding a new setting is "define the schema, add the constant, expose it." Six new keys are immediately addable for pilot: `late_fee_default`, `ar_hold_default`, `cost_change_alert_threshold`, `vendor_min_order_warning_default`, `backorder_queue_expiration_days`, `pdf_storage_strategy`. Each is a 30-line slice.

Audit log is the most complete piece — schema is full-spec match, helper is in use across every audited mutation in the codebase. What's missing is the **read** path for the admin UI: a filtered search endpoint with CSV export. Roughly the same shape as `agingSummary` (filter + paginate + export).

### (h) PERMISSION GATING

Module 09 IS the home of permission gating. It's also the most permission-gated module by spec — every action listed (user CRUD, role CRUD, permission edit, audit log read, hard-delete, settings edit, COA edit, system health utilities) is Super-Admin-only or close to it.

The permission constants taxonomy collected across Modules 02–08 (which I'll consolidate into the SUMMARY) is the canonical list this module's `requirePermission` helper will consume. When Module 01's auth + RBAC slice lands, Module 09's UI is the consumer.

Highest-risk surfaces (when built):
- Hard-delete — irreversible; reason required; dependency check must run server-side
- Setting writes for business-logic-affecting keys (negative inventory toggle, late fee on/off, AR threshold) — flip operational behavior tenant-wide; should require `admin.write_settings` plus optional reason for high-impact keys
- Audit log export — reading high-volume sensitive data; should require `admin.read_audit_log` separately from any other "read all" gate
- Recalc utilities — modify computed counters tenant-wide; should require `admin.system_health` plus reason for the trigger
- User CRUD + role assignment — escalation of privilege risk; should require `admin.write_users` and the actor's role can never assign permissions the actor doesn't already have
