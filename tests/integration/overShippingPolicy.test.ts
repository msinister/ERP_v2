import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { Prisma } from '@/generated/tenant';
import type { PrismaClient } from '@/generated/tenant';
import {
  closeSalesOrder,
  confirmSalesOrder,
  createSalesOrder,
  dispatchSalesOrder,
  updateSalesOrderLineQtyShipped,
} from '@/server/services/salesOrders';
import { receiveInventory } from '@/server/services/movements';
import { setSetting } from '@/server/services/settings';
import {
  SETTING_KEYS,
  overShippingPolicyValueSchema,
} from '@/lib/validation/settings';
import { getOverShippingPolicy } from '@/server/services/overShipping';
import { wipeInvoiceArtifactsForSOs } from '../helpers/wipeInvoiceArtifacts';
import { hasTenantDb, makeClient } from '../helpers/db';
import { upsertTestCustomer } from '../helpers/customerStub';
import { upsertTestWarehouse } from '../helpers/warehouseStub';

const suite = hasTenantDb ? describe : describe.skip;

const TAG = 'TEST-OVERSHIP';
const USER = `${TAG}-USER`;
const ctx = { userId: USER };

suite('overShippingPolicy', () => {
  let db: PrismaClient;
  let customerId: string;
  let warehouseId: string;
  let productId: string;
  let variantId: string;

  beforeAll(async () => {
    db = makeClient();
    const cust = await upsertTestCustomer(db, {
      code: `${TAG}-CUST`,
      name: 'Over-ship test cust',
    });
    customerId = cust.id;
    const wh = await upsertTestWarehouse(db, {
      code: `${TAG}-WH`,
      name: 'Over-ship test wh',
    });
    warehouseId = wh.id;
    const product = await db.product.upsert({
      where: { sku: `${TAG}-PROD` },
      create: {
        sku: `${TAG}-PROD`,
        name: 'Over-ship test product',
        basePrice: new Prisma.Decimal('10'),
      },
      update: {
        active: true,
        deletedAt: null,
        basePrice: new Prisma.Decimal('10'),
      },
    });
    productId = product.id;
    const variant = await db.productVariant.upsert({
      where: { sku: `${TAG}-PROD-V1` },
      create: { productId: product.id, sku: `${TAG}-PROD-V1`, name: 'V1' },
      update: { productId: product.id, active: true, deletedAt: null },
    });
    variantId = variant.id;
  });

  beforeEach(async () => {
    await wipe(db);
  });

  afterEach(async () => {
    // Reset the policy after every test so suite order doesn't matter.
    // Using setSetting (with the USER ctx) writes an audit row that the
    // beforeEach wipe sweeps up on the next test.
    await setSetting(
      db,
      SETTING_KEYS.OVER_SHIPPING_POLICY,
      { policy: 'CONFIRM' },
      overShippingPolicyValueSchema,
      ctx,
    );
  });

  afterAll(async () => {
    await wipe(db);
    await db.productVariant.deleteMany({ where: { id: variantId } });
    await db.product.deleteMany({ where: { id: productId } });
    await db.warehouse.deleteMany({ where: { id: warehouseId } });
    await db.customer.deleteMany({ where: { id: customerId } });
    await db.$disconnect();
  });

  async function setPolicy(policy: 'ALLOW' | 'CONFIRM' | 'BLOCK') {
    await setSetting(
      db,
      SETTING_KEYS.OVER_SHIPPING_POLICY,
      { policy },
      overShippingPolicyValueSchema,
      ctx,
    );
  }

  async function stockBin(qty: string): Promise<void> {
    await receiveInventory(db, {
      variantId,
      warehouseId,
      qty,
      reference: `${TAG}-SEED`,
    });
  }

  function createInput(qty = '5') {
    return {
      customerId,
      warehouseId,
      lines: [{ variantId, warehouseId, qtyOrdered: qty }],
    };
  }

  // ---------------------------------------------------------------------------
  // getOverShippingPolicy
  // ---------------------------------------------------------------------------

  it('defensive default is CONFIRM when the Setting row is missing', async () => {
    // No Setting row yet (or wiped by the test infra). The helper
    // should fall through to CONFIRM rather than throw.
    await db.setting.deleteMany({
      where: { key: SETTING_KEYS.OVER_SHIPPING_POLICY },
    });
    expect(await getOverShippingPolicy(db)).toBe('CONFIRM');
  });

  it('roundtrips ALLOW / CONFIRM / BLOCK via setSetting', async () => {
    await setPolicy('ALLOW');
    expect(await getOverShippingPolicy(db)).toBe('ALLOW');
    await setPolicy('CONFIRM');
    expect(await getOverShippingPolicy(db)).toBe('CONFIRM');
    await setPolicy('BLOCK');
    expect(await getOverShippingPolicy(db)).toBe('BLOCK');
  });

  // ---------------------------------------------------------------------------
  // updateSalesOrderLineQtyShipped — policy matrix
  // ---------------------------------------------------------------------------

  it('BLOCK: rejects qtyShipped > qtyOrdered', async () => {
    await setPolicy('BLOCK');
    await stockBin('20');
    const so = await createSalesOrder(db, createInput('5'), ctx);
    await confirmSalesOrder(db, so.id, ctx);
    await expect(
      updateSalesOrderLineQtyShipped(
        db,
        so.id,
        so.lines[0].id,
        { qtyShipped: '7' },
        ctx,
      ),
    ).rejects.toThrow(/exceeds qtyOrdered/);
  });

  it('CONFIRM: accepts qtyShipped > qtyOrdered (UI dialog is the speed bump)', async () => {
    await setPolicy('CONFIRM');
    await stockBin('20');
    const so = await createSalesOrder(db, createInput('5'), ctx);
    await confirmSalesOrder(db, so.id, ctx);
    const after = await updateSalesOrderLineQtyShipped(
      db,
      so.id,
      so.lines[0].id,
      { qtyShipped: '7' },
      ctx,
    );
    expect(after.qtyShipped.toString()).toBe(new Prisma.Decimal('7').toString());
  });

  it('ALLOW: accepts qtyShipped > qtyOrdered with no prompt path', async () => {
    await setPolicy('ALLOW');
    await stockBin('20');
    const so = await createSalesOrder(db, createInput('5'), ctx);
    await confirmSalesOrder(db, so.id, ctx);
    const after = await updateSalesOrderLineQtyShipped(
      db,
      so.id,
      so.lines[0].id,
      { qtyShipped: '7' },
      ctx,
    );
    expect(after.qtyShipped.toString()).toBe(new Prisma.Decimal('7').toString());
  });

  it('any policy: still accepts qtyShipped <= qtyOrdered', async () => {
    await setPolicy('BLOCK'); // worst case
    await stockBin('20');
    const so = await createSalesOrder(db, createInput('5'), ctx);
    await confirmSalesOrder(db, so.id, ctx);
    const after = await updateSalesOrderLineQtyShipped(
      db,
      so.id,
      so.lines[0].id,
      { qtyShipped: '3' },
      ctx,
    );
    expect(after.qtyShipped.toString()).toBe(new Prisma.Decimal('3').toString());
  });

  // ---------------------------------------------------------------------------
  // closeSalesOrder payload path
  // ---------------------------------------------------------------------------

  it('close payload with over-ship: BLOCK rejects', async () => {
    await setPolicy('BLOCK');
    await stockBin('20');
    const so = await createSalesOrder(db, createInput('5'), ctx);
    await confirmSalesOrder(db, so.id, ctx);
    await dispatchSalesOrder(db, so.id, ctx);
    await expect(
      closeSalesOrder(
        db,
        so.id,
        { lines: [{ id: so.lines[0].id, qtyShipped: '6' }] },
        ctx,
      ),
    ).rejects.toThrow(/exceeds qtyOrdered/);
  });

  it('close payload with over-ship: ALLOW accepts and persists qtyShipped > qtyOrdered', async () => {
    await setPolicy('ALLOW');
    // Stock enough to cover the over-ship.
    await stockBin('20');
    const so = await createSalesOrder(db, createInput('5'), ctx);
    await confirmSalesOrder(db, so.id, ctx);
    await dispatchSalesOrder(db, so.id, ctx);
    await closeSalesOrder(
      db,
      so.id,
      { lines: [{ id: so.lines[0].id, qtyShipped: '6' }] },
      ctx,
    );
    const line = await db.salesOrderLine.findUniqueOrThrow({
      where: { id: so.lines[0].id },
    });
    expect(line.qtyShipped.toString()).toBe(new Prisma.Decimal('6').toString());
  });
});

async function wipe(db: PrismaClient): Promise<void> {
  await db.auditLog.deleteMany({ where: { userId: USER } });
  const ourSos = await db.salesOrder.findMany({
    where: { customer: { code: { startsWith: `${TAG}-` } } },
    select: { id: true },
  });
  const soIds = ourSos.map((s) => s.id);
  if (soIds.length > 0) {
    await wipeInvoiceArtifactsForSOs(db, soIds);
    await db.salesOrderLine.deleteMany({
      where: { salesOrderId: { in: soIds } },
    });
    await db.salesOrder.deleteMany({ where: { id: { in: soIds } } });
  }
  // Sweep every inventory movement / FIFO layer that touched our test
  // variants. reference-prefix matching misses CONSUME / RECEIVE rows
  // (which carry SO numbers or auto-generated refs), so scope by
  // variantId — our suite uniquely owns variants under TAG.
  const ourVariantIds = (
    await db.productVariant.findMany({
      where: { product: { sku: { startsWith: `${TAG}-` } } },
      select: { id: true },
    })
  ).map((v) => v.id);
  if (ourVariantIds.length > 0) {
    await db.fifoConsumption.deleteMany({
      where: {
        movement: { variantId: { in: ourVariantIds } },
      },
    });
    await db.fifoLayer.deleteMany({
      where: { variantId: { in: ourVariantIds } },
    });
    await db.inventoryMovement.deleteMany({
      where: { variantId: { in: ourVariantIds } },
    });
    await db.inventoryItem.deleteMany({
      where: { variantId: { in: ourVariantIds } },
    });
  }
}
