# 09 — Module 8: Admin, Users, Roles, Permissions, Audit

## Permission model

### Two-tier structure

**Tier 1: Super Admin (1–2 people)**
- Full access to everything
- Create / edit / delete users
- Create / edit / delete custom roles
- Edit all system settings (bank accounts, GL, payment terms, shipping, document templates, etc.)
- Edit / delete any order, PO, bill, invoice (with audit trail)
- Recalculate inventory, FIFO, WAC, GL balances
- View full audit log
- Void / reverse any transaction
- Hard-delete records (when no dependents)

**Tier 2: Custom Roles**
- Defined by Super Admin
- Each role = a collection of permission checkboxes
- Examples:
  - **Sales Manager:** create orders, edit customer prices, approve large discounts, view AR reports, see commission reports
  - **Warehouse Manager:** receive POs, pick/pack orders, adjust inventory, view inventory reports
  - **Accountant:** enter bills, record payments, post manual JEs, view GL, run financial reports
  - **Sales Rep:** create orders, view own commission, view customer AR balance

### Permission categories (granular checkboxes)
- Customer: view all / view own / create / edit / delete
- Sales Order: create / edit (any status) / cancel / split / duplicate / change price / override credit limit
- Inventory: view / adjust / transfer (initiate) / transfer (receive)
- Vendor / PO: create / edit / receive / damage reject
- Bill / AP: create / confirm / void / record payment
- Invoice: send / void / refund / issue credit memo
- RMA: approve / reject / receive / inspect
- GL: view / post manual JE / soft close / hard close / reopen period
- Reports: view financial / view operational / build custom / schedule
- Admin: edit settings / edit COA / edit users / edit roles / view audit log

## User management

### Account fields
- Email (login)
- Full name
- Phone
- Title / job role
- Department
- Assigned warehouse (if applicable)
- Sales rep flag + commission tier (if applicable)
- Enabled / disabled
- Last login
- Force password reset on next login flag

### Multi-instance access
Each company instance is separate. One email = one login per company. Cross-company login is not supported.

## Authentication

### Login
- Email + password

### Two-factor authentication
- Triggered automatically when login from **unrecognized IP or device** (system fingerprints)
- Always-on 2FA can be enabled per user in account settings (default off)
- Super Admin can enforce 2FA globally via system setting
- Methods: email code (default), authenticator app (Google Authenticator, Authy) optional

### Password policy
- Minimum 8 characters
- Required: uppercase, lowercase, numbers, special characters
- No expiration
- No password history enforcement

### Session management
- No auto-logout

## Audit logging

### What's logged (sensitive actions only)
- Create
- Edit
- Delete (soft and hard)
- Status change
- Void
- Reverse
- Refund
- Permission change
- Configuration change
- Login / logout
- 2FA challenge result

### Each log entry contains
- Timestamp
- User
- Action type
- Entity (order / customer / product / etc.)
- Entity ID
- Before / after values
- IP address
- Reason (when required by action type)

### Retention
**Forever.** No purge.

### UI
- Searchable
- Filterable (user, date range, entity, action type)
- Exportable (CSV)
- Drill-down to specific record's full history

## Soft-delete and hard-delete

### Default: soft-delete
- All major entities support soft-delete (mark inactive/archived)
- Hidden from active lists by default
- Preserves history and referential integrity
- Available to permissioned users

### Hard-delete
- Available only to Super Admin
- Requires explicit confirmation + reason logged
- **Blocked when dependent records exist**
- System shows: "Cannot delete this [Customer]. There are 47 sales orders, 12 invoices, and 3 payments tied to this customer. Delete those first or use Soft-Delete instead."
- Super Admin sees clickable list of dependents

### Examples of dependency chains
- Customer ← Sales Orders ← Invoices ← Payments
- Product ← Inventory layers ← PO lines ← Sales Order lines
- Vendor ← POs ← Bills ← Payments
- User ← Created records (all their actions in audit log)

### Use case: glitched orders
- If no payment applied: Super Admin can hard-delete
- If payment exists: must void/reverse payment first, then delete
- System guides Super Admin through cascade

## Self-serve admin settings (no developer required)

Super Admin can edit without code changes:

| Category | Items |
|----------|-------|
| **Financial** | Bank accounts (name, routing, account #, type), GL accounts (add/edit/archive, account type), Payment terms, Tax rates / sales tax codes, Late payment % |
| **Operations** | Shipping methods, Warehouse locations, Handling fee tiers (small/medium/large with dimensions), Reorder points per product |
| **Catalog** | Product categories, Brands |
| **AR / AP** | Credit memo categories, RMA categories, Expense categories |
| **People** | Commission rates (vendor + sales rep), Users (create/edit/disable), Roles (create/edit, assign permissions) |
| **Documents** | Document templates: customize text, logo, **add/remove/hide columns** |
| **Communications** | Email templates: customize message, **add/remove/hide columns** |
| **Company** | Logo, address, phone, email, website |
| **Fiscal** | Fiscal year start, AR threshold (days past due), Negative inventory allow/block flag |

### Document template editor
- Visual editor with live preview
- Edit text labels (e.g., change "Sales Rep" to "Account Manager")
- Add/remove/hide columns in tables
- Logo upload
- Color scheme (within limits — fixed structure, customizable styling)
- Footer text and branding

### Email template editor
- Same approach as document templates
- Variables / merge fields available (e.g., `{{customer.name}}`, `{{invoice.balance}}`)

## Configuration values that affect business logic

| Setting | Default | Notes |
|---------|---------|-------|
| Negative inventory | Allow with warning | Configurable to block (per warehouse or per product) |
| AR hold threshold (days past due) | Off (per customer) | Configurable per customer |
| Late payment fee | Off (% of balance) | Configurable in admin |
| Restocking fee | None | % or flat rate, default + per-RMA override |
| Quantity break auto-apply | On | Auto-recalculates price when threshold crossed |
| Cost change alert threshold | 10% | Above this, flash alert |
| Vendor minimum order warning | Off | Per vendor |
| Backorder queue expiration | 90 days | Auto-dismiss after this |
| 2FA enforcement | Off (auto on new IP only) | Can be globally enforced |
| Document PDF storage | Hybrid (store on first send) | Permanent storage of stored copies |

## System health / utilities (Super Admin only)

- Recalculate FIFO layers (for a date range or full)
- Recalculate WAC (per product or globally)
- Recalculate GL balances from JEs
- Verify referential integrity (orphan detection)
- Re-sync from Shopify (full or incremental)
- Test integrations (Authorize.Net, Mailgun, ShipStation, SpeeD Ship)
- Database backup status / restore
- View background job queue (Inngest)
