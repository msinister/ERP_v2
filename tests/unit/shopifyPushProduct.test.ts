import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma, ProductType } from '@/generated/tenant';

// ---------------------------------------------------------------------------
// Module mocks — declared with vi.mock BEFORE importing the unit under test
// so the imports inside shopifySync resolve to these stubs.
// ---------------------------------------------------------------------------

const createProductMock = vi.fn();

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
    constructor() {
      this.createProduct = createProductMock;
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
        vendorProducts: [{ vendor: { name: 'PrimaryVendorCo' } }],
      },
      { sku: 'SKU-B', vendorProducts: [] },
    ],
    tags: [
      { tag: { name: 'kratom' } },
      { tag: { name: 'wholesale' } },
    ],
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
});
