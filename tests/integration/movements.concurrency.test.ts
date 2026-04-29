import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Prisma } from '@/generated/tenant';
import type { PrismaClient } from '@/generated/tenant';
import {
  consumeInventory,
  receiveInventory,
} from '@/server/services/movements';
import { hasTenantDb, makeClient } from '../helpers/db';

const suite = hasTenantDb ? describe : describe.skip;

suite('movements concurrency (advisory lock)', () => {
  let db: PrismaClient;
  let warehouseId: string;
  let productId: string;
  let variantId: string;

  beforeAll(async () => {
    db = makeClient();
    const wh = await db.warehouse.upsert({
      where: { code: 'TEST-WH-CONC' },
      create: { code: 'TEST-WH-CONC', name: 'Concurrency Test Warehouse' },
      update: { active: true, deletedAt: null },
    });
    warehouseId = wh.id;

    const product = await db.product.upsert({
      where: { sku: 'TEST-PROD-CONC' },
      create: { sku: 'TEST-PROD-CONC', name: 'Concurrency Test Product' },
      update: { active: true, deletedAt: null },
    });
    productId = product.id;

    const variant = await db.productVariant.upsert({
      where: { sku: 'TEST-PROD-CONC-V1' },
      create: {
        productId: product.id,
        sku: 'TEST-PROD-CONC-V1',
        name: 'Concurrency Test Variant',
      },
      update: { productId: product.id, active: true, deletedAt: null },
    });
    variantId = variant.id;
  });

  beforeEach(async () => {
    await db.inventoryMovement.deleteMany({
      where: { variantId, warehouseId },
    });
    await db.inventoryItem.deleteMany({
      where: { variantId, warehouseId },
    });
  });

  afterAll(async () => {
    await db.inventoryMovement.deleteMany({ where: { variantId } });
    await db.inventoryItem.deleteMany({ where: { variantId } });
    await db.productVariant.deleteMany({ where: { id: variantId } });
    await db.product.deleteMany({ where: { id: productId } });
    await db.warehouse.deleteMany({ where: { id: warehouseId } });
    await db.$disconnect();
  });

  it('serializes simultaneous CONSUMEs so onHand never goes negative', async () => {
    // Seed 10 units on hand.
    await receiveInventory(db, {
      variantId,
      warehouseId,
      qty: '10',
      reference: 'CONC-SEED',
    });

    // Five concurrent consumes of 3 each. Total demand = 15, supply = 10.
    // With pg_advisory_xact_lock, requests are forced to serialize: at most
    // 3 can succeed (9 units), the 4th sees onHand=1 < 3 and throws, the 5th
    // sees onHand=1 < 3 and throws. Without the lock multiple txs could
    // observe onHand=10 simultaneously and over-consume.
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) =>
        consumeInventory(db, {
          variantId,
          warehouseId,
          qty: '3',
          reference: `CONC-${i}`,
        }),
      ),
    );

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    // Exactly three should succeed (3+3+3=9 from a stock of 10).
    expect(fulfilled).toHaveLength(3);
    expect(rejected).toHaveLength(2);
    for (const r of rejected) {
      expect((r as PromiseRejectedResult).reason.message).toMatch(
        /insufficient stock/i,
      );
    }

    const item = await db.inventoryItem.findUnique({
      where: { variantId_warehouseId: { variantId, warehouseId } },
    });
    expect(item).not.toBeNull();
    expect(item!.onHand.greaterThanOrEqualTo(0)).toBe(true);

    // The cached onHand must match the movement-table truth.
    const agg = await db.inventoryMovement.aggregate({
      where: { variantId, warehouseId },
      _sum: { qty: true },
    });
    const ledgerSum = agg._sum.qty ?? new Prisma.Decimal(0);
    expect(item!.onHand.toString()).toBe(ledgerSum.toString());
    expect(ledgerSum.toString()).toBe(new Prisma.Decimal(1).toString());
  });
});
