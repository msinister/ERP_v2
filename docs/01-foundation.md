# 01 — Foundation: Architecture & Deployment

## Multi-instance architecture

**Model:** Single codebase, deployed per company. Each company gets:
- Its own database (PostgreSQL)
- Its own subdomain (e.g., `nakedkratom.yourerp.com`, `companyB.yourerp.com`)
- Its own file storage (DigitalOcean Spaces bucket)
- Its own user accounts (no cross-company login)

**Update path:** Push update once to codebase → deploy to all instances. Each instance migrates its own database independently.

**Provisioning:** Build a script that spins up a new company instance from scratch (DB creation, schema migration, seed data, domain config, storage bucket) in approximately one hour.

## Recommended tech stack

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Frontend | Next.js + TypeScript + Tailwind + shadcn/ui | Modern DX, Claude Code handles this stack very well |
| Backend | Next.js API routes (or NestJS if needs grow) | Co-located with frontend for solo dev simplicity |
| Database | PostgreSQL | DECIMAL precision required for sub-penny costs/prices |
| ORM | Prisma | Best schema-first DX, type-safe |
| Auth | BetterAuth or Clerk | RBAC + multi-tenant ready |
| Background jobs | Inngest | Webhook-friendly, durable, good DX |
| File storage | DigitalOcean Spaces (S3-compatible) | Same provider as compute, low latency |
| Email | Mailgun | Already using |
| Hosting | DigitalOcean App Platform | Managed, sufficient for 10-user scale |
| PDF generation | Puppeteer or react-pdf | HTML-to-PDF for documents |

**Estimated infra cost per company instance:** $50–100/month (App Platform + managed Postgres + Spaces).

## Money precision

- **DECIMAL(18, 5)** for unit cost and unit price (5 decimal places — supports thousandth of a penny)
- Line totals and grand totals **round to 2 decimals** for display and AR/AP purposes
- All math runs at full precision; rounding happens only at display/total level
- USD only in v1; schema includes nullable `currency` field for future multi-currency

## Industry context

Wholesale + retail of: smoke shop supplies, glass, kratom, THC-A supplements (legal). Mainly B2B with growing B2C. This affects:

- **Payment processing:** high-risk merchant category (Kaja + Authorize.Net). Payment layer must be abstracted behind an interface for portability.
- **Shipping carriers:** some carriers refuse this category — ShipStation handles broadly, SpeeD Ship for specific routes.
- **No age gating in v1:** wholesale-only customer portal, business license verified at onboarding.
- **State shipping restrictions:** handled upstream on the website, not in ERP.

## Cross-cutting requirements

### Audit logging
Every sensitive action (create, edit, delete, status change, void, reverse, refund, permission change, config change, login/logout) is logged with:
- Timestamp, user, action type, entity, entity ID, before/after values, IP address, reason (when required)

Retained forever. Searchable, filterable, exportable.

### Soft-delete by default
- All major entities support soft-delete (mark inactive/archived)
- Hard-delete only for Super Admin, only when no dependent records exist
- System checks referential integrity before allowing hard-delete

### Permissions
- Two-tier model: Super Admin (1-2 people, full access + role creation) + Custom Roles (managers, sales, warehouse, accountants, with permissions defined by Super Admin)
- All permissions are checkboxes assignable to roles
- Some operations always require manager override + reason (specific cases noted per module)

### Self-serve admin
Super Admin can edit without a developer:
- Bank accounts, GL accounts, payment terms, shipping methods, warehouses
- Product/credit memo/RMA/expense categories
- Commission rates (vendor + sales rep)
- Document templates (text, columns, logo, branding)
- Email templates
- Tax rates, handling fees, reorder points, late payment %
- Company info, fiscal year, AR thresholds, negative inventory flag
- User management, roles, permissions

### Authentication
- Email + password login
- 2FA triggered automatically on login from unrecognized IP/device
- 2FA can be enforced per-user or globally by Super Admin
- Methods: email code (default), authenticator app (optional)
- Password policy: minimum 8 chars, must include uppercase, lowercase, numbers, special chars
- No password expiration
- No auto-logout

## Build philosophy

**Build with Claude Code, not via Claude Code.** Feature-by-feature collaborative build:
- Review schema before commit
- Write tests for financial logic alongside code
- Refactor when assumptions surface
- Don't let Claude make schema decisions in isolation across modules

**Module build order** (estimated, solo with Claude Code):
1. Foundation (auth, RBAC, audit, multi-tenant infra) — 2-3 weeks
2. Products & Inventory — 3-4 weeks
3. Customers + Vendors — 2 weeks
4. Sales Orders + Invoicing/AR — 4 weeks
5. POs + Bills/AP — 3 weeks
6. GL/Costing engine + Reports — 3 weeks
7. Integrations (Shopify + Authorize.Net + Mailgun) — 3 weeks
8. Document/email templates + admin UI — 2 weeks
9. Migration tooling + Naked Kratom pilot — 4-6 weeks (incl. parallel run)

Realistic pilot launch: **2-3 months full-time, 4-6 months part-time**.

## Pilot vs. full v1 scope

For Naked Kratom pilot, the following can be **deferred** until after pilot is stable:
- ShipStation integration (manual labels for now)
- Customer portal
- Vendor portal
- Drop-ship module
- Pack hierarchy (40 SKUs are simple)
- Build/assembly module (verify if Naked Kratom needs this)
- Multi-warehouse / stock transfers
- Quantity break + cost-plus pricing
- Lot/batch + bin tracking
- Custom report builder
- Email scheduling

After pilot is stable on Naked Kratom, second pilot should be a more complex company before rolling out to all.
