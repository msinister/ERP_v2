# Custom ERP — Design Specification

This is the design specification for a custom multi-instance ERP system built to replace an existing legacy ERP. This document captures all architectural decisions, business rules, and feature scope agreed during discovery.

## Project goals

Replace the existing custom Python/Cisco ERP with a modern, modular system that:

- Supports multiple companies via single-codebase, multi-instance deployment (per-company database, per-company URL, shared codebase)
- Provides a modern UI and self-serve administration so configuration changes don't require a developer
- Includes customer self-serve features (portal for invoices, payments, ordering)
- Maintains rigorous accounting accuracy (double-entry GL, FIFO + WAC inventory costing)
- Integrates with Shopify, Authorize.Net (via Kaja), Mailgun, ShipStation, SpeeD Ship
- Hosted on DigitalOcean

## Pilot scope: Naked Kratom

First company to go live is **Naked Kratom** — small business with ~40 SKUs, few customers, low transaction volume, single warehouse, no drop-ship. Sells on Shopify with Authorize.Net via Kaja. No customer/vendor portal needed for pilot.

## Document structure

| Document | Contents |
|----------|----------|
| [01-foundation.md](docs/01-foundation.md) | Architecture, tech stack, deployment model |
| [02-products-inventory.md](docs/02-products-inventory.md) | Module 1: Product master, pack hierarchy, inventory, costing |
| [03-customers.md](docs/03-customers.md) | Module 2: Customer master, portal, pricing tiers |
| [04-vendors-purchasing.md](docs/04-vendors-purchasing.md) | Module 3: Vendor master, POs, drop-ship commission model |
| [05-sales-orders.md](docs/05-sales-orders.md) | Module 4: Sales order entry, lifecycle, special workflows |
| [06-invoicing-ar.md](docs/06-invoicing-ar.md) | Module 5: Invoicing, payments, credit memos, RMAs |
| [07-accounts-payable.md](docs/07-accounts-payable.md) | Module 6: Bills, payments, multi-PO receipts |
| [08-gl-costing-reporting.md](docs/08-gl-costing-reporting.md) | Module 7: Chart of accounts, automatic JE posting, financial reports |
| [09-admin.md](docs/09-admin.md) | Module 8: Users, roles, permissions, audit log, settings |
| [10-deployment-migration.md](docs/10-deployment-migration.md) | Module 9: Migration plan, deployment, document templates, build phasing |
| [11-deferred-v2-plus.md](docs/11-deferred-v2-plus.md) | Features deferred beyond v1 |
| [12-glossary.md](docs/12-glossary.md) | Accounting and ERP terminology reference |

## Status

Discovery complete. This document is the source of truth for the build. Update it as decisions evolve.

## How to use this with Claude Code

1. Place this entire `/docs` folder at the root of your repo
2. Reference it in your `CLAUDE.md` as required reading
3. When starting any module, point Claude at the relevant doc as primary context
4. When schema or behavior changes during build, update the relevant doc immediately
5. Use this as your spec when reviewing Claude's output ("does this match the doc?")
