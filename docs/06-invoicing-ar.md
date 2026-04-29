# 06 — Module 5: Invoicing & Accounts Receivable

## Invoice generation

### Trigger
Invoice generated when SO moves to **Closed**.

### Numbering
- Invoice # = SO #
- Split orders (drop-ship): child invoices = `{SO}-1`, `{SO}-2`, etc.

### Delivery
- **Manual button** ("Email Invoice") — staff clicks to send via Mailgun to customer's billing contact
- Always available in customer portal automatically

### PDF storage (hybrid)
- On first email/send → render and **store permanently** in DigitalOcean Spaces
- Stored PDF is the legal record
- Internal staff viewing → renders fresh from current data
- Customer portal downloads → serves stored PDF
- Re-emails → serves stored PDF
- Reissuing a corrected invoice = new PDF, new email, new stored copy (original retained)

### Invoice contents
Same as SO PDF + shipping cost + date shipped + payments + balance due.

## Payments

### Methods accepted
- Credit card (Authorize.Net via Kaja)
- ACH / eCheck
- Wire
- Check
- Cash
- Money order
- Applied credits (from customer credit memo balance)

### Payment timing per term type

| Term | Behavior |
|------|----------|
| Pay on shipment (most common) | Manual card charge at Closed |
| COD | Carrier collects, payment recorded when carrier remits |
| Net 30 | Invoice generated, payment received later |
| Prepay / Deposit | Payment captured before order proceeds; sits as credit until applied |

**No auto-charge anywhere.** Every charge is manually triggered by staff.

### Authorize.Net operations
- Authorize (place hold to verify card)
- Capture (charge against authorized hold)
- Auth + Capture (combined sale)
- Refund
- Void (unsettled transaction)

### Partial payments
- Allowed
- Aging continues from **original invoice date**
- Reduced balance shown on invoice
- Payment history per invoice

### Overpayments
- Allowed with warning
- Excess becomes **unapplied credit** on customer account
- Manual application by staff to specific invoice(s)

### Deposits (proactive customer prepay)
- Same model as overpayments — creates unapplied credit
- Staff records deposit (creates credit)
- Future orders draw against deposit
- System notifies on new invoice: "Customer has $X in unapplied credit available"
- Visible to customer in portal

### Payment application

**With explicit invoice reference:**
- Apply to specific invoice(s) the customer/staff designates
- Customer portal: customer picks which invoice(s) to pay

**Without invoice reference (e.g., check arrives in mail):**
- Allowed — payment stays unapplied
- System shows soft warning + list of open invoices (oldest first) suggesting application
- Staff can dismiss warning; payment remains unapplied
- Unapplied payments shown on dashboard widget (so they don't get forgotten)

### Payment receipt
- Auto-generated PDF on payment recording
- "Email Receipt" button → Mailgun to customer's billing contact
- Available in portal payment history

### Returned check / failed ACH / chargeback
- Manual handling by accounting staff
- System allows reversing a payment (restores AR balance) with reason field
- No automated workflow

## Credit memos & RMAs

### Credit memo categories
**Single bucket with `category` field.** Categories are **self-serve in Admin Settings** — add/edit/disable without code.

Common categories:
- Return
- Damaged goods
- Pricing dispute
- Goodwill
- Cancelled after invoice
- Bad debt write-off

### RMA workflow

```
Pending Review → Approved → In Transit → Received → Inspected → Credited
```

**Standard RMA path:**
1. Customer requests RMA in portal — picks invoice, line(s), reason, qty
2. Staff approves → generates return label (ShipStation API)
3. Customer ships goods back
4. Goods received at warehouse → logged but NOT yet returned to inventory
5. Inspection → approved
6. **Credit memo issued and confirmed** → at this point inventory restocks at original FIFO cost

**Returnless RMA path** (e.g., damaged glass):
1. Customer uploads photos + SKU + invoice # + qty
2. Flagged for staff review
3. On approval → credit issued directly (no goods to return)

### Restocking fee
- Configurable in Admin Settings
- Either flat rate OR percentage of return value
- Per RMA setting (default + manual override)

### Partial RMA
- Customer received 100, returns 30 → system credits proportionally
- Original invoice line tracks returned quantity

### RMA inventory effect

**Returns to inventory at original FIFO cost ONLY when credit memo is confirmed.**

Until then, returned goods sit in a holding state (not in sellable inventory). If RMA is rejected, goods are written off (not returned to inventory).

### Credit memo redemption
- Apply to future invoices (default)
- **No refund to original payment method via credit memo** — if you want to refund the original transaction, edit the original order/invoice instead
- Credit memos do **not** expire

### Refund methods (when refunding original transaction)

| Situation | Method |
|-----------|--------|
| Within Authorize.Net refund window (typically 120 days) | Gateway refund via Authorize.Net |
| Past gateway window | Manual: create AP entry → ACH or paper check to customer |

## Statements & aging

### Aging buckets
- Current
- 1–30 days
- 31–60 days
- 61–90 days
- 91+ days

### Statement generation (on-demand)
Two formats:
- **Open balance statement** — only unpaid invoices
- **Full activity statement** — all activity in date range (invoices, payments, credits)

PDF + email via Mailgun OR download.

### AR hold rules
- Configurable per customer: "block new orders when AR > X days past due"
- Default off
- X is per-customer configurable
- Manager override permitted with reason logged

### Late fees
- Percentage of balance, configurable in Admin Settings
- Off by default
- Can be applied manually OR auto-applied to newly aging invoices (configurable)

### Bad debt write-off
- Manual handling
- Use credit memo with category "Bad Debt Write-off" — preserves audit trail
- No dedicated function

## Customer portal AR features (recap from Module 2)

- View AR balance + aging
- View / download invoices (with stored PDFs)
- Pay one or multiple invoices, partial or full
- Apply credits/deposits before paying
- Save card / manage cards on file
- Make a deposit (proactive prepay)
- Download statement on demand
- **Dispute an invoice** — creates staff ticket, flags invoice as "Disputed"
- **Auto-pay enrollment** — for customers paying weekly to catch up

## Reports (AR)

- AR aging summary
- AR aging detail
- Open invoices
- Paid invoices by period
- Payments received by period (by user / rep)
- Credit memos by period
- Customer payment history
- Top AR balances
- DSO (Days Sales Outstanding) trend
- Disputed invoices
- Unapplied payments
- Customers on AR hold

## Architectural notes

### Auto journal posting on AR events
See Module 7 for full GL posting rules. Summary:

| Event | JE |
|-------|-----|
| Invoice generated (at SO Closed) | DR AR / CR Revenue + DR COGS / CR Inventory + DR AR / CR Shipping Income + DR AR / CR Handling Income |
| Customer payment received | DR Cash / CR AR (gross; merchant fees reconciled separately) |
| Credit memo issued (return) | DR Sales Returns / CR AR (revenue reversed) + DR Inventory / CR COGS (at original FIFO, only when CM confirmed) + restocking fee if applicable |
| Refund (gateway) | DR AR-reversal / CR Cash |
| Refund (check/ACH past gateway window) | DR AP / CR Cash (then offset against the original AR) |
