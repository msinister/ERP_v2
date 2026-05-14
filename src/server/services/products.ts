import { AuditAction, Prisma } from '@/generated/tenant';
import type {
  PrismaClient,
  Product,
  ProductVariant,
} from '@/generated/tenant';
import { audit, type AuditContext } from '@/lib/audit/audit';
import {
  productCreateSchema,
  productUpdateSchema,
  type ProductCreateInput,
  type ProductUpdateInput,
} from '@/lib/validation/product';

// TODO: wire requirePermission() once lib/permissions exists

export type CreateProductResult = Product & {
  defaultVariant: ProductVariant | null;
};

export async function createProduct(
  db: PrismaClient,
  input: ProductCreateInput,
  ctx?: AuditContext,
): Promise<CreateProductResult> {
  const parsed = productCreateSchema.parse(input);
  const { defaultVariant: seed, ...productData } = parsed;
  return db.$transaction(async (tx) => {
    const product = await tx.product.create({ data: productData });
    await audit(tx, {
      action: AuditAction.CREATE,
      entityType: 'Product',
      entityId: product.id,
      after: product,
      ctx,
    });

    let defaultVariant: ProductVariant | null = null;
    if (seed) {
      defaultVariant = await tx.productVariant.create({
        data: {
          productId: product.id,
          sku: seed.sku,
          name: seed.name,
        },
      });
      await audit(tx, {
        action: AuditAction.CREATE,
        entityType: 'ProductVariant',
        entityId: defaultVariant.id,
        after: defaultVariant,
        ctx,
      });
    }

    return { ...product, defaultVariant };
  });
}

export async function updateProduct(
  db: PrismaClient,
  id: string,
  input: ProductUpdateInput,
  ctx?: AuditContext,
): Promise<Product> {
  const data = productUpdateSchema.parse(input);
  return db.$transaction(async (tx) => {
    const before = await tx.product.findUnique({ where: { id } });
    if (!before) throw new Error(`Product not found: ${id}`);
    const after = await tx.product.update({ where: { id }, data });
    await audit(tx, {
      action: AuditAction.UPDATE,
      entityType: 'Product',
      entityId: id,
      before,
      after,
      ctx,
    });
    return after;
  });
}

export async function getProduct(
  db: PrismaClient,
  id: string,
): Promise<Product | null> {
  return db.product.findFirst({ where: { id, deletedAt: null } });
}

export async function getProductBySku(
  db: PrismaClient,
  sku: string,
): Promise<Product | null> {
  return db.product.findFirst({ where: { sku, deletedAt: null } });
}

export async function listProducts(
  db: PrismaClient,
  opts: { skip?: number; take?: number; includeArchived?: boolean } = {},
): Promise<Product[]> {
  const { skip = 0, take = 50, includeArchived = false } = opts;
  return db.product.findMany({
    where: includeArchived ? {} : { deletedAt: null },
    skip,
    take,
    orderBy: { createdAt: 'desc' },
  });
}

// =============================================================================
// Paginated list for the catalog GUI. Joins variants → inventory so the
// table can render aggregate on-hand / available without a per-row N+1.
// =============================================================================

export type ProductStatusFilter = 'active' | 'all' | 'archived';

export type ProductListFilters = {
  q?: string; // substring on name OR sku (case-insensitive)
  status?: ProductStatusFilter; // default 'active'
  brand?: string;
  category?: string;
  skip?: number;
  take?: number;
};

export type ProductListRow = Product & {
  inventoryAgg: {
    onHand: Prisma.Decimal;
    reserved: Prisma.Decimal;
    available: Prisma.Decimal;
  };
  variantCount: number;
};

function productWhere(
  filters: Omit<ProductListFilters, 'skip' | 'take'>,
): Prisma.ProductWhereInput {
  const { q, status = 'active', brand, category } = filters;
  // Status maps directly to a (deletedAt, active) pair:
  //   active   → not archived, active=true (default UX)
  //   all      → not archived, no active filter (inactive but live OK)
  //   archived → soft-deleted only
  const statusWhere: Prisma.ProductWhereInput =
    status === 'archived'
      ? { deletedAt: { not: null } }
      : status === 'all'
        ? { deletedAt: null }
        : { deletedAt: null, active: true };
  return {
    ...statusWhere,
    ...(brand
      ? { brand: { equals: brand, mode: 'insensitive' as const } }
      : {}),
    ...(category
      ? { category: { equals: category, mode: 'insensitive' as const } }
      : {}),
    ...(q
      ? {
          OR: [
            { name: { contains: q, mode: 'insensitive' as const } },
            { sku: { contains: q, mode: 'insensitive' as const } },
          ],
        }
      : {}),
  };
}

export async function listProductsPaged(
  db: PrismaClient,
  filters: ProductListFilters = {},
): Promise<{ rows: ProductListRow[]; total: number }> {
  const { skip = 0, take = 25, ...rest } = filters;
  const where = productWhere(rest);
  const [products, total] = await Promise.all([
    db.product.findMany({
      where,
      include: {
        variants: {
          where: { deletedAt: null },
          select: {
            id: true,
            inventory: { select: { onHand: true, reserved: true } },
          },
        },
      },
      // Active rows on top, then alpha by name. Same intent as the
      // customers list (active-first) so eyeballs land on what's
      // operationally relevant first.
      orderBy: [{ active: 'desc' }, { name: 'asc' }],
      skip,
      take,
    }),
    db.product.count({ where }),
  ]);

  const zero = new Prisma.Decimal(0);
  const rows: ProductListRow[] = products.map((p) => {
    let onHand = zero;
    let reserved = zero;
    for (const v of p.variants) {
      for (const inv of v.inventory) {
        onHand = onHand.plus(inv.onHand);
        reserved = reserved.plus(inv.reserved);
      }
    }
    const rawAvailable = onHand.minus(reserved);
    const available = rawAvailable.lessThan(0) ? zero : rawAvailable;
    return {
      ...p,
      inventoryAgg: { onHand, reserved, available },
      variantCount: p.variants.length,
    };
  });

  return { rows, total };
}

// Distinct brand / category values from existing products. Powers the
// filter dropdowns without an admin-managed lookup table — pilot data
// volume is small enough that DISTINCT is cheap.
export async function listProductBrands(db: PrismaClient): Promise<string[]> {
  const rows = await db.product.findMany({
    where: { deletedAt: null, brand: { not: null } },
    distinct: ['brand'],
    select: { brand: true },
    orderBy: { brand: 'asc' },
  });
  return rows.map((r) => r.brand).filter((b): b is string => b != null && b !== '');
}

export async function listProductCategories(
  db: PrismaClient,
): Promise<string[]> {
  const rows = await db.product.findMany({
    where: { deletedAt: null, category: { not: null } },
    distinct: ['category'],
    select: { category: true },
    orderBy: { category: 'asc' },
  });
  return rows
    .map((r) => r.category)
    .filter((c): c is string => c != null && c !== '');
}

export async function archiveProduct(
  db: PrismaClient,
  id: string,
  ctx?: AuditContext,
): Promise<Product> {
  return db.$transaction(async (tx) => {
    const before = await tx.product.findUnique({ where: { id } });
    if (!before) throw new Error(`Product not found: ${id}`);
    const after = await tx.product.update({
      where: { id },
      data: { deletedAt: new Date(), active: false },
    });
    await audit(tx, {
      action: AuditAction.DELETE,
      entityType: 'Product',
      entityId: id,
      before,
      after,
      ctx,
    });
    return after;
  });
}
