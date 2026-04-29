# 03 — Module 2: Customers & Customer Portal

## Customer types

Single field with predefined values:
- Wholesale — Regular
- Wholesale — Preferred
- Wholesale — Distributor
- Wholesale — Master Distributor
- Retail

Type drives default pricing tier. CRM-style status (lead, prospect, blacklisted) belongs to a future CRM module, not customer master.

## Customer master

### Identification
- **Customer ID:** auto-generated unique number
- **Display name:** unique constraint enforced; convention is to add `(City)` suffix when collision (e.g., "Smoke Shop Plus (Dallas)")
- Phone, email may be duplicated (one owner with multiple stores)
- Duplicate detection helper at creation: suggests `Did you mean Smoke Shop Plus (Dallas)?`

### Required fields
- Customer ID (auto)
- Display name
- Customer type (drives tier)
- Sales rep assignment (required)
- Billing address
- Default ship-to address

### Documents stored on customer record
Uploaded files attached to record:
- Resale permit / business license (with optional expiration)
- EIN (encrypted at rest)
- For credit applications: driver's license + SSN (encrypted, audit-logged on access)
- Resale certificate (number + file, with optional expiration)

System surfaces "documents expiring in 30 days" on a dashboard widget. Does NOT block ordering on missing/expired docs.

### Status (operational, not CRM)
Active / Inactive flags only. Order blocking driven by AR hold rules, not customer status.

## Financial terms

### Payment terms (configurable list)
- Net 30
- COD
- Prepay
- 50% deposit
- Pay on shipping
- Bill later (Net 30)

Terms are admin-editable in settings.

### Credit limit
- Per-customer field (nullable = no limit)
- On order entry: check `(current AR balance + open SOs not invoiced + this new order) ≤ credit_limit`
- If exceeded: block order; manager override required (permission + reason logged)

### AR hold
- Per-customer threshold: "block new orders when AR > X days past due"
- Default off
- X is configurable per customer
- Manager override allowed with reason logged

### Tax-exempt
- Default ON for wholesale customers
- Default OFF for retail
- Resale cert number stored on customer
- Wholesale customers handle their own sales tax; ERP is reporting-only
- Sales tax actually only collected by Shopify on retail (handled upstream)

## Pricing assignment

### Customer-level
- One **tier** per customer (Master Distributor / Distributor / Preferred / Regular / Cost-Plus)
- One **blanket discount %** if applicable (per tier or custom)

### Customer-specific overrides
- Unlimited per-product price overrides on customer
- Manual one-at-a-time entry
- CSV import for bulk

### Cost-plus
- Customer flagged cost-plus → orders priced as `current_WAC × (1 + plus_pct)`
- Snapshotted at order entry time (future cost changes don't retroactively affect order)

## Stored payment methods

- Tokenized via Authorize.Net Customer Information Manager (CIM)
- ERP never stores raw card numbers (PCI scope minimal)
- No hard limit on number of cards per customer
- Customer marks one as "preferred"
- System tracks card expiration → surface "card expiring in 30 days" to staff and portal user
- Customer can manage cards (add/remove/preferred) from portal

## Contacts

- Unlimited per customer
- Fields: name, role, email, phone, mobile
- Roles: Owner, Buyer, AP, AR, Manager, Shipping (free-text + suggestions)

## Addresses

- One billing address (default)
- Multiple shipping addresses (default ship-to + others)
- One-time ship-to addresses allowed (not saved)
- Address validation via Smarty / Google Places (configurable, can defer)

## Sales rep & commissions

### Assignment
- Each customer assigned to one sales rep (required)
- Rep visibility: see own customers by default; permission grants broader access

### Commission structure
- Per-rep configurable rate, OR group-level rate with reps assigned to groups
- Commission **basis:** revenue OR margin (revenue − COGS)
- Commission **rate:** percentage
- Group rate applies unless rep has a specific override

### Commission earning
- Earned **on payment received**, not on invoice
- Partial payments → proportional commission accrual
- Margin-based commission uses **COGS at order close** (FIFO-snapshotted)
- Refunds/credits reverse proportional commission
- Drop-ship commission: rep earns % of **your earned commission**, not gross sale

### Commission report
Filterable per rep, date range. Columns:
- Earned (paid invoices)
- Pending (open invoices)
- Reversed (refunds)
- Net for period

## Tags & categorization

- **Pre-made categories** (admin-managed list — e.g., "Trade Show Lead", "Glass-Only Buyer", "Texas Wholesale", "Kratom Buyer")
- **Free-form tags** (sales reps add on the fly, autocomplete from existing)
- Both filterable in customer search and reports

## Notes

- **Customer-level fixed notes** (sticky): internal-only; prints on every internal document for that customer (pick sheets, internal SO copy)
- **Order-level notes**: prints on customer-facing documents (invoice, packing slip, SO)
- **Activity log** (auto): user + timestamp + action ("changed credit limit from $5,000 to $7,500", "uploaded resale cert"). Manual log entries also allowed (call notes).

## Statements

On-demand generation only — no automatic monthly run.

Two formats:
- **Open balance statement** (just unpaid invoices)
- **Full activity statement** (all activity in date range — invoices, payments, credits)

PDF + email via Mailgun OR download.

## Customer Portal

### Access control
- Wholesale customers default to portal-enabled on approval
- Disable flag per customer (preserves customer record, removes login)

### Multi-user per customer
- Up to **3 users per customer** (configurable cap)
- All users see same data; no role separation within portal
- Auto-account-created when customer is approved through wholesale application

### Wholesale application flow
1. Public-facing form (on ERP or website that posts to ERP API)
2. Creates a `wholesale_application` record (separate from `customer`)
3. Staff reviews → approves
4. On approval:
   - Creates ERP customer record
   - Creates Shopify customer with tag `wholesale-base` (default group)
   - Creates portal user account
   - Sends welcome email with portal credentials
5. Tier upgrades/downgrades sync to Shopify customer tags via API

### Portal capabilities

| Feature | Notes |
|---------|-------|
| View AR balance + aging | Standard buckets: Current / 1-30 / 31-60 / 61-90 / 91+ |
| View / download invoices | Historical PDF download |
| Pay invoices | Multi-invoice, partial, full, apply credits/deposits |
| View order history + status | Confirmed / Dispatched / Closed with tracking |
| View pricing | Tier price + quantity breaks; lower of (tier × discount) or (quantity break) wins |
| Place new orders | Auto-flow to Confirmed status for review |
| Re-order from previous orders | One-click re-order |
| Backorder reorder | Notification when stock back; "add to next order" workflow |
| Manage contact info / addresses | Self-service updates |
| Manage payment methods | Add/remove, set preferred (via CIM tokens) |
| Generate statement | On-demand, both formats |
| Dispute invoice | Creates staff ticket, flags invoice as "Disputed" |
| Auto-pay enrollment | Optional — for customers paying weekly to catch up |

### Backorder handling

- When line is backordered: cancelled off original SO with reason "backordered"
- `backorder_queue` record created: (customer, product, original_SO, qty, original_price)
- Stock returns above threshold → email notification + portal badge
- On next order entry: prompt with queued items pre-priced
- **Re-order price:** lower of (original quoted price, current price at re-order). System logs which applied.
- Configurable expiration (e.g., auto-dismiss after 90 days)

## Reports

- Customers with outstanding balance
- Customers ordered in last X days / not ordered in last X days
- Order frequency (high/low)
- Growing AOV / declining AOV
- Sales by rep, period
- Commissions by rep, period
- Top customers by revenue / margin
- Customer aging buckets
- Customer lifetime value

## Architectural notes

- **Drop-ship vendors get a "shadow customer" record** for commission AR (see Module 3)
- Shadow customers are flagged `system_generated` and not manually created
