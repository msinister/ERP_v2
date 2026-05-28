// Shopify REST Admin API resource shapes. Only the fields we actually
// read are typed — the wire format carries many more. Numeric ids on
// the wire are Number; we coerce to string in the client so they don't
// silently lose precision and so storage stays consistent regardless of
// the API version returning them.

export type ShopifyImage = {
  id: string;
  src: string;
  alt: string | null;
  position: number;
};

export type ShopifyVariant = {
  id: string;
  product_id: string;
  title: string;
  sku: string;
  barcode: string | null;
  weight: number | null;
  weight_unit: string | null;
  // Option values that distinguish this variant (Small / Red / etc.).
  option1: string | null;
  option2: string | null;
  option3: string | null;
};

export type ShopifyProductStatus = 'active' | 'draft' | 'archived';

export type ShopifyProduct = {
  id: string;
  title: string;
  body_html: string | null;
  vendor: string | null;
  product_type: string | null;
  // Shopify wire format for tags is a single comma-separated string.
  tags: string;
  status: ShopifyProductStatus;
  images: ShopifyImage[];
  variants: ShopifyVariant[];
  created_at: string;
  updated_at: string;
};

// Webhook payloads (products/create + products/update share this shape;
// products/delete is a stripped envelope with just the id).
export type ShopifyProductWebhookPayload = ShopifyProduct;

export type ShopifyProductDeletePayload = {
  id: string | number;
};

// Registered-webhook subscription record returned by /admin/api/.../webhooks.json.
export type ShopifyWebhookSubscription = {
  id: string;
  topic: string;
  address: string;
  format: 'json';
};

// Variant-level lookup. Only fields used by the inventory push path
// (inventory_item_id is what /inventory_levels/set keys off of).
export type ShopifyVariantLookup = {
  id: string;
  product_id: string;
  sku: string | null;
  inventory_item_id: string;
};

// Payload for createProduct (ERP → Shopify). Mirrors the subset of
// Shopify's products.json POST body we actually populate from ERP data.
// Only required fields are required here; optional fields (vendor,
// product_type, tags, body_html, weight) are omitted from the request
// when null/undefined upstream.
export type ShopifyCreateVariantInput = {
  // Required on UPDATE to identify the existing Shopify variant; omitted
  // on CREATE (or when adding a new variant to an existing product on
  // update — Shopify creates a fresh variant for those). Without `id`,
  // Shopify's PUT semantics will replace any unmatched existing variants.
  id?: string;
  sku: string;
  price: string; // decimal string, e.g. "12.99"
  inventory_management: 'shopify';
  fulfillment_service: 'manual';
  requires_shipping: boolean;
  weight?: number;
  weight_unit?: 'lb' | 'kg' | 'oz' | 'g';
};

// One image in the create-product payload. `src` is the URL Shopify will
// fetch + rehost on its CDN; `alt` is optional alt text. Position is
// implicit — Shopify assigns positions in the order images appear, which
// is how pushProductToShopify maps variant images back to image ids after
// the create round-trip.
export type ShopifyCreateImageInput = {
  src: string;
  alt?: string;
};

export type ShopifyCreateProductInput = {
  title: string;
  body_html?: string;
  vendor?: string;
  product_type?: string;
  tags?: string; // comma-separated, matches Shopify's wire format
  status: 'active' | 'draft';
  variants: ShopifyCreateVariantInput[];
  images?: ShopifyCreateImageInput[];
};

// Shape returned by createProduct — fields the caller needs to populate
// junction rows + map variant images back. Shopify returns the full
// product resource; we narrow to what's used.
export type ShopifyCreatedProduct = {
  id: string;
  variants: Array<{
    id: string;
    inventory_item_id: string;
    sku: string | null;
  }>;
  images: Array<{
    id: string;
    position: number;
    src: string;
  }>;
};

// ---------------------------------------------------------------------------
// Order resource — Shopify → ERP direction. Only fields the importer + UI
// actually read are typed; raw payload is preserved verbatim on
// PendingOrderReview.shopifyOrderData when we need the full picture later.
// ---------------------------------------------------------------------------

export type ShopifyAddress = {
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  address1: string | null;
  address2: string | null;
  city: string | null;
  province: string | null;
  province_code: string | null;
  country: string | null;
  country_code: string | null;
  zip: string | null;
  phone: string | null;
  name: string | null;
};

export type ShopifyOrderCustomer = {
  id: string;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  default_address: ShopifyAddress | null;
};

export type ShopifyLineItem = {
  id: string;
  variant_id: string | null;
  product_id: string | null;
  sku: string | null;
  title: string;
  variant_title: string | null;
  vendor: string | null;
  quantity: number;
  // Per-unit price as decimal string ("12.99").
  price: string;
  // Total discount allocated to the line (decimal string, sum across
  // discount_allocations[]).
  total_discount: string;
  taxable: boolean;
  requires_shipping: boolean;
};

export type ShopifyShippingLine = {
  id: string;
  title: string;
  price: string; // decimal string
  code: string | null;
  source: string | null;
};

// We only need to know that *some* transaction settled this order; the
// full transaction history (refunds, partials, gateway-specific blobs)
// stays in shopifyOrderData verbatim.
export type ShopifyTransactionSummary = {
  id: string;
  kind: string; // "sale", "authorization", "capture", "refund", "void"
  status: string; // "success", "pending", "failure", "error"
  gateway: string | null;
  amount: string; // decimal string
  created_at: string;
};

export type ShopifyOrderFinancialStatus =
  | 'pending'
  | 'authorized'
  | 'partially_paid'
  | 'paid'
  | 'partially_refunded'
  | 'refunded'
  | 'voided';

export type ShopifyOrderFulfillmentStatus =
  | 'fulfilled'
  | 'partial'
  | 'restocked'
  | null;

export type ShopifyOrder = {
  id: string;
  // Shopify's "#1045" — note the literal hash prefix is preserved.
  name: string;
  // Plain numeric order number ("1045").
  order_number: number;
  email: string | null;
  phone: string | null;
  currency: string;
  financial_status: ShopifyOrderFinancialStatus | null;
  fulfillment_status: ShopifyOrderFulfillmentStatus;
  // Per-order money totals as decimal strings.
  subtotal_price: string;
  total_discounts: string;
  total_shipping_price_set: { shop_money: { amount: string; currency_code: string } } | null;
  total_price: string;
  total_tax: string;
  // Optional gateway hint when a single gateway processed everything.
  payment_gateway_names: string[];
  customer: ShopifyOrderCustomer | null;
  billing_address: ShopifyAddress | null;
  shipping_address: ShopifyAddress | null;
  line_items: ShopifyLineItem[];
  shipping_lines: ShopifyShippingLine[];
  transactions?: ShopifyTransactionSummary[];
  note: string | null;
  // Operator-supplied key/value pairs attached to the order (e.g.
  // "Gift wrap: yes"). Stored on Shopify alongside `note` but separate
  // from `tags` (which is a single comma-separated string). Optional
  // because not every order payload includes the field.
  note_attributes?: Array<{ name: string; value: string }>;
  tags: string;
  cancelled_at: string | null;
  cancel_reason: string | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
};

export type ShopifyOrderWebhookPayload = ShopifyOrder;
