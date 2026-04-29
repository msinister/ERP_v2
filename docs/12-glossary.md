# 12 — Glossary

Reference for accounting and ERP terminology used throughout this spec.

## Accounting

**Accounts Payable (AP)** — Money you owe to vendors for goods/services received but not yet paid.

**Accounts Receivable (AR)** — Money customers owe you for goods/services delivered but not yet paid.

**Accrued Receipts** (also called GR/IR — Goods Received / Invoice Received) — A clearing/holding account that bridges the timing gap between receiving goods (inventory in) and getting the vendor's bill. Should always net to zero once everything is billed.

**Aging** — How long an unpaid invoice has been outstanding. Bucketed into Current / 1–30 / 31–60 / 61–90 / 91+ days.

**Balance Sheet** — Financial statement showing assets, liabilities, and equity at a point in time.

**Chart of Accounts (COA)** — The full list of GL accounts (numbered, categorized) used to record financial activity.

**COGS (Cost of Goods Sold)** — The cost of inventory consumed when a sale ships. For FIFO costing, this is the cost of the oldest inventory layer at the time of sale.

**Credit Memo (CM)** — A document reducing a customer's AR balance (used for returns, damages, pricing adjustments, goodwill credits).

**DSO (Days Sales Outstanding)** — Average number of days it takes to collect AR after a sale. Lower is better.

**Double-entry accounting** — Every JE has equal debits and credits. The fundamental principle of accounting.

**Income Statement / P&L (Profit & Loss)** — Financial statement showing revenue, expenses, and net income over a period.

**Journal Entry (JE)** — The basic unit of accounting. Records one financial event with at least one debit and one credit, balanced.

**Trial Balance** — Report showing the debit and credit balances of all GL accounts at a date. Used to verify books are in balance.

**Retained Earnings** — Cumulative net income the business has retained (vs. distributed) over its lifetime.

**Soft close vs. hard close** — Soft close = period closed for normal users but still editable by accountants. Hard close = period locked, requires manager override + reason to post.

## Inventory & costing

**FIFO (First In, First Out)** — Costing method where the oldest inventory layers are consumed first when items are sold or used.

**WAC (Weighted Average Cost)** — Total inventory value divided by total quantity, recalculated after every movement. Used for cost-plus pricing and reference.

**Layer** — A FIFO record representing a batch of inventory received at a specific cost on a specific date.

**Landed cost** — Total cost to get inventory to your warehouse. Includes vendor cost + freight + customs/duty + handling.

**WAC drift** — When small rounding differences accumulate over many WAC recalculations. Typically managed via periodic reconciliation.

**Reserved / committed quantity** — Inventory promised to open sales orders but not yet shipped.

**Available quantity** — On Hand minus Reserved.

**On-order quantity** — Inventory on open POs not yet received.

**In-transit quantity** — Inventory moving between warehouses (transfer initiated but not received).

## ERP / operations

**SO (Sales Order)** — Customer order, before invoicing.

**PO (Purchase Order)** — Order placed with a vendor.

**RMA (Return Merchandise Authorization)** — Authorization given to a customer to return goods.

**BOM (Bill of Materials)** — List of components and quantities required to build an assembled product.

**MOQ (Minimum Order Quantity)** — Vendor's minimum quantity per order.

**Pack hierarchy** — The packaging levels of a product (base unit → display case → master case → pallet).

**Bundle** — Promo SKU containing multiple products at a discounted combined price.

**Drop-ship (traditional)** — Vendor ships directly to customer; you take payment and pay the vendor.

**Drop-ship (this business)** — Commission/marketplace model. Vendor takes payment from customer directly and pays you commission. **NOT traditional drop-ship.**

**Pick sheet** — Internal document used by warehouse staff to locate and gather items for an order.

**Packing slip** — Document that goes in the box, shows what's included (no prices typically).

**Check-in sheet** — Internal document for receiving inbound shipments from vendors.

## Integrations

**Authorize.Net** — Payment gateway used (via Kaja merchant account) for credit card processing.

**CIM (Customer Information Manager)** — Authorize.Net feature for storing tokenized cards on file (PCI scope reduction).

**Mailgun** — Email delivery service.

**ShipStation** — Multi-carrier shipping platform with API for label generation and rate calculation.

**SpeeD Ship** — Custom shipping carrier with own API.

**Matrixify** — Shopify app vendors use to sync product data into your Shopify store.

**Webhook** — HTTP callback that fires when an event happens (e.g., Shopify product updated → POSTs to ERP).

## Permissions & security

**RBAC (Role-Based Access Control)** — Permissions assigned to roles, users assigned to roles. Standard model.

**2FA (Two-Factor Authentication)** — Login requires password + second factor (email code, authenticator app).

**PCI compliance** — Payment Card Industry data security standards. Stricter compliance applies if you store/transmit card data.

**Soft-delete** — Mark record as inactive/archived; preserves history.

**Hard-delete** — Permanently remove record from database.

**Audit log** — Append-only record of sensitive actions for compliance and debugging.

## Multi-instance

**Single codebase, multi-instance** — One codebase deployed separately per company. Each company has its own database, URL, users.

**Shadow customer** — A customer record created automatically to handle AR for a drop-ship vendor (since vendor owes you commission).
