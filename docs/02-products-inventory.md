# 02 — Module 1: Products & Inventory

## Product types

| Type | Description | Inventory? | Cost tracking? |
|------|-------------|-----------|----------------|
| Simple | Standard physical good | Yes | FIFO + WAC |
| Assembled | Built in-house from components (BOM) | Yes (finished good has its own layer) | FIFO + WAC, cost rolls up from components |
| Bundle | Promo bundle of existing products at discounted price | No (explodes into components) | N/A — inventory deducts from each component |
| Drop-ship | Vendor ships direct to customer; commission model | No | No COGS, no inventory |
| Service / Non-inventory | Shipping fee, COD fee, handling, restocking, rush processing | No | No COGS |

## Pack hierarchy

Products with multi-level packaging (e.g., kratom tablets):
- **Base unit** → Display case → Master case → Pallet
- Each level has a defined conversion factor per product
- Inventory always stored internally at base-unit level (one source of truth)

**Display rule:** Show largest whole unit, with full breakdown on hover/expand.

| On-hand units | Display | Hover detail |
|---------------|---------|-------------|
| 1,440 | "1 pallet" | "= 1 pallet, 0 master, 0 display, 0 units" |
| 700 | "4 master cases + 88 units" | Full breakdown |

**Sellable levels** flagged per product. Receiving/selling at any flagged level converts to/from base units automatically.

**Per-document toggle** for whether customer paperwork shows pack-level ("1 master case") or base-unit level ("30 units"). Default: master-case on invoices, base-unit on pick sheets.

## Bundles

- Bundle SKU has its own SKU and bundle price
- On order entry, bundle "explodes" into component lines
- Bundle price allocated **proportionally** across components based on regular prices
- Each component records its own COGS at FIFO cost
- Customer paperwork shows bundle SKU header + component lines with allocated prices

**Example:** Bundle ABC for $120, components A=$100, B=$25, C=$25 (total $150 regular).
- Discount factor = 120/150 = 0.80
- Allocated: A=$80, B=$20, C=$20

## Assemblies (Build / Work Orders)

- BOM defined per assembled product: components + qty + optional labor cost
- Work Order: "build N units of finished SKU"
- On completion: components deduct at FIFO cost; finished good receives at rolled-up cost
- Build to stock OR build to order (both supported)
- Partial builds allowed (component shortage → build what's available, leave WO open)

## Variants

**Parent product + child variant model.** A `Product` is the grouping/display record (name, descriptions, brand, category, images, weight/dims, base price). Each sellable color/flavor/size is a `ProductVariant` row that belongs to a parent `Product`.

**Why this differs from the original spec.** The original spec called for a flat model where each color/flavor/size was its own top-level SKU joined only by a `variant_group` field. The implemented model uses a real parent/child relationship. Reasons:
- Catalog screens need a single product entry with its variants nested under it (matches Shopify's product/variant model — keeps sync simple).
- Shared marketing fields (name, long description, images, brand, category, weight, dims) live on the parent and aren't duplicated across every variant.
- Variant-specific fields (color, flavor, size, variant-level SKU, optional `variantGroup`) live on the child.

**Inventory and costing still operate at the variant level.** Each `ProductVariant` is its own SKU for stock purposes:
- `InventoryItem` is keyed on `(variantId, warehouseId)` — one onHand/reserved row per variant per warehouse.
- `InventoryMovement` (the ledger) records every receive/consume/adjust/transfer at the variant level.
- FIFO layers and WAC, when added, will also be keyed per variant per warehouse.
- Pricing resolver runs per variant.

**The parent `Product` is a grouping/display record only**, not an inventory or costing entity. Querying "stock of product X" means summing across the product's variants; stock of a specific SKU is a single variant lookup.

A simple product with no variant axes still has exactly one `ProductVariant` child (one-to-one in practice). This keeps a single code path for inventory/movements/pricing.

## Product attributes

Fields below split between **Product** (parent, grouping/display) and **Variant** (child, per-SKU). Where unmarked, the field lives on the parent.

| Field | Lives on | Purpose |
|-------|----------|---------|
| SKU | Variant | Primary identifier per sellable unit, follows vendor SKU when possible |
| Manufacturer part number | Variant | Vendor reference |
| Title / name | Product | Display |
| Variant name | Variant | Per-variant display label (e.g., "Red / 2oz") |
| Long description | Product | Detailed product info |
| Short description | Product | Card / list view |
| Brand | Product | Filter / category |
| Category | Product | Filter / hierarchy |
| Tags | Product | Free-form categorization |
| Images | Product | Multiple, primary flag (variant-specific images deferred) |
| Weight | Product | For shipping calc (variant-level override deferred) |
| Dimensions (L × W × H) | Product | For shipping calc + dimensional weight |
| Country of origin | Product | Customs / 1099 |
| HS code | Product | Customs |
| Hazmat flag | Product | Shipping restrictions |
| Color, flavor, size | Variant | Variant attributes |
| `variantGroup` | Variant | Optional grouping label for customer-facing surfaces |
| Production tag | Product | Free-text (e.g., "12-14 DAY PRODUCTION", "EXPRESS"); prints on docs |
| Vendor | Product | Primary vendor (single, with case-by-case multi-vendor handling) |
| Active / draft | Product + Variant | Each can be independently active; Shopify only flows `active` into ERP |

**SKU convention:** follow vendor's SKU. On collision, manually create unique SKU and contact vendor to flag.

## Pricing model

Each product has:
- **Base price** (list price)
- **Cost** (current WAC, displayed for reference)
- **Last cost** (last PO price, displayed for reference)

**Pricing resolver** (when adding line to order — runs all applicable rules and picks **lowest**):
1. Active promo (date-bound, customer or universal)
2. Customer-specific product price
3. Quantity break price (customer's tier)
4. Customer blanket tier discount (Master Distributor / Distributor / Preferred / Regular)
5. Cost-plus price (if customer is on cost-plus, uses current WAC at order entry, snapshotted)
6. Base price

System logs **which rule fired** on each line for audit. Quantity breaks **auto-apply** when threshold crossed mid-entry (in either direction).

## Inventory model

### Quantities tracked per product per warehouse

| Quantity | Definition |
|----------|-----------|
| On Hand | Physical stock present |
| Reserved / Committed | On open SOs (post-Confirmed status) |
| Available | On Hand − Reserved |
| On Order | On open POs not yet received |
| In Transit | Stock moving between warehouses (transfer in flight) |

### Negative inventory

**Allowed by default**, with warning indicator on screens. Configurable per-warehouse or per-product flag to **block** when ready to tighten ops.

### Lot / batch / expiration tracking

**Optional flag per product.** When enabled:
- Receiving requires lot number + optional expiration date
- FIFO becomes lot-FIFO (oldest expiration first, or oldest received first — configurable)
- Lot tracking on pick/invoice deferred (revisit at pick workflow design)

### Stock transfers (multi-warehouse only)

**Two-step workflow** (permission-controlled):
1. Authorized user creates transfer at WH-A → generates pick/check-in list → stock moves On Hand (A) → In Transit
2. WH-B counts received items against check-in list → marks received → stock moves In Transit → On Hand (B)

Only users with explicit "stock transfer" permission can initiate or complete.

### Stock context line on internal docs

Format: `Qty On Hand / Qty Available`
- Example: `15000 / 7500` = 15,000 on hand, 7,500 available (7,500 already committed)
- Example: `0 / -10000` = 0 on hand, 10,000 committed = deeply backordered

Prints on: pick sheets, check-in sheets, internal SO copy. **Never** on customer-facing invoices/packing slips.

## Costing engine

### FIFO layers

- Every receipt creates a layer: `(product, warehouse, qty, unit_cost, received_date, source_po_or_receipt)`
- Returns to inventory (RMA, after credit memo confirmed) → new layer at original sale's FIFO cost
- Inventory adjustments (breakage, loss) → consume from oldest layer first
- Stock transfers move layers between warehouses (preserving cost and date)
- Sales consume layers oldest-first, lock COGS at consumption

### Weighted Average Cost (WAC)

- Recalculated **per product per warehouse** after every inventory movement (in, out, adjustment, transfer, build)
- Stored as product's "current cost" — used for cost-plus pricing and reference display
- Formula: `WAC = total_layer_value / total_layer_qty`

### Landed cost

**At receipt time:** freight + customs + handling allocated across received units. Allocation methods:
- By unit count (split evenly)
- By weight (if products carry weight)
- By value (proportional to extended cost)
- By box count (e.g., "12 boxes at $48/box = $576" → split across units in those boxes)

Allocated landed cost bakes into FIFO layer cost + WAC.

**Late landed cost (freight/customs bill arrives weeks later):**
- Allowed
- **Retroactive to original sale date** (Option A) — updates FIFO layers, recalculates COGS for already-sold units, posts COGS adjustment dated to original sale period
- If period is **hard-closed**, system flags for manual review; accountant can either reopen period or post to current period

### Cost adjustments

- Vendor-billed cost differs from PO cost → **retroactively update FIFO layer cost**, recalculate COGS for already-sold units
- Manual cost adjustments allowed for breakage/loss/found stock — quantity changes, value changes, JE auto-generated
- Closed-period fallback: post offsetting JE to current period rather than retroactive

### Build/assembly costing

- Components consume FIFO from their layers
- Finished good's new layer cost = sum of consumed component costs + optional labor cost
- One build event = one new finished-good layer

## Drop-ship costing (special)

**Drop-ship is a commission model, not traditional drop-ship** (see Module 4 for full explanation):
- No inventory, no FIFO, no WAC
- No COGS
- Revenue = commission earned from vendor
- See `04-vendors-purchasing.md` for full architecture

## Reports (inventory)

- Inventory valuation (snapshot)
- Inventory aging (how long has stock been sitting)
- Stock movement (in/out by period)
- Reorder suggestions (based on reorder point + sales velocity)
- Slow-moving inventory
- Dead stock (no movement in X months)
- Inventory by warehouse
- Inventory in transit
- Inventory with most returns
- Inventory with most defects/damage

## Shopify integration rules

**Source of truth split:**

| Field | Master |
|-------|--------|
| Product name, description | Shopify |
| Images | Shopify |
| Marketing copy | Shopify |
| SKU, manufacturer part number | Shopify (creation) → ERP (canonical) |
| Inventory levels | ERP |
| Cost | ERP |
| Tier-specific pricing | ERP |
| Active/draft status | Shopify (only `active` syncs to ERP) |

**Sync mechanism:** Shopify webhooks for real-time updates + scheduled nightly reconciliation pull. ERP → Shopify inventory push on every inventory movement (debounced).

## Vendor feeds (drop-ship inventory)

- Primary path: vendor pushes to Shopify via Matrixify → ERP reads from Shopify
- Secondary path: manual CSV/Excel upload for non-Matrixify vendors with mapping wizard (column → field, save mapping per vendor)
- Auto-mark low inventory in Shopify when stock drops below threshold

## Deferred for v2+

- Bin/aisle/shelf location tracking
- Lot tracking on pick/invoice (with traceability for kratom recalls)
- Advanced expiration date FIFO
- Multi-vendor primary/secondary mapping with auto-failover
- Vendor product mapping table (vendor SKU ↔ internal SKU)
