# 05 — Module 4: Sales Orders

## Order sources

- Staff-entered (via UI)
- Customer Portal
- Shopify (B2C and B2B both flow in)

## Order numbering

- Auto-generated unique number per order
- Invoice number = SO number (same number, different document type)
- For split orders (drop-ship), child invoice numbers = `{SO}-1`, `{SO}-2`, etc.

## Order statuses

```
Draft → Confirmed → Dispatched → Closed
                          ↓
                      Cancelled (from any pre-Closed state)
```

**No "On Hold" status.** No formal pick/pack/invoice/payment statuses — those are flags/timestamps, not statuses.

### Status definitions

| Status | Meaning |
|--------|---------|
| Draft | Being entered or the result of a portal/Shopify push pre-confirmation. Not yet committed. |
| Confirmed | Customer confirmed (no need to follow up). Inventory commits (Available → Reserved). |
| Dispatched | Warehouse has started working. Pick sheet generated. |
| Closed | Shipped, invoiced, payment captured. **Inventory deducts** (On Hand decreases). |
| Cancelled | Cancelled at any pre-Closed stage. |

### Inside Dispatched (flags/timestamps, not statuses)
- `picked_at`
- `packed_at`
- `shipping_calculated_at`
- `invoice_generated_at`
- `payment_captured_at`

These drive worklists and dashboards, not filterable statuses.

## Inventory commit timing

- **At Confirmed:** Available decreases, Reserved increases
- **At Closed:** On Hand decreases, Reserved decreases (stock physically leaves)
- **Drop-ship lines:** no inventory effect at any stage

### Pickup orders skip Dispatched

Customer-pickup orders go directly `CONFIRMED → CLOSED` without passing through
`DISPATCHED` (no warehouse pick/pack cycle is needed — the customer takes the
goods at the counter). The close path treats the two source statuses
identically: it consumes inventory and zeroes out reservations the same way.
`DISPATCHED` is reserved for orders that go through the pick/pack workflow.

## Auto-split at Confirmed (drop-ship)

When an order has mixed your-stock + drop-ship lines:
1. Order created → status Draft
2. User confirms → status Confirmed
3. **Auto-split fires:** drop-ship lines extracted into separate per-vendor child orders
4. Original order keeps only your-stock items
5. Each child order proceeds independently
6. Customer portal shows them as separate orders

## Order entry

### Required fields
- Customer (drives default sales rep, ship-to, billing, payment terms)
- Sales rep (auto-fill from customer, editable)
- Source warehouse (default to one, editable)
- Ship-to (default from customer, editable)

### Optional fields
- Bill-to (defaults to customer billing)
- Order date (auto-stamped)
- Promised ship date
- Customer PO number
- Order-level notes (customer-facing)
- Order-level discount

### Line entry
- Type SKU directly with autocomplete
- (Future: barcode scan, CSV import for bulk, search by name/category, re-order helper)

### Line item fields

| Field | Notes |
|-------|-------|
| Product (SKU) | Type-ahead autocomplete |
| Quantity | Integer or decimal |
| Pack level | Unit / display / master / pallet (if pack hierarchy enabled) |
| Unit price | Auto-resolved by pricing engine |
| Discount | Either % or fixed price override |
| Line note | Prints on customer paperwork |
| Internal note | Staff-only |
| Warehouse (source) | Defaults to order source warehouse, editable per line |

### Real-time inventory display on line entry
For source warehouse, show:
- Quantity On Hand
- Quantity Available

Negative inventory allowed; warning indicator only.

## Pricing on order

### Pricing resolver
Same as in Module 1 (Products & Inventory):
1. Active promo (date-bound)
2. Customer-specific product price
3. Quantity break price
4. Customer blanket tier discount
5. Cost-plus (snapshotted at order entry)
6. Base price

System runs all applicable, picks **lowest**, logs which rule fired.

### Quantity breaks auto-apply
- When qty crosses threshold (up or down), price auto-recalculates
- Same logic in customer portal cart

### Manual price override on line
- **No special manager approval** required (no below-cost block)
- Override always logged for audit
- % discount or fixed price override

### Order-level discount
- Separate from line discounts
- % off OR $ off order subtotal
- Applies before shipping/handling
- No special approval

## Shipping & handling

### Calculation timing
At pack stage (post-pick), warehouse enters per-box dimensions and weight. ShipStation/SpeeD Ship API calculates rate at that point.

### Per-box data
| Field |
|-------|
| Length (in) |
| Width (in) |
| Height (in) |
| Weight (lbs) |
| Tracking number |

Multiple boxes per order supported, each with own tracking number.

### Carriers
- ShipStation (multi-carrier)
- SpeeD Ship (custom API)
- LTL/freight for pallets (manual)
- Customer pickup
- Customer's own carrier account (3rd party billing)

### Shipping cost model
- **Pass carrier shipping at cost** (no markup)
- **Plus handling fee** based on box size (configurable in admin)
- Default tiers: small box $4, medium $5, large $8 (you define dimensions per tier)
- Customer invoice shows two separate lines: "Shipping" and "Handling"

### Dimensional weight
Carriers charge based on actual or dimensional weight, whichever is higher. Dimensional weight = `(L × W × H) / DIM_DIVISOR` (typically 139 for domestic). Critical because products are not dense.

## Special workflows

### Duplicate order
- "Duplicate" button on any order
- Copies all lines + prices + discounts as-is
- New SO number, status Draft, dates and shipping reset
- User can edit before confirming

### Split by vendor
- **Manual button** after sales rep reviews and confirms
- Creates linked child orders (one per vendor)
- Each child has its own SO number, references parent
- Inventory commits adjust to children
- Customer portal shows children as separate orders

### Multi-warehouse fulfillment
When order needs items from multiple warehouses:
- Default behavior: reject + offer split
- "Insufficient stock in WH-A. Available: WH-A: 60, WH-B: 60. Split this order? [Yes / No / Pick warehouse]"
- If yes → creates linked sub-orders, one per warehouse
- Each sub-order has independent pick/pack/ship/invoice cycle
- Customer view = separate orders

### Combine orders
**Not supported.** Skipped.

### Quote concept
**No separate model.** Draft IS the quote.

## Edit rules

- Editable in any status **except** system-generated fields
- System-generated (read-only): cost, applied payments
- All edits logged with user + timestamp + before/after

## Cancellation

- Allowed at any status, any reason, logged
- Post-Confirmed cancellation: inventory un-commits (Reserved → Available)
- Post-Closed cancellation: inventory un-deducts (back to On Hand) — confirmation prompt; usually should be RMA instead

## RMA / Returns

Separate module — see Module 5 (Invoicing & AR).

## Documents

### Templates
Match field structure of existing documents (samples provided), modernize visual design. Unified template engine: shared base components (logo, header, table, footer), document-specific overrides.

### Sales Order PDF
- Customer info, ship-to, bill-to
- Lines: photo, item description, SKU, qty, unit price, total
- Customer-facing notes (order-level)
- Terms
- Subtotal, discounts, shipping, grand total, credits, payments, balance due
- Special notes & instructions

### Pick Sheet
- Generated at Dispatched
- Lines grouped by SKU/product name (bin/aisle later)
- Stock context line under SKU: `Qty On Hand / Qty Available`
- Internal customer notes (sticky from customer record)
- **No prices**
- Checkboxes: QTY Picked, "Packed By" column for accountability
- Page 2: box dimensions table (Box # / L × W × H / Weight)
- Picked by + Packed by signature lines

### Packing Slip
- Goes in the box
- Lines + qty
- **No prices** (B2B convention; protects pricing from third parties)
- Customer notes
- Tracking number

### Invoice
- Generated at Closed
- Same as SO PDF format with addition: shipping cost, date shipped
- See Module 5 for invoicing details

### PDF storage strategy
**Hybrid model:**
- On first email/send → render and **store permanently** (immutable legal record)
- Internal staff viewing → renders fresh from current data
- Customer portal download → serves stored PDF
- Re-emails → serves stored PDF

## Reports

- Sales by customer (detail + summary)
- Sales by item (detail + summary)
- Sales by sales rep (detail + summary)
- Sales by warehouse (detail + summary)
- Sales by category (detail + summary)
- Top sales by product / brand / vendor
- Profit margin by product / customer / sales rep
- Average order value by customer / sales rep / brand
- Customer lifetime value
- Open orders by status
- Orders awaiting pick / pack / invoice
