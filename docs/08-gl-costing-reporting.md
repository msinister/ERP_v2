# 08 — Module 7: GL, Costing Engine, & Reporting

## Chart of Accounts

### Structure
**Built fresh** (no migration). Standard 5-type:

| Type | Range | Examples |
|------|-------|----------|
| Assets | 1xxx | Cash, AR, Inventory, Fixed Assets, Accrued Receipts |
| Liabilities | 2xxx | AP, Credit Cards, Loans, Sales Tax Payable |
| Equity | 3xxx | Owner's Equity, Retained Earnings |
| Revenue | 4xxx | Sales, Commission Revenue, Other Income |
| Expenses | 5xxx–9xxx | COGS, Operating Expenses |

### Hierarchy
**Tree structure with unlimited depth.** Sub-accounts under any parent:
- `1200 - AR`
  - `1210 - AR Customers`
  - `1220 - Commission Receivable`
    - `1221 - Commission Receivable - Vendor A`
    - `1222 - Commission Receivable - Vendor B`

### Multi-warehouse inventory
**Each warehouse has its own inventory account:**
- `1300 - Inventory - Warehouse A`
- `1310 - Inventory - Warehouse B`

Stock transfers post between these accounts.

### Editing
- Fully self-serve in Admin
- Permission-controlled (only certain users can edit COA)

## Automatic journal posting

The GL is driven by operational events. Every meaningful operational event auto-posts a JE.

### Sales order closes (ships)
```
DR Accounts Receivable             (gross customer-owed)
CR Sales Revenue                   (revenue earned)
DR Cost of Goods Sold              (FIFO cost of items)
CR Inventory - Warehouse X         (inventory decreases at FIFO)
DR Accounts Receivable             (shipping charged)
CR Shipping Income
DR Accounts Receivable             (handling charged)
CR Handling Income
```

### Customer payment received
**Record gross; reconcile merchant fees separately later.**
```
DR Cash / Bank                     (gross amount)
CR Accounts Receivable             (customer no longer owes)
```

### PO received (inventory in)
**"Received not invoiced" pattern using Accrued Receipts clearing account.**

On receipt:
```
DR Inventory - Warehouse X         (stock value increases)
CR Accrued Receipts                (clearing — we owe someone, bill not yet confirmed)
```

When bill is confirmed (matches receipt):
```
DR Accrued Receipts                (clear holding)
CR Accounts Payable - Vendor       (formally owed)
```

### Bill paid
```
DR Accounts Payable - Vendor       (no longer owed)
CR Cash / Bank                     (money out)
```

### Drop-ship commission earned (vendor confirmed shipment)
```
DR Commission Receivable - Vendor X    (vendor owes you)
CR Commission Revenue                  (you earned it)
```
Amount = `gross_sale × commission_rate`

### Drop-ship commission collected
```
DR Cash / Bank
CR Commission Receivable - Vendor X
```

### Inventory adjustment (breakage, loss)
```
DR Inventory Adjustment Expense    (loss recorded)
CR Inventory - Warehouse X         (stock decreases)
```
Reverse for found stock. Reason field required on every adjustment.

### Stock transfer (multi-warehouse)
```
DR Inventory - Warehouse B
CR Inventory - Warehouse A
```
No P&L impact. Layers move between warehouses preserving cost and date.

### Build / assembly completion
```
DR Inventory - Warehouse X (finished good, new layer)
CR Inventory - Warehouse X (component A FIFO consumption)
CR Inventory - Warehouse X (component B FIFO consumption)
CR Labor Expense (optional, if labor cost included)
```

### Credit memo / RMA confirmed
```
DR Sales Returns                   (revenue reversed)
CR Accounts Receivable             (customer no longer owes)
DR Inventory - Warehouse X         (stock back at original FIFO cost)
CR Cost of Goods Sold              (COGS reversed)
DR Accounts Receivable             (restocking fee charged)
CR Restocking Fee Income
```

### Manual journal entries
- Permission-controlled (only accountant/manager+)
- Reason required
- Reversal capability built in
- Fully audit-logged

## Costing engine

### FIFO layers

**Layer record:**
- product_id
- warehouse_id
- qty
- unit_cost
- received_date
- source (PO/receipt/adjustment/build/RMA)

**Operations:**
- Receive → create new layer
- Sell → consume oldest layers first; lock COGS at consumption
- Return (RMA, after CM confirmed) → create new layer at original sale's FIFO cost
- Adjust loss (breakage) → consume oldest layer first
- Adjust gain (found stock) → create new layer at most recent cost
- Transfer → move layer between warehouses (preserve cost and date)
- Build → consume component layers, create finished-good layer

### Weighted Average Cost (WAC)

- Recalculated **per product per warehouse** after every inventory movement (in, out, adjustment, transfer, build)
- Stored as product's "current cost" — used for cost-plus pricing and reference display
- Formula: `WAC = total_layer_value / total_layer_qty`

### Landed cost

**At receipt time:**
- Inputs: freight, customs, handling
- Allocation: by unit count, weight, value, OR box count (e.g., "12 boxes × $48/box")
- Allocated amount bakes into FIFO layer cost + WAC

**Late landed cost (Option A — retroactive):**
- Updates affected FIFO layers' unit cost
- Recalculates COGS for already-sold units
- Posts COGS adjustment dated to **original sale date** (preserves period accuracy)
- If period is **hard-closed**: system flags for manual review; accountant decides whether to reopen or post to current period

### Cost adjustments without quantity change
- Vendor billed differently than PO → **retroactively update FIFO layer cost**
- Recalculate COGS for already-sold units
- Same closed-period fallback as landed cost

## Period close

### Period definitions
Monthly, quarterly, and yearly closes (all supported).

### Soft close
- Period closed for normal users
- Editable by accountants/managers (with permission)
- Acceptable state for typical month-end

### Hard close
- No further posts allowed without **manager override + reason**
- Reserved for finalized/audited periods

### Year-end close (manual trigger)
- **NOT automatic on Dec 31**
- Books stay in soft close through Q1 of new year while accountant posts adjustments (accruals, depreciation, deferred items)
- When books are truly final → accountant manually triggers "Year-End Hard Close"
- At that point, system runs:
  ```
  DR Income accounts (zero them out)
  CR Expense accounts (zero them out)
  Net difference → DR/CR Retained Earnings
  ```
- Year is locked

### Fiscal year
- Default: calendar year (Jan 1 – Dec 31)
- Configurable in Admin Settings

### Permission control
Period close (soft and hard) requires explicit permission. Posting to closed periods requires override permission + reason.

## Financial reports

### Standard
- **Balance Sheet** (point in time)
- **Income Statement / P&L** (date range)
- **Cash Flow Statement** (date range, indirect method)
- **Trial Balance** (date range, all accounts with debits/credits)
- **General Ledger** (per account, all transactions)
- **Journal Report** (all JEs in date range)

### Comparison
- This period vs. prior period
- This period vs. same period last year
- YTD vs. prior YTD

(Budget vs. actual deferred — no budgeting needed in v1.)

## Operational reports (consolidated list)

### Sales (detail + summary versions)
- By customer
- By item
- By sales rep
- By warehouse
- By category
- Top by product
- Top by brand
- Top by vendor

### Profit margin
- By product
- By customer
- By sales rep

### Order metrics
- Average order value by customer
- Average order value by sales rep
- Average order value by brand
- Customer lifetime value

### Inventory
- Inventory valuation
- Inventory aging
- Stock movement
- Reorder suggestions
- Slow-moving inventory
- Dead stock
- Inventory by warehouse
- Inventory in transit
- Inventory with most returns
- Inventory with most defects/damage

### Purchasing
- Purchases by vendor (period)
- Purchase price trend per product
- Vendor performance
- Open POs

### AR (detailed in Module 5)
### AP (detailed in Module 6)
### Commissions
- Sales rep commissions earned (paid invoices)
- Sales rep commissions pending (open invoices)
- Sales rep commissions reversed (refunds)
- Drop-ship vendor commissions owed to us

## Custom report builder

- Drag-and-drop or query interface
- Pick fields, filters, group-bys
- Export to CSV / Excel / PDF
- Saved reports can be shared with permissioned users
- Permission-gated (not every user can build custom reports)

## Report scheduling

Schedule any report for daily/weekly/monthly auto-email to one or more recipients via Mailgun.

## Dashboard widgets

User-configurable dashboard. Initial widgets:
- Open SOs (filterable by status)
- Open POs
- AR aging summary
- AP aging summary
- Today's sales
- Cash position
- Low stock alerts
- Card expiring alerts
- Documents expiring alerts
- Sales rep dashboard (their KPIs)
- Disputed invoices
- Unapplied payments

More to be added based on usage.

## Sales tax

### v1 scope
- Tracking only, no tax engine
- Sales tax collected by Shopify on retail (handled upstream)
- ERP just stores customer's resale cert / sales tax permit (file upload)
- Tax-exempt flag on wholesale customers
- Sales Tax Payable account on books (liability) for any retail sales recorded directly
- Reports: sales tax collected by state by period (if applicable)
- No automatic remittance — accountant files manually

## Multi-currency

USD only in v1. Schema includes nullable `currency` field on transactions for future multi-currency support without major refactor.

## Architectural notes

### Auto-create accounts on certain events
- New drop-ship vendor → auto-create `Commission Receivable - {Vendor}` sub-account
- New stock vendor → auto-create `AP - {Vendor}` sub-account (or use single AP control account with sub-ledger)
- Decision: use **single AR / AP control accounts** with sub-ledger detail; auto-create sub-accounts only for **commission receivable per vendor** (where breakdown matters at GL level)

### Reconciliation checks at period close
Automated checks run at close:
- AR control balance matches sum of open invoices in subledger
- AP control balance matches sum of open bills in subledger
- Inventory account balance matches sum of FIFO layer values per warehouse
- Cash balance matches recorded payments minus recorded outflows
- Accrued Receipts is zero (or aged items flagged)

Discrepancies block hard close until reconciled or override.
