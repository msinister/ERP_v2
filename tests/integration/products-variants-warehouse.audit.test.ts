import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditAction } from '@/generated/tenant';
import type { PrismaClient } from '@/generated/tenant';
import {
  archiveProduct,
  createProduct,
  updateProduct,
} from '@/server/services/products';
import {
  archiveVariant,
  createVariant,
  updateVariant,
} from '@/server/services/variants';
import {
  archiveWarehouse,
  createWarehouse,
  updateWarehouse,
} from '@/server/services/warehouse';
import { hasTenantDb, makeClient } from '../helpers/db';

// Regression guard for the Module 02 audit bug: CRUD ops in
// products/variants/warehouse services were silently skipping audit()
// because of a stale "// TODO: wire audit() once lib/audit exists"
// comment. This file exercises each mutating op and asserts a
// matching AuditLog row was written with the expected (action,
// entityType, entityId, userId).

const suite = hasTenantDb ? describe : describe.skip;

const TAG = 'TEST-MASTER-DATA-AUDIT';
const USER = `${TAG}-USER`;
const ctx = { userId: USER };

// Schema input types are z.infer<schema> (= output type, defaults
// applied), so callers must pass `type`/`tracksInventory`/`active`
// even though the underlying zod schema would fill them. These
// builders centralize the post-defaults shape.
const buildProductInput = (sku: string, name: string) => ({
  sku,
  name,
  type: 'SIMPLE' as const,
  tracksInventory: true,
  active: true,
  hazmat: false,
});
const buildVariantInput = (productId: string, sku: string) => ({
  productId,
  sku,
  active: true,
});
const buildWarehouseInput = (code: string, name: string) => ({
  code,
  name,
  active: true,
});

suite('Products/Variants/Warehouse — audit emission', () => {
  let db: PrismaClient;

  beforeAll(async () => {
    db = makeClient();
  });

  beforeEach(async () => {
    await wipe(db);
  });

  afterAll(async () => {
    await wipe(db);
    await db.$disconnect();
  });

  // ---- Product ---------------------------------------------------------

  it('createProduct emits CREATE audit row', async () => {
    const p = await createProduct(
      db,
      buildProductInput(`${TAG}-P-CREATE`, `${TAG} P create`),
      ctx,
    );
    const rows = await db.auditLog.findMany({
      where: { entityType: 'Product', entityId: p.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe(AuditAction.CREATE);
    expect(rows[0].userId).toBe(USER);
    expect(rows[0].beforeJson).toBeNull();
    expect(rows[0].afterJson).not.toBeNull();
    expect(p.defaultVariant).toBeNull();
  });

  it('createProduct seeds default variant when defaultVariant is provided + audits both', async () => {
    const sku = `${TAG}-P-SEED`;
    const p = await createProduct(
      db,
      {
        ...buildProductInput(sku, `${TAG} P seed`),
        defaultVariant: { sku, name: 'Default' },
      },
      ctx,
    );
    expect(p.defaultVariant).not.toBeNull();
    expect(p.defaultVariant!.sku).toBe(sku);
    expect(p.defaultVariant!.productId).toBe(p.id);

    // Variant row was actually written.
    const variantRow = await db.productVariant.findUnique({
      where: { sku },
    });
    expect(variantRow).not.toBeNull();
    expect(variantRow!.id).toBe(p.defaultVariant!.id);

    // Both Product and ProductVariant CREATE audit rows emitted in the
    // same transaction.
    const productAudits = await db.auditLog.findMany({
      where: { entityType: 'Product', entityId: p.id },
    });
    const variantAudits = await db.auditLog.findMany({
      where: { entityType: 'ProductVariant', entityId: p.defaultVariant!.id },
    });
    expect(productAudits).toHaveLength(1);
    expect(productAudits[0].action).toBe(AuditAction.CREATE);
    expect(variantAudits).toHaveLength(1);
    expect(variantAudits[0].action).toBe(AuditAction.CREATE);
    expect(variantAudits[0].userId).toBe(USER);
  });

  it('updateProduct emits UPDATE audit row with before+after populated', async () => {
    const p = await createProduct(
      db,
      buildProductInput(`${TAG}-P-UPDATE`, `${TAG} P update`),
      ctx,
    );
    await updateProduct(db, p.id, { name: `${TAG} P update renamed` }, ctx);
    const rows = await db.auditLog.findMany({
      where: { entityType: 'Product', entityId: p.id, action: AuditAction.UPDATE },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(USER);
    expect(rows[0].beforeJson).not.toBeNull();
    expect(rows[0].afterJson).not.toBeNull();
  });

  it('archiveProduct emits DELETE audit row; after.deletedAt populated', async () => {
    const p = await createProduct(
      db,
      buildProductInput(`${TAG}-P-ARCHIVE`, `${TAG} P archive`),
      ctx,
    );
    const archived = await archiveProduct(db, p.id, ctx);
    expect(archived.deletedAt).not.toBeNull();
    const rows = await db.auditLog.findMany({
      where: { entityType: 'Product', entityId: p.id, action: AuditAction.DELETE },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(USER);
    expect(rows[0].beforeJson).not.toBeNull();
    expect(rows[0].afterJson).not.toBeNull();
    const after = rows[0].afterJson as { deletedAt: string | null };
    expect(after.deletedAt).not.toBeNull();
  });

  // ---- ProductVariant --------------------------------------------------

  it('createVariant emits CREATE audit row', async () => {
    const p = await createProduct(
      db,
      buildProductInput(`${TAG}-V-CREATE-P`, `${TAG} V create parent`),
      ctx,
    );
    const v = await createVariant(
      db,
      buildVariantInput(p.id, `${TAG}-V-CREATE`),
      ctx,
    );
    const rows = await db.auditLog.findMany({
      where: { entityType: 'ProductVariant', entityId: v.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe(AuditAction.CREATE);
    expect(rows[0].userId).toBe(USER);
    expect(rows[0].beforeJson).toBeNull();
    expect(rows[0].afterJson).not.toBeNull();
  });

  it('updateVariant emits UPDATE audit row with before+after populated', async () => {
    const p = await createProduct(
      db,
      buildProductInput(`${TAG}-V-UPDATE-P`, `${TAG} V update parent`),
      ctx,
    );
    const v = await createVariant(
      db,
      buildVariantInput(p.id, `${TAG}-V-UPDATE`),
      ctx,
    );
    await updateVariant(db, v.id, { color: 'Red' }, ctx);
    const rows = await db.auditLog.findMany({
      where: { entityType: 'ProductVariant', entityId: v.id, action: AuditAction.UPDATE },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(USER);
    expect(rows[0].beforeJson).not.toBeNull();
    expect(rows[0].afterJson).not.toBeNull();
  });

  it('archiveVariant emits DELETE audit row; after.deletedAt populated', async () => {
    const p = await createProduct(
      db,
      buildProductInput(`${TAG}-V-ARCHIVE-P`, `${TAG} V archive parent`),
      ctx,
    );
    const v = await createVariant(
      db,
      buildVariantInput(p.id, `${TAG}-V-ARCHIVE`),
      ctx,
    );
    const archived = await archiveVariant(db, v.id, ctx);
    expect(archived.deletedAt).not.toBeNull();
    const rows = await db.auditLog.findMany({
      where: { entityType: 'ProductVariant', entityId: v.id, action: AuditAction.DELETE },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(USER);
    expect(rows[0].beforeJson).not.toBeNull();
    const after = rows[0].afterJson as { deletedAt: string | null };
    expect(after.deletedAt).not.toBeNull();
  });

  // ---- Warehouse -------------------------------------------------------

  it('createWarehouse emits CREATE audit row', async () => {
    const w = await createWarehouse(
      db,
      buildWarehouseInput(`${TAG}-W-CREATE`, `${TAG} W create`),
      ctx,
    );
    const rows = await db.auditLog.findMany({
      where: { entityType: 'Warehouse', entityId: w.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe(AuditAction.CREATE);
    expect(rows[0].userId).toBe(USER);
    expect(rows[0].beforeJson).toBeNull();
    expect(rows[0].afterJson).not.toBeNull();
  });

  it('updateWarehouse emits UPDATE audit row with before+after populated', async () => {
    const w = await createWarehouse(
      db,
      buildWarehouseInput(`${TAG}-W-UPDATE`, `${TAG} W update`),
      ctx,
    );
    await updateWarehouse(db, w.id, { name: `${TAG} W update renamed` }, ctx);
    const rows = await db.auditLog.findMany({
      where: { entityType: 'Warehouse', entityId: w.id, action: AuditAction.UPDATE },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(USER);
    expect(rows[0].beforeJson).not.toBeNull();
    expect(rows[0].afterJson).not.toBeNull();
  });

  it('archiveWarehouse emits DELETE audit row; after.deletedAt populated', async () => {
    const w = await createWarehouse(
      db,
      buildWarehouseInput(`${TAG}-W-ARCHIVE`, `${TAG} W archive`),
      ctx,
    );
    const archived = await archiveWarehouse(db, w.id, ctx);
    expect(archived.deletedAt).not.toBeNull();
    const rows = await db.auditLog.findMany({
      where: { entityType: 'Warehouse', entityId: w.id, action: AuditAction.DELETE },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(USER);
    expect(rows[0].beforeJson).not.toBeNull();
    const after = rows[0].afterJson as { deletedAt: string | null };
    expect(after.deletedAt).not.toBeNull();
  });
});

// FK-safe wipe scoped to TAG-owned entities.
// Order: AuditLog (by userId — no FK) → ProductVariant (FK to Product)
// → Product (by SKU prefix) → Warehouse (by code prefix).
async function wipe(db: PrismaClient): Promise<void> {
  // 1. AuditLog rows from this suite (userId scope is sufficient and
  //    cleaner than enumerating entityIds; userId is dedicated to the
  //    test tag).
  await db.auditLog.deleteMany({ where: { userId: USER } });

  // 2. ProductVariants whose parent Product is tag-scoped, OR whose
  //    own SKU is tag-scoped (covers any orphan variants).
  const ourProducts = await db.product.findMany({
    where: { sku: { startsWith: `${TAG}-` } },
    select: { id: true },
  });
  const productIds = ourProducts.map((p) => p.id);
  if (productIds.length > 0) {
    await db.productVariant.deleteMany({ where: { productId: { in: productIds } } });
  }
  await db.productVariant.deleteMany({ where: { sku: { startsWith: `${TAG}-` } } });

  // 3. Products.
  await db.product.deleteMany({ where: { sku: { startsWith: `${TAG}-` } } });

  // 4. Warehouses.
  await db.warehouse.deleteMany({ where: { code: { startsWith: `${TAG}-` } } });
}
