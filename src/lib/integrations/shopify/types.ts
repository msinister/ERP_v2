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
  sku: string;
  price: string; // decimal string, e.g. "12.99"
  inventory_management: 'shopify';
  fulfillment_service: 'manual';
  requires_shipping: boolean;
  weight?: number;
  weight_unit?: 'lb' | 'kg' | 'oz' | 'g';
};

export type ShopifyCreateProductInput = {
  title: string;
  body_html?: string;
  vendor?: string;
  product_type?: string;
  tags?: string; // comma-separated, matches Shopify's wire format
  status: 'active' | 'draft';
  variants: ShopifyCreateVariantInput[];
};

// Shape returned by createProduct — just the fields we need to populate
// ProductShopifyVariant junction rows. (Shopify returns the full product
// resource; we narrow to what callers actually use.)
export type ShopifyCreatedProduct = {
  id: string;
  variants: Array<{
    id: string;
    inventory_item_id: string;
    sku: string | null;
  }>;
};
