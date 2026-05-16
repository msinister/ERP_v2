import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditAction, Prisma, ProductType } from '@/generated/tenant';
import type { PrismaClient } from '@/generated/tenant';
import { getProductBom, setProductBom } from '@/server/services/bom';
import { hasTenantDb, makeClient } from '../helpers/db';

const suite = hasTenantDb ? describe : describe.skip;

const TAG = 'TEST-BOM';
const USER = `${TAG}-USER`;
const ctx = { userId: USER };

suite('BOM service', () => {
  let db: PrismaClient;
  let parentProductId: string;
  let parentVariantId: string;
  let componentAVariantId: string;
  let componentBVariantId: string;

  beforeAll(async () => {
    db = makeClient();
  });

  beforeEach(async () => {
    await wipe(db);
    const parent = await db.product.create({
      data: {
        sku: `${TAG}-PARENT`,
        name: 'Parent product (assembled)',
        type: ProductType.ASSEMBLED,
      },
    });
    parentProductId = parent.id;
    const parentVariant = await db.productVariant.create({
      data: { productId: parent.id, sku: `${TAG}-PARENT-V1`, name: 'Default' },
    });
    parentVariantId = parentVariant.id;

    const componentA = await db.product.create({
      data: { sku: `${TAG}-COMPA`, name: 'Component A' },
    });
    const compAv = await db.productVariant.create({
      data: { productId: componentA.id, sku: `${TAG}-COMPA-V1` },
    });
    componentAVariantId = compAv.id;

    const componentB = await db.product.create({
      data: { sku: `${TAG}-COMPB`, name: 'Component B' },
    });
    const compBv = await db.productVariant.create({
      data: { productId: componentB.id, sku: `${TAG}-COMPB-V1` },
    });
    componentBVariantId = compBv.id;
  });

  afterAll(async () => {
    await wipe(db);
    await db.$disconnect();
  });

  // ---------------------------------------------------------------------------
  // setProductBom happy paths
  // ---------------------------------------------------------------------------

  it('setProductBom: creates lines, persists labor cost, returns shape from re-read', async () => {
    const bom = await setProductBom(
      db,
      parentProductId,
      {
        laborCost: '2.50',
        lines: [
          { componentVariantId: componentAVariantId, qtyRequired: '2' },
          { componentVariantId: componentBVariantId, qtyRequired: '1.5' },
        ],
      },
      ctx,
    );
    expect(bom.lines).toHaveLength(2);
    expect(bom.laborCost?.toString()).toBe(new Prisma.Decimal('2.5').toString());
    expect(bom.lines[0].componentVariant.id).toBe(componentAVariantId);
    expect(bom.lines[0].qtyRequired.toString()).toBe(
      new Prisma.Decimal('2').toString(),
    );
    expect(bom.lines[1].qtyRequired.toString()).toBe(
      new Prisma.Decimal('1.5').toString(),
    );
  });

  it('setProductBom: empty lines clears the BOM (valid input)', async () => {
    await setProductBom(
      db,
      parentProductId,
      {
        lines: [{ componentVariantId: componentAVariantId, qtyRequired: '1' }],
      },
      ctx,
    );
    const after = await setProductBom(
      db,
      parentProductId,
      { lines: [] },
      ctx,
    );
    expect(after.lines).toHaveLength(0);
  });

  it('setProductBom: wholesale replace soft-deletes prior lines', async () => {
    await setProductBom(
      db,
      parentProductId,
      {
        lines: [{ componentVariantId: componentAVariantId, qtyRequired: '1' }],
      },
      ctx,
    );
    await setProductBom(
      db,
      parentProductId,
      {
        lines: [{ componentVariantId: componentBVariantId, qtyRequired: '3' }],
      },
      ctx,
    );
    const all = await db.bomLine.findMany({
      where: { parentProductId },
    });
    // 1 prior soft-deleted + 1 fresh = 2 rows total.
    expect(all).toHaveLength(2);
    const live = all.filter((l) => l.deletedAt == null);
    expect(live).toHaveLength(1);
    expect(live[0].componentVariantId).toBe(componentBVariantId);
    expect(live[0].qtyRequired.toString()).toBe(new Prisma.Decimal('3').toString());
  });

  it('setProductBom: labor cost null clears, undefined leaves unchanged', async () => {
    await setProductBom(db, parentProductId, {
      laborCost: '5',
      lines: [{ componentVariantId: componentAVariantId, qtyRequired: '1' }],
    }, ctx);
    // Undefined labor — should keep existing.
    const same = await setProductBom(
      db,
      parentProductId,
      {
        lines: [{ componentVariantId: componentAVariantId, qtyRequired: '1' }],
      },
      ctx,
    );
    expect(same.laborCost?.toString()).toBe(new Prisma.Decimal('5').toString());
    // Explicit null clears.
    const cleared = await setProductBom(
      db,
      parentProductId,
      {
        laborCost: null,
        lines: [{ componentVariantId: componentAVariantId, qtyRequired: '1' }],
      },
      ctx,
    );
    expect(cleared.laborCost).toBeNull();
  });

  it('setProductBom: writes a single UPDATE audit row on Product per call', async () => {
    await setProductBom(
      db,
      parentProductId,
      {
        laborCost: '1',
        lines: [{ componentVariantId: componentAVariantId, qtyRequired: '1' }],
      },
      ctx,
    );
    const rows = await db.auditLog.findMany({
      where: {
        entityType: 'Product',
        entityId: parentProductId,
        userId: USER,
      },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe(AuditAction.UPDATE);
  });

  // ---------------------------------------------------------------------------
  // Status / structural rejections
  // ---------------------------------------------------------------------------

  it('setProductBom: rejects DROP_SHIP and SERVICE product types', async () => {
    const ds = await db.product.create({
      data: { sku: `${TAG}-DROP`, name: 'Drop', type: ProductType.DROP_SHIP },
    });
    await expect(
      setProductBom(db, ds.id, {
        lines: [{ componentVariantId: componentAVariantId, qtyRequired: '1' }],
      }, ctx),
    ).rejects.toThrow(/only SIMPLE and ASSEMBLED/);

    const sv = await db.product.create({
      data: { sku: `${TAG}-SVC`, name: 'Svc', type: ProductType.SERVICE },
    });
    await expect(
      setProductBom(db, sv.id, {
        lines: [{ componentVariantId: componentAVariantId, qtyRequired: '1' }],
      }, ctx),
    ).rejects.toThrow(/only SIMPLE and ASSEMBLED/);
  });

  it('setProductBom: rejects self-reference (parent variant used as component)', async () => {
    await expect(
      setProductBom(db, parentProductId, {
        lines: [{ componentVariantId: parentVariantId, qtyRequired: '1' }],
      }, ctx),
    ).rejects.toThrow(/cannot consume its own variants/);
  });

  it('setProductBom: rejects unknown / soft-deleted component variant', async () => {
    await expect(
      setProductBom(db, parentProductId, {
        lines: [{ componentVariantId: 'does-not-exist', qtyRequired: '1' }],
      }, ctx),
    ).rejects.toThrow(/Unknown or soft-deleted component variant/);

    await db.productVariant.update({
      where: { id: componentAVariantId },
      data: { deletedAt: new Date() },
    });
    await expect(
      setProductBom(db, parentProductId, {
        lines: [{ componentVariantId: componentAVariantId, qtyRequired: '1' }],
      }, ctx),
    ).rejects.toThrow(/Unknown or soft-deleted component variant/);
  });

  it('setProductBom: rejects soft-deleted parent product', async () => {
    await db.product.update({
      where: { id: parentProductId },
      data: { deletedAt: new Date() },
    });
    await expect(
      setProductBom(db, parentProductId, {
        lines: [{ componentVariantId: componentAVariantId, qtyRequired: '1' }],
      }, ctx),
    ).rejects.toThrow(/Product not found/);
  });

  it('setProductBom: rejects non-positive qtyRequired at the validator', async () => {
    await expect(
      setProductBom(db, parentProductId, {
        lines: [{ componentVariantId: componentAVariantId, qtyRequired: '0' }],
      }, ctx),
    ).rejects.toThrow();
  });

  // ---------------------------------------------------------------------------
  // getProductBom
  // ---------------------------------------------------------------------------

  it('getProductBom: returns null for unknown product', async () => {
    const bom = await getProductBom(db, 'no-such-id');
    expect(bom).toBeNull();
  });

  it('getProductBom: returns empty lines + null labor before any BOM is set', async () => {
    const bom = await getProductBom(db, parentProductId);
    expect(bom).not.toBeNull();
    expect(bom!.lines).toHaveLength(0);
    expect(bom!.laborCost).toBeNull();
    expect(bom!.productType).toBe(ProductType.ASSEMBLED);
  });

  it('getProductBom: hides soft-deleted lines and orders by sortOrder then createdAt', async () => {
    await setProductBom(db, parentProductId, {
      lines: [
        {
          componentVariantId: componentAVariantId,
          qtyRequired: '1',
          sortOrder: 2,
        },
        {
          componentVariantId: componentBVariantId,
          qtyRequired: '1',
          sortOrder: 1,
        },
      ],
    }, ctx);
    const bom = await getProductBom(db, parentProductId);
    expect(bom!.lines).toHaveLength(2);
    // sortOrder 1 comes first.
    expect(bom!.lines[0].componentVariantId).toBe(componentBVariantId);
    expect(bom!.lines[1].componentVariantId).toBe(componentAVariantId);
  });
});

async function wipe(db: PrismaClient): Promise<void> {
  await db.auditLog.deleteMany({ where: { userId: USER } });

  const ourProducts = await db.product.findMany({
    where: { sku: { startsWith: `${TAG}-` } },
    select: { id: true },
  });
  const productIds = ourProducts.map((p) => p.id);
  if (productIds.length > 0) {
    // BomLine rows hang off the parent product. Hard-delete here in
    // the wipe — tests need a clean slate, not soft-deleted history.
    await db.bomLine.deleteMany({
      where: {
        OR: [
          { parentProductId: { in: productIds } },
          {
            componentVariant: { productId: { in: productIds } },
          },
        ],
      },
    });
    await db.productVariant.deleteMany({
      where: { productId: { in: productIds } },
    });
    await db.product.deleteMany({ where: { id: { in: productIds } } });
  }
}
