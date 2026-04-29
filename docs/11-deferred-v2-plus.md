# 11 — Deferred to v2+

These features were discussed during discovery but explicitly deferred. They should be designed against without breaking architectural assumptions, but not built in v1.

## Inventory & products
- **Bin / aisle / shelf location tracking** within warehouses
- **Lot / batch tracking on pick / invoice** (traceability for kratom recalls; expiration date FIFO)
- **Pack hierarchy** (display / master / pallet) — needed for second-pilot company, not Naked Kratom
- **Build / assembly module** — verify if Naked Kratom needs; otherwise post-pilot
- **Multi-warehouse / stock transfers** — single warehouse for Naked Kratom
- **Vendor product mapping table** (vendor SKU ↔ internal SKU)
- **Multi-vendor primary/secondary** with auto-failover

## Pricing
- **Quantity break pricing** (verify if needed for Naked Kratom)
- **Cost-plus pricing** (verify if needed for Naked Kratom)

## Vendors & purchasing
- **Required vendor documents** (W-9, COI, MAP policy enforcement)
- **1099 tracking and 1099-NEC report**
- **ACH / wire / check automation** (currently manual logging only)
- **Vendor MOQ enforcement** (currently warning-only via per-vendor minimum)
- **Lead time tracking**
- **Drop-ship module** — not needed for Naked Kratom; required for other companies
- **Vendor portal advanced features** beyond CSV import + order management

## AR / AP
- **Full expense module** (categorized expenses, approval workflow, receipt attachment)
- **Employee reimbursements**
- **Payroll module**
- **Bank reconciliation** (matching payments to bank statements)
- **Recurring bill templates**
- **3-way match enforcement** (currently warning-only)
- **Auto-apply vendor credits**
- **Early payment discount tracking** (2/10 Net 30)

## Integrations
- **ShipStation integration** — defer for Naked Kratom pilot, manual labels initially
- **SpeeD Ship integration** — for companies that use it
- **QuickBooks Online integration** — for companies that want downstream accounting
- **QuickBooks Desktop integration** — for companies that want downstream accounting
- **Bank API integrations** (for ACH initiation)
- **Avalara / TaxJar** — sales tax engine if business model changes
- **Address validation services** (Smarty, Google Places)

## Customer features
- **Customer portal** — defer for Naked Kratom; required for B2B at scale
- **Auto-pay enrollment** — nice-to-have

## Reporting
- **Custom report builder** — canned reports only in pilot
- **Report scheduling** (auto-email reports daily/weekly/monthly)
- **Budget vs. actual** reporting
- **Multi-currency** reports

## Other
- **Multi-currency** support (USD only in v1; schema designed to add later)
- **Time tracking / project management** (out of scope)
- **CRM module** (lead tracking, sales pipeline)
- **Advanced 2FA enforcement** (basic auto-on-new-IP only in v1)

## Pilot-specific deferrals (for Naked Kratom only)

These are deferred for the **first pilot only** but built in v1 for full release:

- ShipStation integration
- Customer portal
- Vendor portal
- Drop-ship module
- Pack hierarchy
- Multi-warehouse
- Quantity break / cost-plus pricing
- Lot / batch tracking

Add these post-pilot, before migrating second company.

## Architectural notes for v2+

Even though these are deferred, the v1 schema and code should not preclude them:

- Currency field nullable on transactions (multi-currency ready)
- Warehouse foreign key on inventory always present (multi-warehouse ready)
- Lot number nullable on inventory layers (lot tracking ready)
- Vendor ID on every line item (drop-ship ready)
- PDF storage path nullable (pure regen-on-demand fallback works)
- Permission system extensible (new permissions add without migration)
- Document template engine accepts arbitrary new templates
