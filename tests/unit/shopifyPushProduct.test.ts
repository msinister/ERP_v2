import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma, ProductType } from '@/generated/tenant';

// ---------------------------------------------------------------------------
// Module mocks — declared with vi.mock BEFORE importing the unit under test
// so the imports inside shopifySync resolve to these stubs.
// ---------------------------------------------------------------------------

const createProductMock = vi.fn();
const updateVariantImageMock = vi.fn();

vi.mock('@/lib/integrations/shopify/client', () => {
  class ShopifyApiError extends Error {
    readonly status: number;
    constructor(status: number, message: string) {
      super(message);
      this.name = 'ShopifyApiError';
      this.status = status;
    }
  }
  // Class form is intentional — pushProductToShopify constructs the client
  // via `new ShopifyClient(...)`. A `vi.fn().mockImplementation(() => …)`
  // is not constructable and would throw "is not a constructor".
  class ShopifyClient {
    createProduct: typeof createProductMock;
    updateVariantImage: typeof updateVariantImageMock;
    constructor() {
      this.createProduct = createProductMock;
      this.updateVariantImage = updateVariantImageMock;
    }
  }
  return { ShopifyClient, ShopifyApiError };
});

vi.mock('@/server/services/shopifyStores', () => ({
  getSecretsForStore: vi.fn().mockResolvedValue({
    storeId: 'store-1',
    name: 'Test Store',
    storeUrl: 'test.myshopify.com',
    accessToken: 'shpat_test',
    webhookSecret: 'whsec_test',
    syncEnabled: true,
    inventoryPushEnabled: false,
    shopifyLocationId: null,
  }),
  recordSyncRun: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/server/services/shopifyStoreRules', () => ({
  productMatchesStore: vi.fn().mockResolvedValue(true),
  matchingProductIds: vi.fn().mockResolvedValue([]),
}));

vi.mock('@/server/services/shopifyInventoryPush', () => ({
  pushInventoryForProduct: vi.fn().mockResolvedValue([]),
}));

// Audit writes go to db.auditLog.create (which we stub on the fake db);
// nothing to mock at module level here.

// Import AFTER the mocks above — order matters.
import {
  buildShopifyCreateInput,
  buildShopifyImagePlan,
  pushProductToShopify,
  type BuildShopifyCreateInputProduct,
} from '@/server/services/shopifySync';
import { ShopifyApiError } from '@/lib/integrations/shopify/client';
import type { PrismaClient } from '@/generated/tenant';

// ---------------------------------------------------------------------------
// Test data builders
// ---------------------------------------------------------------------------

// Fixture shape: the narrow inputs buildShopifyCreateInput reads PLUS the
// few scalar accesses pushProductToShopify itself performs (id, active,
// deletedAt). Keeps fixtures decoupled from Prisma's full payload type.
type ProductFixture = BuildShopifyCreateInputProduct & {
  id: string;
  active: boolean;
  deletedAt: Date | null;
};

function makeProductFixture(): ProductFixture {
  return {
    id: 'prod-1',
    name: 'Test Product',
    longDescription: '<p>Hello</p>',
    brand: 'BrandX',
    category: 'Widgets',
    type: ProductType.SIMPLE,
    basePrice: new Prisma.Decimal('12.99'),
    weight: new Prisma.Decimal('1.5'),
    weightUnit: 'lb',
    active: true,
    deletedAt: null,
    variants: [
      {
        sku: 'SKU-A',
        imageUrl: null,
        vendorProducts: [{ vendor: { name: 'PrimaryVendorCo' } }],
      },
      { sku: 'SKU-B', imageUrl: null, vendorProducts: [] },
    ],
    tags: [
      { tag: { name: 'kratom' } },
      { tag: { name: 'wholesale' } },
    ],
    images: [],
  };
}

type CreatedRow = {
  productId: string;
  shopifyStoreId: string;
  shopifyProductId: string;
  shopifyVariantId: string;
  inventoryItemId: string | null;
  isPrimary: boolean;
};

// Fake Prisma client: only the methods pushProductToShopify touches need
// to exist. Each one is a vi.fn so we can both stub return values and
// inspect call args. Cast to PrismaClient at the boundary — tests are
// the one place this cast is appropriate.
function makeFakeDb(opts: {
  existingJunction?: { id: string } | null;
  product?: ReturnType<typeof makeProductFixture> | null;
}) {
  const createdRows: CreatedRow[] = [];
  return {
    rows: createdRows,
    db: {
      product: {
        findUnique: vi.fn().mockResolvedValue(opts.product ?? null),
        update: vi.fn().mockResolvedValue(undefined),
      },
      productShopifyVariant: {
        findFirst: vi.fn().mockResolvedValue(opts.existingJunction ?? null),
        create: vi.fn().mockImplementation(async ({ data }: { data: CreatedRow }) => {
          createdRows.push(data);
          return { id: `j-${createdRows.length}`, ...data };
        }),
      },
      auditLog: { create: vi.fn().mockResolvedValue(undefined) },
    } as unknown as PrismaClient,
  };
}

beforeEach(() => {
  createProductMock.mockReset();
  updateVariantImageMock.mockReset();
  updateVariantImageMock.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// buildShopifyCreateInput — pure function, no mocking needed
// ---------------------------------------------------------------------------

describe('buildShopifyCreateInput', () => {
  it('maps ERP product fields to a Shopify create payload', () => {
    const product = makeProductFixture();
    const payload = buildShopifyCreateInput(product);

    expect(payload.title).toBe('Test Product');
    expect(payload.body_html).toBe('<p>Hello</p>');
    expect(payload.vendor).toBe('PrimaryVendorCo');
    expect(payload.product_type).toBe('Widgets');
    expect(payload.tags).toBe('kratom, wholesale');
    expect(payload.status).toBe('active');
    expect(payload.variants).toHaveLength(2);
    for (const v of payload.variants) {
      expect(v.price).toBe('12.99');
      expect(v.inventory_management).toBe('shopify');
      expect(v.fulfillment_service).toBe('manual');
      expect(v.requires_shipping).toBe(true);
      expect(v.weight).toBe(1.5);
      expect(v.weight_unit).toBe('lb');
    }
  });

  it('falls back to Product.brand when no primary vendor is set', () => {
    const product = makeProductFixture();
    product.variants[0].vendorProducts = [];
    const payload = buildShopifyCreateInput(product);
    expect(payload.vendor).toBe('BrandX');
  });

  it('omits optional Shopify fields when ERP data is null', () => {
    const product = makeProductFixture();
    product.longDescription = null;
    product.category = null;
    product.brand = null;
    product.variants[0].vendorProducts = [];
    product.tags = [];
    const payload = buildShopifyCreateInput(product);
    expect(payload.body_html).toBeUndefined();
    expect(payload.product_type).toBeUndefined();
    expect(payload.tags).toBeUndefined();
    expect(payload.vendor).toBeUndefined();
  });

  it('sets requires_shipping=false for SERVICE products', () => {
    const product = makeProductFixture();
    product.type = ProductType.SERVICE;
    const payload = buildShopifyCreateInput(product);
    for (const v of payload.variants) {
      expect(v.requires_shipping).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// pushProductToShopify — integration of the gates + create flow
// ---------------------------------------------------------------------------

describe('pushProductToShopify', () => {
  it('creates junction rows for every returned Shopify variant on success', async () => {
    const product = makeProductFixture();
    const fake = makeFakeDb({ product, existingJunction: null });

    createProductMock.mockResolvedValue({
      id: 'shopify-prod-1',
      variants: [
        { id: 'sv-1', inventory_item_id: 'ii-1', sku: 'SKU-A' },
        { id: 'sv-2', inventory_item_id: 'ii-2', sku: 'SKU-B' },
      ],
      images: [],
    });

    const result = await pushProductToShopify(fake.db, 'store-1', 'prod-1');

    expect(result.outcome).toBe('created');
    expect(result.shopifyProductId).toBe('shopify-prod-1');
    expect(fake.rows).toHaveLength(2);
    expect(fake.rows[0]).toMatchObject({
      productId: 'prod-1',
      shopifyStoreId: 'store-1',
      shopifyProductId: 'shopify-prod-1',
      shopifyVariantId: 'sv-1',
      inventoryItemId: 'ii-1',
      isPrimary: true,
    });
    expect(fake.rows[1]).toMatchObject({
      shopifyVariantId: 'sv-2',
      inventoryItemId: 'ii-2',
    });
  });

  it('skips when the product already has a Shopify listing on this store', async () => {
    const product = makeProductFixture();
    const fake = makeFakeDb({
      product,
      existingJunction: { id: 'existing-junction' },
    });

    const result = await pushProductToShopify(fake.db, 'store-1', 'prod-1');

    expect(result.outcome).toBe('skipped');
    expect(result.reason).toMatch(/already has a Shopify listing/);
    expect(createProductMock).not.toHaveBeenCalled();
    expect(fake.rows).toHaveLength(0);
  });

  it('returns outcome=error with the Shopify message when createProduct throws', async () => {
    const product = makeProductFixture();
    const fake = makeFakeDb({ product, existingJunction: null });

    createProductMock.mockRejectedValue(
      new ShopifyApiError(422, 'Shopify POST /products.json → 422: invalid weight unit'),
    );

    const result = await pushProductToShopify(fake.db, 'store-1', 'prod-1');

    expect(result.outcome).toBe('error');
    expect(result.reason).toMatch(/invalid weight unit/);
    expect(fake.rows).toHaveLength(0);
  });

  it('includes product gallery images in the create payload', async () => {
    const product = makeProductFixture();
    product.images = [
      {
        url: 'https://cdn.example.com/p1-primary.jpg',
        altText: 'front',
        isPrimary: true,
        sortOrder: 0,
        createdAt: new Date('2026-01-01'),
      },
      {
        url: 'https://cdn.example.com/p1-secondary.jpg',
        altText: null,
        isPrimary: false,
        sortOrder: 1,
        createdAt: new Date('2026-01-02'),
      },
    ];
    const fake = makeFakeDb({ product, existingJunction: null });

    createProductMock.mockResolvedValue({
      id: 'shopify-prod-1',
      variants: [
        { id: 'sv-1', inventory_item_id: 'ii-1', sku: 'SKU-A' },
        { id: 'sv-2', inventory_item_id: 'ii-2', sku: 'SKU-B' },
      ],
      images: [
        { id: 'si-1', position: 1, src: 'https://cdn.shopify.com/.../1.jpg' },
        { id: 'si-2', position: 2, src: 'https://cdn.shopify.com/.../2.jpg' },
      ],
    });

    await pushProductToShopify(fake.db, 'store-1', 'prod-1');

    // Payload to Shopify carries the gallery in primary→sortOrder order.
    const sent = createProductMock.mock.calls[0][0];
    expect(sent.images).toEqual([
      { src: 'https://cdn.example.com/p1-primary.jpg', alt: 'front' },
      { src: 'https://cdn.example.com/p1-secondary.jpg' },
    ]);
    // No per-variant image was set, so no PUT goes out.
    expect(updateVariantImageMock).not.toHaveBeenCalled();
  });

  it('assigns variant image_ids via PUT after the create when variants have imageUrl', async () => {
    const product = makeProductFixture();
    // Variant A reuses a gallery image; variant B has its own.
    product.images = [
      {
        url: 'https://cdn.example.com/shared.jpg',
        altText: null,
        isPrimary: true,
        sortOrder: 0,
        createdAt: new Date('2026-01-01'),
      },
    ];
    product.variants[0].imageUrl = 'https://cdn.example.com/shared.jpg';
    product.variants[1].imageUrl = 'https://cdn.example.com/variant-b.jpg';

    const fake = makeFakeDb({ product, existingJunction: null });
    createProductMock.mockResolvedValue({
      id: 'shopify-prod-1',
      variants: [
        { id: 'sv-1', inventory_item_id: 'ii-1', sku: 'SKU-A' },
        { id: 'sv-2', inventory_item_id: 'ii-2', sku: 'SKU-B' },
      ],
      // Shopify echoes back two images in the order we sent them (gallery
      // pos 1, then the appended variant-only image at pos 2).
      images: [
        { id: 'si-1', position: 1, src: 'https://cdn.shopify.com/.../1.jpg' },
        { id: 'si-2', position: 2, src: 'https://cdn.shopify.com/.../2.jpg' },
      ],
    });

    await pushProductToShopify(fake.db, 'store-1', 'prod-1');

    // sent payload: 1 gallery + 1 appended variant image = 2 images, deduped.
    const sent = createProductMock.mock.calls[0][0];
    expect(sent.images).toHaveLength(2);
    expect(sent.images[0].src).toBe('https://cdn.example.com/shared.jpg');
    expect(sent.images[1].src).toBe('https://cdn.example.com/variant-b.jpg');

    // PUT goes out once per variant — both have imageUrl set in this case.
    expect(updateVariantImageMock).toHaveBeenCalledTimes(2);
    expect(updateVariantImageMock).toHaveBeenCalledWith('sv-1', 'si-1');
    expect(updateVariantImageMock).toHaveBeenCalledWith('sv-2', 'si-2');
  });

  it('does not roll back the create if updateVariantImage fails', async () => {
    const product = makeProductFixture();
    product.variants[0].imageUrl = 'https://cdn.example.com/a.jpg';
    const fake = makeFakeDb({ product, existingJunction: null });

    createProductMock.mockResolvedValue({
      id: 'shopify-prod-1',
      variants: [
        { id: 'sv-1', inventory_item_id: 'ii-1', sku: 'SKU-A' },
        { id: 'sv-2', inventory_item_id: 'ii-2', sku: 'SKU-B' },
      ],
      images: [
        { id: 'si-1', position: 1, src: 'https://cdn.shopify.com/.../1.jpg' },
      ],
    });
    updateVariantImageMock.mockRejectedValueOnce(new Error('429 rate limited'));

    const result = await pushProductToShopify(fake.db, 'store-1', 'prod-1');

    // Product still created, junction rows still written. Just the per-
    // variant image_id assignment failed (logged + swallowed).
    expect(result.outcome).toBe('created');
    expect(fake.rows).toHaveLength(2);
    expect(updateVariantImageMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// buildShopifyImagePlan — exercises the gallery + variant-image dedup logic
// independently of the network/db path.
// ---------------------------------------------------------------------------

describe('buildShopifyImagePlan', () => {
  it('returns gallery images in (primary, sortOrder, createdAt) order from the loader', () => {
    // Loader pre-sorts; the plan just preserves that order verbatim.
    const product = makeProductFixture();
    product.images = [
      {
        url: 'https://x/primary.jpg',
        altText: 'first',
        isPrimary: true,
        sortOrder: 0,
        createdAt: new Date('2026-01-01'),
      },
      {
        url: 'https://x/secondary.jpg',
        altText: null,
        isPrimary: false,
        sortOrder: 1,
        createdAt: new Date('2026-01-02'),
      },
    ];
    const plan = buildShopifyImagePlan(product);
    expect(plan.images).toEqual([
      { src: 'https://x/primary.jpg', alt: 'first' },
      { src: 'https://x/secondary.jpg' },
    ]);
    expect(plan.variantImagePositionBySku.size).toBe(0);
  });

  it('maps a variant image that is already in the gallery to its existing position', () => {
    const product = makeProductFixture();
    product.images = [
      {
        url: 'https://x/shared.jpg',
        altText: null,
        isPrimary: true,
        sortOrder: 0,
        createdAt: new Date('2026-01-01'),
      },
    ];
    product.variants[0].imageUrl = 'https://x/shared.jpg';
    const plan = buildShopifyImagePlan(product);
    expect(plan.images).toHaveLength(1);
    expect(plan.variantImagePositionBySku.get('SKU-A')).toBe(1);
  });

  it('appends a variant-only image and assigns it a fresh position', () => {
    const product = makeProductFixture();
    product.images = [
      {
        url: 'https://x/main.jpg',
        altText: null,
        isPrimary: true,
        sortOrder: 0,
        createdAt: new Date('2026-01-01'),
      },
    ];
    product.variants[1].imageUrl = 'https://x/variant-b-only.jpg';
    const plan = buildShopifyImagePlan(product);
    expect(plan.images).toEqual([
      { src: 'https://x/main.jpg' },
      { src: 'https://x/variant-b-only.jpg' },
    ]);
    expect(plan.variantImagePositionBySku.get('SKU-B')).toBe(2);
  });
});
