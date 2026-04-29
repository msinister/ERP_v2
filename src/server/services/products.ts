import type { PrismaClient, Product } from '@/generated/tenant';
import {
  productCreateSchema,
  productUpdateSchema,
  type ProductCreateInput,
  type ProductUpdateInput,
} from '@/lib/validation/product';

// TODO: wire requirePermission() once lib/permissions exists
// TODO: wire audit() once lib/audit exists

export async function createProduct(
  db: PrismaClient,
  input: ProductCreateInput,
): Promise<Product> {
  const data = productCreateSchema.parse(input);
  return db.product.create({ data });
}

export async function updateProduct(
  db: PrismaClient,
  id: string,
  input: ProductUpdateInput,
): Promise<Product> {
  const data = productUpdateSchema.parse(input);
  return db.product.update({ where: { id }, data });
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

export async function archiveProduct(
  db: PrismaClient,
  id: string,
): Promise<Product> {
  return db.product.update({
    where: { id },
    data: { deletedAt: new Date(), active: false },
  });
}