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
