# 04 — Module 3: Vendors & Purchasing

## Vendor types

- **Stock vendor** — you buy, receive, then sell
- **Drop-ship vendor** — commission model (see below)
- **Service vendor** — utilities, freight carriers, software, etc. (AP only, no products)

A vendor can be both stock and drop-ship in theory (rare; "hasn't happened yet"). When it does, AP balance and AR balance are tracked separately, no netting.

## Vendor master

- Vendor ID auto-generated
- Standard contact info
- Multiple payment method records: ACH, wire, check, credit card, bank routing/account info — encrypted at rest
- Payment terms: Net 30, COD, Prepay, 50% deposit (configurable list)
- No required documents on file (deferred)
- 1099 tracking deferred to v2+

## Vendor contacts

- Multiple per vendor with roles (free-text)

## Vendor product catalog

Per vendor-product relationship, track:
- Vendor SKU (we mostly use vendor's SKU directly)
- Latest cost
- WAC (current calculated)
- MOQ (deferred — nice-to-have)
- Lead time (deferred — nice-to-have)
- Vendor's pack size

**Multi-vendor for one product:** rare. Handled case-by-case to designate primary. Current ERP errors on collision; new ERP should allow with explicit primary flag.

**One-off purchases:** PO can include a product not in any vendor's catalog (just name + cost). Checkbox: "add this to vendor's catalog after receipt" if recurring.

## Cost change handling

- Vendor sends cost update (via feed or manual entry) → **auto-accept**
- If change exceeds threshold (admin-configurable %, e.g., 10%) → flash notification in "cost change alerts" inbox
- Does not block; informational only

## Purchase orders

### PO statuses
`Draft → Confirmed → Dispatched/Shipped → Closed (Received) → Cancelled`

Plus interim state: `Partially Received` when receiving in multiple shipments.

### PO numbering
Auto-generated. Format TBD during build (e.g., `PO-2026-00001`).

### PO line fields
- Product (linked SKU)
- Vendor SKU
- Manufacturer part number
- Qty (in vendor pack unit, e.g., "2 master cases")
- Unit cost
- Expected receive date
- Destination warehouse (per line — multi-warehouse PO supported)
- Line notes

### Multi-warehouse on one PO
- Lines can be assigned to different warehouses
- Bulk-edit toggle: "set all lines to warehouse X"

### PO approval
- No threshold-based approval required
- Any user with "create PO" permission can send

### Auto-suggest POs from low stock
- Feature exists, **off by default**
- Configurable: triggered by reorder point + sales velocity
- Generates draft POs for review

### PO from SO push
**Not supported.** Not part of workflow.

## Receiving

### Multi-PO receipt model (KEY ARCHITECTURAL DECISION)

**Decouple PO ↔ Receipt ↔ Bill into three independent records linked many-to-many.**

This solves the common problem of: vendor ships one shipment containing items from multiple POs, and sends one invoice covering it all.

**Flow:**
1. Issue POs (PO-100, PO-101, PO-102)
2. Vendor ships one box with items from all three POs + one invoice
3. **Receiving** creates one Receipt record. Each line says "5 units of SKU X (from PO-100)" + "10 units of SKU Y (from PO-102)"
4. **Billing** creates one Bill record. Pulls lines from Receipt(s). Cross-references vendor's invoice number → confirms.
5. Bill spans PO-100, PO-101, PO-102. Each PO knows how much has been received and billed.

**Benefits:**
- Matches reality (one shipment = one receipt; one invoice = one bill)
- POs stay clean (each knows its received and billed quantities)
- Landed cost allocates per receipt, not per PO

### Partial receiving
- **Allowed and is the norm** (most shipments are partial)
- Each receipt records: qty received (could be less than ordered), actual unit cost (may differ from PO), receive date, destination warehouse
- Updates inventory immediately
- Creates FIFO layer at actual received cost

### Over/under receiving
- **Allowed with warning**
- No block (configurable per vendor in v2+)

### Damaged on receipt
- Receive partial + reject damaged
- Triggers **vendor credit memo workflow** (see Module 6)
- Damaged units logged separately for vendor performance reporting

## Landed cost

### At receipt time
Inputs: freight, customs, handling.

Allocation methods:
- By unit count (split evenly)
- By weight (if products have weight on file)
- By value (proportional to extended cost)
- By box count (e.g., "12 boxes at $48/box" → split across units in those boxes)

Allocated cost bakes into FIFO layer cost + WAC immediately.

### Late landed cost
- Freight bill arrives weeks after goods (covers multiple POs / one shipment)
- Allowed: enter freight bill, link to receipt(s), allocate across all units in shipment
- **Retroactive recalculation** of FIFO layers
- COGS adjustment for already-sold units (see costing rules in Module 7)

### Customs / duty
Same flow as freight.

## Vendor feeds

### Inventory data sources
- **Primary:** Shopify (vendors push to Shopify via Matrixify; ERP reads from Shopify)
- **Secondary:** Manual CSV/Excel/PDF upload for non-Matrixify vendors
- **Mapping wizard:** column → field mapping per vendor, save mapping for future imports

### Low inventory
When stock drops below threshold → auto-mark "low inventory" on Shopify (no ERP-side action required since Shopify is the storefront).

## Drop-ship vendor architecture (KEY ARCHITECTURAL DECISION)

### Business model

**Not traditional drop-ship.** Vendors collect payment from customer directly, ship the product, and pay you a commission on gross sales.

- You don't pay vendors for goods (no AP)
- Vendor charges customer's card on their own merchant account
- You earn a commission on each sale → **AR from vendor** (Commission Receivable)
- You handle customer relationship and communication
- You don't track cost on drop-ship products

### Order splitting
- Customer places order with mixed items (yours + drop-ship from 1+ vendors)
- ERP **automatically splits** at Confirmed status:
  - Your-stock items → main order
  - Each vendor's drop-ship items → separate per-vendor order
- Splitting based on each product's `vendor_id` (synced from Shopify)
- Customer sees **separate orders** in portal (one per vendor + your stock)

### PCI compliance — manual phone handoff
- We do **NOT** store or transmit credit card data to vendors via the system
- Drop-ship vendor portal shows: order details, customer info, ship-to, products, qty, commission rate
- Portal placeholder: "Customer payment: contact [staff] at [phone] to receive payment details"
- Optional "Request Payment Info" button → pings team via Slack/email
- System logs when payment info was requested + when vendor confirmed they charged it (manual checkbox)

### Vendor fulfillment flow
1. Drop-ship order routed to vendor portal
2. Vendor calls staff for credit card details
3. Vendor charges customer on their own merchant account
4. Vendor ships → uploads tracking
5. ERP marks line shipped, customer gets email notification
6. **Commission accrues** based on (gross sale × commission rate)

### Commission rate model
- Default rate set on vendor record
- Optional per-category overrides (vendor → category → rate)
- Optional per-product overrides (vendor → product → rate)
- Resolver: product → category → vendor default

### Per-vendor minimum order
- New field on vendor record: `minimum_order_amount` (nullable)
- Order entry checks vendor minimum on drop-ship lines
- Below minimum → **warning flash**: "Vendor [X] minimum order is $250. Current: $187.50."
- Warning, not block; manager override permission can suppress
- Surfaces in customer portal cart too: "Add $62.50 more from [vendor] to meet minimum"
- Helper: "products from this vendor" filter to add more

### Commission accounting

**GL accounts created per drop-ship vendor:**
- `Commission Revenue` (income, single account)
- `Commission Receivable - [Vendor]` (asset, sub-account per vendor)
- `Late Fee Revenue` (income, optional)

**JE on vendor-confirmed shipment:**
```
DR Commission Receivable - [Vendor]
CR Commission Revenue
(amount = gross_sale × commission_rate)
```

**JE on vendor commission payment received:**
```
DR Cash
CR Commission Receivable - [Vendor]
```

### Commission collection schedule
- Vendors remit commissions **monthly on the 1st**
- Late after the **5th**
- Late fee: 5–10% of balance (configurable per vendor agreement)
- Currently no late fees applied — feature available but off by default

### Drop-ship vendor as "shadow customer"

For AR purposes, drop-ship vendors are also created as a **shadow customer** record:
- Linked to the vendor record (system-managed link)
- Flagged `system_generated`
- Monthly: system creates commission invoice on shadow customer
- Invoice flows through normal AR (aging, statements, payment receipt, late fees, dispute)
- Drop-ship vendor portal access shows two views:
  - **Vendor portal:** manage products, see drop-ship orders
  - **AR portal:** pay commission invoice

### Mixed vendors
If a vendor is both stock AND drop-ship:
- Vendor record handles AP for stock products
- Shadow customer record handles AR for drop-ship commissions
- No netting — they pay AR balance, you pay AP balance separately

## Vendor portal

### Capabilities (minimum useful set)

| Feature | Notes |
|---------|-------|
| CSV import for product catalog | Manage prices, stock, status, title, image URLs |
| View open POs / drop-ship orders | Filterable list |
| Confirm POs and provide ETA | Updates PO status |
| Mark order shipped | Triggers customer notification + commission accrual |
| Upload tracking | Per shipment |
| Request payment info workflow | Manual phone handoff (no card data in system) |
| Active/draft toggle on products | Self-managed |
| Commission report | What they owe you, statement view, payment history |
| Pay commission invoice | Via shadow customer AR portal |

## Reports (purchasing)

- Purchases by vendor (period)
- Purchase price trend per product
- Vendor performance (on-time delivery, accuracy, price changes, damage rate)
- Open POs
- POs awaiting confirmation
- POs overdue (past expected receive date)

## Deferred to v2+

- Required vendor documents (W-9, COI, MAP)
- 1099 tracking and 1099-NEC report
- ACH/wire/check automation
- Vendor MOQ enforcement
- Lead time tracking
- Vendor product mapping table
- Multi-vendor primary/secondary failover
