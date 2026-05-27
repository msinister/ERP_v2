import type {
  ShopifyCreateProductInput,
  ShopifyCreatedProduct,
  ShopifyProduct,
  ShopifyVariantLookup,
  ShopifyWebhookSubscription,
} from './types';

// =============================================================================
// Shopify REST Admin API client. Pinned to 2024-10 (stable). Auth is by
// access token (X-Shopify-Access-Token header) — installed-app pattern,
// no OAuth handshake needed for the in-app sync flow.
//
// Cursor pagination: Shopify returns a `Link` header on list endpoints
// whose `rel="next"` URL carries a `page_info` token. We parse that
// header verbatim instead of trying to build a cursor parameter scheme
// ourselves — Shopify's docs are explicit that consumers MUST follow
// the Link header rather than reconstruct pagination URLs.
//
// Rate limiting: Shopify uses a leaky-bucket REST limit. When the bucket
// fills, the API returns 429 with `Retry-After` (seconds). We honor it
// and back off; a 5xx triggers exponential backoff with a small jitter.
// =============================================================================

const API_VERSION = '2024-10';
const MAX_RETRIES = 4;

export type ShopifyClientOptions = {
  storeUrl: string; // canonical bare host: "mystore.myshopify.com"
  accessToken: string;
  // Optional fetch override for tests. Defaults to global fetch.
  fetchImpl?: typeof fetch;
};

export class ShopifyClient {
  private readonly baseUrl: string;
  private readonly accessToken: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ShopifyClientOptions) {
    this.baseUrl = `https://${opts.storeUrl}/admin/api/${API_VERSION}`;
    this.accessToken = opts.accessToken;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Get the count of all products. Used as a sanity-check for the test-
   * connection button — if the token is wrong, the API returns 401 here.
   */
  async productCount(): Promise<number> {
    const res = await this.request<{ count: number }>(
      'GET',
      '/products/count.json',
    );
    return res.body.count;
  }

  /**
   * Get a single product by id. Used for manual single-product re-sync.
   */
  async getProduct(productId: string): Promise<ShopifyProduct> {
    const res = await this.request<{ product: ShopifyProduct }>(
      'GET',
      `/products/${productId}.json`,
    );
    return normalizeProduct(res.body.product);
  }

  /**
   * Iterate ALL active products with cursor pagination. Each yielded batch
   * is up to `limit` products (max 250 per Shopify). The caller decides
   * whether to process serially or batch in parallel — we just stream.
   */
  async *iterateActiveProducts(
    limit: number = 250,
  ): AsyncGenerator<ShopifyProduct[], void, void> {
    let path: string | null = `/products.json?status=active&limit=${limit}`;
    while (path) {
      const res = await this.request<{ products: ShopifyProduct[] }>(
        'GET',
        path,
      );
      yield res.body.products.map(normalizeProduct);
      path = parseNextLink(res.linkHeader, this.baseUrl);
    }
  }

  /**
   * List webhook subscriptions. Used by the register-webhooks route to
   * detect which topics are already wired so we don't double-register.
   */
  async listWebhooks(): Promise<ShopifyWebhookSubscription[]> {
    const res = await this.request<{ webhooks: ShopifyWebhookSubscription[] }>(
      'GET',
      '/webhooks.json?limit=250',
    );
    return res.body.webhooks.map((w) => ({ ...w, id: String(w.id) }));
  }

  /**
   * Register one webhook subscription. Idempotent at the caller level —
   * check listWebhooks() first.
   */
  async createWebhook(
    topic: string,
    address: string,
  ): Promise<ShopifyWebhookSubscription> {
    const res = await this.request<{ webhook: ShopifyWebhookSubscription }>(
      'POST',
      '/webhooks.json',
      { webhook: { topic, address, format: 'json' } },
    );
    return { ...res.body.webhook, id: String(res.body.webhook.id) };
  }

  /**
   * Fetch a single variant by id. Used by the inventory-push path to look
   * up `inventory_item_id` the first time we touch a variant (the result is
   * cached on ProductShopifyVariant so subsequent pushes skip this hop).
   */
  async getVariant(variantId: string): Promise<ShopifyVariantLookup> {
    type Raw = {
      variant: {
        id: string | number;
        product_id: string | number;
        sku: string | null;
        inventory_item_id: string | number;
      };
    };
    const res = await this.request<Raw>('GET', `/variants/${variantId}.json`);
    const v = res.body.variant;
    return {
      id: String(v.id),
      product_id: String(v.product_id),
      sku: v.sku,
      inventory_item_id: String(v.inventory_item_id),
    };
  }

  /**
   * Create a new product on Shopify (ERP → Shopify direction). Returns the
   * created product with its variant ids + inventory_item_ids so the caller
   * can populate ProductShopifyVariant junction rows immediately. Used by
   * pushProductToShopify; never called from the Shopify → ERP path.
   */
  async createProduct(
    input: ShopifyCreateProductInput,
  ): Promise<ShopifyCreatedProduct> {
    type Raw = {
      product: {
        id: string | number;
        variants: Array<{
          id: string | number;
          inventory_item_id: string | number;
          sku: string | null;
        }>;
        images?: Array<{
          id: string | number;
          position: number;
          src: string;
        }>;
      };
    };
    const res = await this.request<Raw>('POST', '/products.json', {
      product: input,
    });
    const p = res.body.product;
    return {
      id: String(p.id),
      variants: p.variants.map((v) => ({
        id: String(v.id),
        inventory_item_id: String(v.inventory_item_id),
        sku: v.sku,
      })),
      images: (p.images ?? []).map((i) => ({
        id: String(i.id),
        position: i.position,
        src: i.src,
      })),
    };
  }

  /**
   * Update an existing Shopify product (PUT /products/{id}.json). Same
   * payload shape as createProduct — see ShopifyCreateProductInput for
   * the variant-id and image-replacement semantics. Returns the full
   * product the same way createProduct does so the caller can refresh
   * junction rows + redo variant→image_id assignments (image ids change
   * because PUT replaces the entire image set).
   */
  async updateProduct(
    shopifyProductId: string,
    input: ShopifyCreateProductInput,
  ): Promise<ShopifyCreatedProduct> {
    type Raw = {
      product: {
        id: string | number;
        variants: Array<{
          id: string | number;
          inventory_item_id: string | number;
          sku: string | null;
        }>;
        images?: Array<{
          id: string | number;
          position: number;
          src: string;
        }>;
      };
    };
    const res = await this.request<Raw>(
      'PUT',
      `/products/${shopifyProductId}.json`,
      { product: { id: Number(shopifyProductId), ...input } },
    );
    const p = res.body.product;
    return {
      id: String(p.id),
      variants: p.variants.map((v) => ({
        id: String(v.id),
        inventory_item_id: String(v.inventory_item_id),
        sku: v.sku,
      })),
      images: (p.images ?? []).map((i) => ({
        id: String(i.id),
        position: i.position,
        src: i.src,
      })),
    };
  }

  /**
   * Assign a previously-created Shopify image to a Shopify variant via
   * PUT /variants/{id}.json. Used by pushProductToShopify after the
   * product create — variant.image_id can't be set on POST /products.json
   * because the image ids don't exist yet, so we do a follow-up call per
   * variant that has an ERP-side variant image. Per-call failures are
   * isolated by the caller (best-effort assignment).
   */
  async updateVariantImage(variantId: string, imageId: string): Promise<void> {
    await this.request<unknown>('PUT', `/variants/${variantId}.json`, {
      variant: { id: Number(variantId), image_id: Number(imageId) },
    });
  }

  /**
   * Set absolute inventory quantity at (location, inventory_item) on this
   * Shopify store. Used by the inventory push service. Shopify expects a
   * decimal quantity for some categories (e.g. weight-based) but for our
   * pilot (each-based) it's always integer — we Math.floor at the call
   * site to be safe.
   */
  async setInventoryLevel(
    locationId: string,
    inventoryItemId: string,
    available: number,
  ): Promise<void> {
    await this.request<unknown>('POST', '/inventory_levels/set.json', {
      location_id: Number(locationId),
      inventory_item_id: Number(inventoryItemId),
      available,
    });
  }

  // ---------------------------------------------------------------------------
  // Transport
  // ---------------------------------------------------------------------------

  private async request<T>(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    body?: unknown,
  ): Promise<{ body: T; linkHeader: string | null }> {
    // Allow `path` to be absolute (the next-page URL Shopify hands back in
    // its Link header) or relative — strip our baseUrl prefix either way.
    const url = path.startsWith('http') ? path : `${this.baseUrl}${path}`;
    let attempt = 0;
    for (;;) {
      const res = await this.fetchImpl(url, {
        method,
        headers: {
          'X-Shopify-Access-Token': this.accessToken,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: body == null ? undefined : JSON.stringify(body),
      });

      // 429 = rate limit → honor Retry-After, then retry.
      if (res.status === 429 && attempt < MAX_RETRIES) {
        const wait = parseRetryAfter(res.headers.get('retry-after')) ?? 1000;
        await sleep(wait);
        attempt++;
        continue;
      }
      // 5xx → exponential backoff with a tiny jitter, then retry.
      if (res.status >= 500 && res.status < 600 && attempt < MAX_RETRIES) {
        const wait = 500 * Math.pow(2, attempt) + Math.floor(Math.random() * 100);
        await sleep(wait);
        attempt++;
        continue;
      }

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new ShopifyApiError(res.status, `Shopify ${method} ${path} → ${res.status}: ${text.slice(0, 400)}`);
      }

      const parsed = (await res.json().catch(() => null)) as T | null;
      if (parsed == null) {
        throw new ShopifyApiError(res.status, `Shopify ${method} ${path} returned non-JSON`);
      }
      return { body: parsed, linkHeader: res.headers.get('link') };
    }
  }
}

export class ShopifyApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ShopifyApiError';
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Shopify's Link header looks like:
//   <https://store.myshopify.com/admin/api/X/products.json?page_info=...>; rel="next"
// Return the next-page URL or null if no "next" relation present.
function parseNextLink(linkHeader: string | null, baseUrl: string): string | null {
  if (!linkHeader) return null;
  for (const entry of linkHeader.split(',')) {
    const m = /^\s*<([^>]+)>\s*;\s*rel="?next"?\s*$/.exec(entry);
    if (m) {
      const url = m[1];
      // Strip our base prefix so the next iteration uses the same path
      // shape as the first call (cosmetic — request() also accepts
      // absolute URLs, but consistency helps debugging).
      return url.startsWith(baseUrl) ? url.slice(baseUrl.length) : url;
    }
  }
  return null;
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const secs = Number(header);
  if (!Number.isFinite(secs) || secs < 0) return null;
  return Math.min(secs * 1000, 30_000); // cap at 30s; no honest case needs more
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Numeric ids on the wire → strings everywhere internal. Same coercion
// applied to nested variant/image ids.
function normalizeProduct(p: ShopifyProduct): ShopifyProduct {
  return {
    ...p,
    id: String(p.id),
    variants: (p.variants ?? []).map((v) => ({
      ...v,
      id: String(v.id),
      product_id: String(v.product_id),
    })),
    images: (p.images ?? []).map((i) => ({ ...i, id: String(i.id) })),
  };
}
