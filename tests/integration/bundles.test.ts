import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  PriceResolutionRule,
  Prisma,
  ProductType,
  SalesOrderStatus,
} from '@/generated/tenant';
import type { PrismaClient } from '@/generated/tenant';
import {
  addSalesOrderLines,
  closeSalesOrder,
  confirmSalesOrder,
  createSalesOrder,
  dispatchSalesOrder,
} from '@/server/services/salesOrders';
import { setProductBom } from '@/server/services/bom';
import { receiveInventory } from '@/server/services/movements';
import { hasTenantDb, makeClient } from '../helpers/db';
import { upsertTestCustomer } from '../helpers/customerStub';
import { upsertTestWarehouse } from '../helpers/warehouseStub';

const suite = hasTenantDb ? describe : describe.skip;

const TAG = 'TEST-BUNDLE';
const USER = `${TAG}-USER`;
const ctx = { userId: USER };

suite('Bundles — explode on SO entry', () => {
  let db: PrismaClient;
  let customerId: string;
  let warehouseId: string;
  let bundleProductId: string;
  let bundleVariantId: string;
  let compAProductId: string;
  let compAVariantId: string;
  let compBProductId: string;
  let compBVariantId: string;

  beforeAll(async () => {
    db = makeClient();
    const cust = await upsertTestCustomer(db, {
      code: `${TAG}-CUST`,
      name: 'Bundle Test Cust',
    });
    customerId = cust.id;
    const wh = await upsertTestWarehouse(db, {
      code: `${TAG}-WH`,
      name: 'Bundle Test WH',
    });
    warehouseId = wh.id;

    const bundle = await db.product.upsert({
      where: { sku: `${TAG}-BNDL` },
      create: {
        sku: `${TAG}-BNDL`,
        name: 'Bundle product',
        type: ProductType.BUNDLE,
        tracksInventory: false,
        basePrice: new Prisma.Decimal('35'),
      },
      update: {
        active: true,
        deletedAt: null,
        type: ProductType.BUNDLE,
        tracksInventory: false,
        basePrice: new Prisma.Decimal('35'),
      },
    });
    bundleProductId = bundle.id;
    const bv = await db.productVariant.upsert({
      where: { sku: `${TAG}-BNDL-V1` },
      create: {
        productId: bundle.id,
        sku: `${TAG}-BNDL-V1`,
        name: 'Default',
      },
      update: { productId: bundle.id, active: true, deletedAt: null },
    });
    bundleVariantId = bv.id;

    // Component A — basePrice $10
    const compA = await db.product.upsert({
      where: { sku: `${TAG}-COMPA` },
      create: {
        sku: `${TAG}-COMPA`,
        name: 'Component A',
        basePrice: new Prisma.Decimal('10'),
      },
      update: { active: true, deletedAt: null, basePrice: new Prisma.Decimal('10') },
    });
    compAProductId = compA.id;
    const cav = await db.productVariant.upsert({
      where: { sku: `${TAG}-COMPA-V1` },
      create: { productId: compA.id, sku: `${TAG}-COMPA-V1` },
      update: { productId: compA.id, active: true, deletedAt: null },
    });
    compAVariantId = cav.id;

    // Component B — basePrice $30
    const compB = await db.product.upsert({
      where: { sku: `${TAG}-COMPB` },
      create: {
        sku: `${TAG}-COMPB`,
        name: 'Component B',
        basePrice: new Prisma.Decimal('30'),
      },
      update: { active: true, deletedAt: null, basePrice: new Prisma.Decimal('30') },
    });
    compBProductId = compB.id;
    const cbv = await db.productVariant.upsert({
      where: { sku: `${TAG}-COMPB-V1` },
      create: { productId: compB.id, sku: `${TAG}-COMPB-V1` },
      update: { productId: compB.id, active: true, deletedAt: null },
    });
    compBVariantId = cbv.id;
  });

  beforeEach(async () => {
    await wipe(db);
    // Reset basePrices to the documented baseline so tests that mutate
    // them don't leak state if their cleanup is skipped by an early
    // assertion failure.
    await db.product.update({
      where: { id: bundleProductId },
      data: { basePrice: new Prisma.Decimal('35') },
    });
    await db.product.update({
      where: { id: compAProductId },
      data: { basePrice: new Prisma.Decimal('10') },
    });
    await db.product.update({
      where: { id: compBProductId },
      data: { basePrice: new Prisma.Decimal('30') },
    });
    // Reset the bundle BOM: 2x Component A + 1x Component B. With
    // basePrices $10 and $30, weights are $20 and $30 → A gets 40%
    // ($14) and B gets 60% ($21) of the $35 bundle.
    await setProductBom(db, bundleProductId, {
      lines: [
        { componentVariantId: compAVariantId, qtyRequired: '2' },
        { componentVariantId: compBVariantId, qtyRequired: '1' },
      ],
    });
  });

  afterAll(async () => {
    await wipe(db);
    await db.bomLine.deleteMany({
      where: {
        OR: [
          { parentProduct: { sku: { startsWith: `${TAG}-` } } },
          { componentVariant: { product: { sku: { startsWith: `${TAG}-` } } } },
        ],
      },
    });
    await db.productVariant.deleteMany({
      where: { product: { sku: { startsWith: `${TAG}-` } } },
    });
    await db.product.deleteMany({
      where: { sku: { startsWith: `${TAG}-` } },
    });
    await db.warehouse.deleteMany({ where: { id: warehouseId } });
    await db.customer.deleteMany({ where: { id: customerId } });
    await db.$disconnect();
  });

  // ---------------------------------------------------------------------------
  // Allocation accuracy
  // ---------------------------------------------------------------------------

  it('explodes a bundle into component lines with allocated prices', async () => {
    const so = await createSalesOrder(
      db,
      {
        customerId,
        warehouseId,
        lines: [
          {
            variantId: bundleVariantId,
            warehouseId,
            qtyOrdered: '1',
          },
        ],
      },
      ctx,
    );
    // 2 component lines created, bundle line itself NOT inserted.
    expect(so.lines).toHaveLength(2);
    const aLine = so.lines.find((l) => l.variantId === compAVariantId)!;
    const bLine = so.lines.find((l) => l.variantId === compBVariantId)!;
    expect(aLine).toBeDefined();
    expect(bLine).toBeDefined();

    // Both lines share the same bundleGroupId + bundleSourceProductId.
    expect(aLine.bundleGroupId).not.toBeNull();
    expect(aLine.bundleGroupId).toBe(bLine.bundleGroupId);
    expect(aLine.bundleSourceProductId).toBe(bundleProductId);
    expect(bLine.bundleSourceProductId).toBe(bundleProductId);

    // priceRule = BUNDLE_ALLOCATED on both.
    expect(aLine.priceRule).toBe(PriceResolutionRule.BUNDLE_ALLOCATED);
    expect(bLine.priceRule).toBe(PriceResolutionRule.BUNDLE_ALLOCATED);

    // customerNote auto-populated.
    expect(aLine.customerNote).toBe(`Part of ${TAG}-BNDL bundle`);
    expect(bLine.customerNote).toBe(`Part of ${TAG}-BNDL bundle`);

    // Component qtys = bomLine.qtyRequired × bundleQty (=1)
    expect(aLine.qtyOrdered.toString()).toBe(new Prisma.Decimal('2').toString());
    expect(bLine.qtyOrdered.toString()).toBe(new Prisma.Decimal('1').toString());

    // Allocated unit prices: A → $7 (line total $14), B → $21 (line total $21).
    // Sum = $35 = bundle price.
    expect(aLine.unitPrice.toString()).toBe(new Prisma.Decimal('7').toString());
    expect(bLine.unitPrice.toString()).toBe(new Prisma.Decimal('21').toString());
    const sum = aLine.unitPrice
      .times(aLine.qtyOrdered)
      .plus(bLine.unitPrice.times(bLine.qtyOrdered));
    expect(sum.toString()).toBe(new Prisma.Decimal('35').toString());
  });

  it('scales allocations with bundle qty', async () => {
    // bundle qty 3 → A line qty 6 ($42), B line qty 3 ($63), sum $105.
    const so = await createSalesOrder(
      db,
      {
        customerId,
        warehouseId,
        lines: [
          {
            variantId: bundleVariantId,
            warehouseId,
            qtyOrdered: '3',
          },
        ],
      },
      ctx,
    );
    const aLine = so.lines.find((l) => l.variantId === compAVariantId)!;
    const bLine = so.lines.find((l) => l.variantId === compBVariantId)!;
    expect(aLine.qtyOrdered.toString()).toBe(new Prisma.Decimal('6').toString());
    expect(bLine.qtyOrdered.toString()).toBe(new Prisma.Decimal('3').toString());
    // Per-unit prices stay at $7 / $21 (allocation is per-unit).
    expect(aLine.unitPrice.toString()).toBe(new Prisma.Decimal('7').toString());
    expect(bLine.unitPrice.toString()).toBe(new Prisma.Decimal('21').toString());
  });

  it('operator manualUnitPrice on the bundle line overrides bundle price', async () => {
    // Override bundle price to $50. A weight 20 / total 50 → 40% → $20.
    // B weight 30 → 60% → $30. Per-unit A = $10, B = $30. Sum = $50.
    const so = await createSalesOrder(
      db,
      {
        customerId,
        warehouseId,
        lines: [
          {
            variantId: bundleVariantId,
            warehouseId,
            qtyOrdered: '1',
            manualUnitPrice: '50',
          },
        ],
      },
      ctx,
    );
    const aLine = so.lines.find((l) => l.variantId === compAVariantId)!;
    const bLine = so.lines.find((l) => l.variantId === compBVariantId)!;
    expect(aLine.unitPrice.toString()).toBe(new Prisma.Decimal('10').toString());
    expect(bLine.unitPrice.toString()).toBe(new Prisma.Decimal('30').toString());
  });

  it('last component absorbs Decimal residual so sum == bundle total exactly', async () => {
    // Build a 3-component bundle where the per-component allocation
    // doesn't divide evenly. 3 components with equal weight, bundle
    // price $10 → each gets $3.33333..., residual goes to last.
    const compC = await db.product.upsert({
      where: { sku: `${TAG}-COMPC` },
      create: {
        sku: `${TAG}-COMPC`,
        name: 'Component C',
        basePrice: new Prisma.Decimal('10'),
      },
      update: {
        active: true,
        deletedAt: null,
        basePrice: new Prisma.Decimal('10'),
      },
    });
    const ccv = await db.productVariant.upsert({
      where: { sku: `${TAG}-COMPC-V1` },
      create: { productId: compC.id, sku: `${TAG}-COMPC-V1` },
      update: { productId: compC.id, active: true, deletedAt: null },
    });

    // Temporarily reset bundle to a "3 equal components" shape.
    await setProductBom(db, bundleProductId, {
      lines: [
        { componentVariantId: compAVariantId, qtyRequired: '1' },
        { componentVariantId: compBVariantId, qtyRequired: '1' },
        { componentVariantId: ccv.id, qtyRequired: '1' },
      ],
    });

    // Set all three components to the same basePrice so weights are
    // equal, then override bundle price to $10.
    await db.product.update({
      where: { id: compAProductId },
      data: { basePrice: new Prisma.Decimal('10') },
    });
    await db.product.update({
      where: { id: compBProductId },
      data: { basePrice: new Prisma.Decimal('10') },
    });

    const so = await createSalesOrder(
      db,
      {
        customerId,
        warehouseId,
        lines: [
          {
            variantId: bundleVariantId,
            warehouseId,
            qtyOrdered: '1',
            manualUnitPrice: '10',
          },
        ],
      },
      ctx,
    );
    expect(so.lines).toHaveLength(3);
    const lineTotals = so.lines.map((l) => l.unitPrice.times(l.qtyOrdered));
    const sum = lineTotals.reduce(
      (acc, t) => acc.plus(t),
      new Prisma.Decimal(0),
    );
    // Sum must equal bundle total exactly — residual-to-last is what
    // gives us this guarantee.
    expect(sum.toString()).toBe(new Prisma.Decimal('10').toString());

    // Reset the basePrices + bundle BOM so subsequent tests stay
    // predictable (beforeEach resets BOM too).
    await db.product.update({
      where: { id: compAProductId },
      data: { basePrice: new Prisma.Decimal('10') },
    });
    await db.product.update({
      where: { id: compBProductId },
      data: { basePrice: new Prisma.Decimal('30') },
    });
  });

  // ---------------------------------------------------------------------------
  // Pass-through behavior — non-bundle inputs aren't touched
  // ---------------------------------------------------------------------------

  it('non-bundle SO line passes through with normal pricing', async () => {
    const so = await createSalesOrder(
      db,
      {
        customerId,
        warehouseId,
        lines: [
          {
            variantId: compAVariantId,
            warehouseId,
            qtyOrdered: '4',
          },
        ],
      },
      ctx,
    );
    expect(so.lines).toHaveLength(1);
    expect(so.lines[0].variantId).toBe(compAVariantId);
    expect(so.lines[0].bundleGroupId).toBeNull();
    expect(so.lines[0].bundleSourceProductId).toBeNull();
    expect(so.lines[0].priceRule).not.toBe(
      PriceResolutionRule.BUNDLE_ALLOCATED,
    );
    expect(so.lines[0].unitPrice.toString()).toBe(
      new Prisma.Decimal('10').toString(),
    );
  });

  // ---------------------------------------------------------------------------
  // addSalesOrderLines explodes too
  // ---------------------------------------------------------------------------

  it('addSalesOrderLines explodes bundles on a CONFIRMED SO', async () => {
    // Start with a plain Component A line, confirm, then add a bundle.
    await stockBin(compAVariantId, '50');
    await stockBin(compBVariantId, '50');
    const so = await createSalesOrder(
      db,
      {
        customerId,
        warehouseId,
        lines: [
          {
            variantId: compAVariantId,
            warehouseId,
            qtyOrdered: '1',
          },
        ],
      },
      ctx,
    );
    await confirmSalesOrder(db, so.id, ctx);
    const after = await addSalesOrderLines(
      db,
      so.id,
      {
        lines: [
          {
            variantId: bundleVariantId,
            warehouseId,
            qtyOrdered: '1',
          },
        ],
      },
      ctx,
    );
    // 1 original + 2 component lines from the bundle = 3 total.
    expect(after.lines.filter((l) => l.deletedAt == null)).toHaveLength(3);
    const bundleLines = after.lines.filter((l) => l.bundleGroupId != null);
    expect(bundleLines).toHaveLength(2);
    const sum = bundleLines.reduce(
      (acc, l) => acc.plus(l.unitPrice.times(l.qtyOrdered)),
      new Prisma.Decimal(0),
    );
    expect(sum.toString()).toBe(new Prisma.Decimal('35').toString());
  });

  // ---------------------------------------------------------------------------
  // Invoice line copy
  // ---------------------------------------------------------------------------

  it('invoice generation copies bundleGroupId + bundleSourceProductId', async () => {
    await stockBin(compAVariantId, '20');
    await stockBin(compBVariantId, '20');
    const so = await createSalesOrder(
      db,
      {
        customerId,
        warehouseId,
        lines: [
          {
            variantId: bundleVariantId,
            warehouseId,
            qtyOrdered: '1',
          },
        ],
      },
      ctx,
    );
    await confirmSalesOrder(db, so.id, ctx);
    await dispatchSalesOrder(db, so.id, ctx);
    await closeSalesOrder(db, so.id, undefined, ctx);

    const invoice = await db.invoice.findFirstOrThrow({
      where: { salesOrderId: so.id },
      include: { lines: true },
    });
    expect(invoice.lines).toHaveLength(2);
    expect(invoice.lines.every((l) => l.bundleGroupId != null)).toBe(true);
    expect(
      invoice.lines.every((l) => l.bundleSourceProductId === bundleProductId),
    ).toBe(true);
    // All invoice lines from one bundle share the same groupId.
    const groupIds = new Set(invoice.lines.map((l) => l.bundleGroupId));
    expect(groupIds.size).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // Error paths
  // ---------------------------------------------------------------------------

  it('rejects bundle with no BOM defined', async () => {
    // Wipe BOM.
    await setProductBom(db, bundleProductId, { lines: [] });
    await expect(
      createSalesOrder(
        db,
        {
          customerId,
          warehouseId,
          lines: [
            { variantId: bundleVariantId, warehouseId, qtyOrdered: '1' },
          ],
        },
        ctx,
      ),
    ).rejects.toThrow(/no components defined/);
  });

  it('rejects nested bundles', async () => {
    // Make Component A itself a BUNDLE, give it a BOM, then try to use
    // it inside the parent bundle's BOM.
    await db.product.update({
      where: { id: compAProductId },
      data: { type: ProductType.BUNDLE, tracksInventory: false },
    });
    // setProductBom requires the parent to have a BOM with at least
    // some component — give A a stub component referencing B so the
    // nested-bundle check has something to find on the parent.
    await setProductBom(db, compAProductId, {
      lines: [{ componentVariantId: compBVariantId, qtyRequired: '1' }],
    });

    await expect(
      createSalesOrder(
        db,
        {
          customerId,
          warehouseId,
          lines: [
            { variantId: bundleVariantId, warehouseId, qtyOrdered: '1' },
          ],
        },
        ctx,
      ),
    ).rejects.toThrow(/nested bundle/);

    // Restore Component A to SIMPLE so other tests don't trip.
    await db.bomLine.deleteMany({ where: { parentProductId: compAProductId } });
    await db.product.update({
      where: { id: compAProductId },
      data: { type: ProductType.SIMPLE, tracksInventory: true },
    });
  });

  it('rejects bundle with a component lacking basePrice', async () => {
    await db.product.update({
      where: { id: compAProductId },
      data: { basePrice: null },
    });
    await expect(
      createSalesOrder(
        db,
        {
          customerId,
          warehouseId,
          lines: [
            { variantId: bundleVariantId, warehouseId, qtyOrdered: '1' },
          ],
        },
        ctx,
      ),
    ).rejects.toThrow(/has no basePrice/);
    // Restore.
    await db.product.update({
      where: { id: compAProductId },
      data: { basePrice: new Prisma.Decimal('10') },
    });
  });

  it('rejects bundle with no basePrice and no manualUnitPrice', async () => {
    await db.product.update({
      where: { id: bundleProductId },
      data: { basePrice: null },
    });
    await expect(
      createSalesOrder(
        db,
        {
          customerId,
          warehouseId,
          lines: [
            { variantId: bundleVariantId, warehouseId, qtyOrdered: '1' },
          ],
        },
        ctx,
      ),
    ).rejects.toThrow(/cannot allocate/);
    // Restore.
    await db.product.update({
      where: { id: bundleProductId },
      data: { basePrice: new Prisma.Decimal('35') },
    });
  });

  async function stockBin(variantId: string, qty: string): Promise<void> {
    await receiveInventory(db, {
      variantId,
      warehouseId,
      qty,
      reference: `${TAG}-SEED`,
    });
  }
});

async function wipe(db: PrismaClient): Promise<void> {
  await db.auditLog.deleteMany({ where: { userId: USER } });

  const productIds = (
    await db.product.findMany({
      where: { sku: { startsWith: `${TAG}-` } },
      select: { id: true },
    })
  ).map((p) => p.id);
  const variantIds = (
    await db.productVariant.findMany({
      where: { product: { sku: { startsWith: `${TAG}-` } } },
      select: { id: true },
    })
  ).map((v) => v.id);
  const customerIds = (
    await db.customer.findMany({
      where: { code: { startsWith: `${TAG}-` } },
      select: { id: true },
    })
  ).map((c) => c.id);

  // SO + invoice tree.
  const soIds = (
    await db.salesOrder.findMany({
      where: { customerId: { in: customerIds } },
      select: { id: true },
    })
  ).map((s) => s.id);
  if (soIds.length > 0) {
    const invIds = (
      await db.invoice.findMany({
        where: { salesOrderId: { in: soIds } },
        select: { id: true },
      })
    ).map((i) => i.id);
    if (invIds.length > 0) {
      const jes = await db.journalEntry.findMany({
        where: { entityType: 'Invoice', entityId: { in: invIds } },
        select: { id: true },
      });
      const jeIds = jes.map((j) => j.id);
      if (jeIds.length > 0) {
        await db.journalEntryLine.deleteMany({
          where: { journalEntryId: { in: jeIds } },
        });
        await db.journalEntry.deleteMany({ where: { id: { in: jeIds } } });
      }
      await db.creditApplication.deleteMany({
        where: { invoiceId: { in: invIds } },
      });
      await db.invoiceLine.deleteMany({
        where: { invoiceId: { in: invIds } },
      });
      await db.invoice.deleteMany({ where: { id: { in: invIds } } });
    }
    await db.salesOrderLine.deleteMany({
      where: { salesOrderId: { in: soIds } },
    });
    await db.salesOrder.deleteMany({ where: { id: { in: soIds } } });
  }

  if (variantIds.length > 0) {
    await db.fifoConsumption.deleteMany({
      where: { layer: { variantId: { in: variantIds } } },
    });
    await db.fifoLayer.deleteMany({
      where: { variantId: { in: variantIds } },
    });
    await db.inventoryMovement.deleteMany({
      where: { variantId: { in: variantIds } },
    });
    await db.inventoryItem.deleteMany({
      where: { variantId: { in: variantIds } },
    });
  }
  if (productIds.length > 0) {
    await db.bomLine.deleteMany({
      where: { parentProductId: { in: productIds } },
    });
  }
}
