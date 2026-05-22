import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AuditAction,
  InventoryMovementType,
  Prisma,
  PriceResolutionRule,
  SalesOrderStatus,
} from '@/generated/tenant';
import type { PrismaClient } from '@/generated/tenant';
import {
  addSalesOrderLines,
  closeSalesOrder,
  confirmSalesOrder,
  createSalesOrder,
  dispatchSalesOrder,
  reopenSalesOrder,
  undispatchSalesOrder,
  updateSalesOrderLineFields,
  updateSalesOrderLineQtyShipped,
} from '@/server/services/salesOrders';
import { recordPayment } from '@/server/services/payments';
import { arBalanceForCustomer } from '@/server/services/ar';
import { SalesOrderReopenBlockedError } from '@/lib/errors/credit';
import { receiveInventory } from '@/server/services/movements';
import { setSetting } from '@/server/services/settings';
import {
  SETTING_KEYS,
  overShippingPolicyValueSchema,
} from '@/lib/validation/settings';
import { wipeInvoiceArtifactsForSOs } from '../helpers/wipeInvoiceArtifacts';
import { hasTenantDb, makeClient } from '../helpers/db';
import { upsertTestCustomer } from '../helpers/customerStub';
import { upsertTestWarehouse } from '../helpers/warehouseStub';

const suite = hasTenantDb ? describe : describe.skip;

suite('SalesOrder lifecycle', () => {
  let db: PrismaClient;
  let customerId: string;
  let warehouseId: string;
  let productId: string;
  let variantId: string;
  let extraRepId: string; // a rep distinct from the customer's default

  beforeAll(async () => {
    db = makeClient();
    const c = await upsertTestCustomer(db, {
      code: 'TEST-CUST-SO-LC',
      name: 'Test SO Customer',
    });
    customerId = c.id;
    const wh = await upsertTestWarehouse(db, {
      code: 'TEST-WH-SO-LC',
      name: 'Test SO Warehouse',
    });
    warehouseId = wh.id;
    const product = await db.product.upsert({
      where: { sku: 'TEST-PROD-SO-LC' },
      create: {
        sku: 'TEST-PROD-SO-LC',
        name: 'Test SO Product',
        basePrice: new Prisma.Decimal('9.99'),
      },
      update: {
        active: true,
        deletedAt: null,
        basePrice: new Prisma.Decimal('9.99'),
      },
    });
    productId = product.id;
    const variant = await db.productVariant.upsert({
      where: { sku: 'TEST-PROD-SO-LC-V1' },
      create: { productId: product.id, sku: 'TEST-PROD-SO-LC-V1', name: 'V1' },
      update: { productId: product.id, active: true, deletedAt: null },
    });
    variantId = variant.id;
    const rep = await db.salesRep.upsert({
      where: { code: 'TEST-SR-SO-LC' },
      create: { code: 'TEST-SR-SO-LC', name: 'SO LC Rep' },
      update: { active: true, deletedAt: null },
    });
    extraRepId = rep.id;
  });

  beforeEach(async () => {
    await wipe(db, { customerId, variantId, warehouseId });
  });

  afterAll(async () => {
    await wipe(db, { customerId, variantId, warehouseId });
    // After wipe removes the SOs referencing it, the test rep is safe to drop.
    await db.salesRep.deleteMany({ where: { code: 'TEST-SR-SO-LC' } });
    await db.productVariant.deleteMany({ where: { id: variantId } });
    await db.product.deleteMany({ where: { id: productId } });
    await db.warehouse.deleteMany({ where: { id: warehouseId } });
    await db.customer.deleteMany({ where: { id: customerId } });
    await db.$disconnect();
  });

  // Stock the bin so close can consume.
  async function stockBin(qty: string): Promise<void> {
    await receiveInventory(db, {
      variantId,
      warehouseId,
      qty,
      reference: 'TEST_SEED',
    });
  }

  function createInput(qty = '5', manualUnitPrice?: string) {
    return {
      customerId,
      warehouseId,
      lines: [
        {
          variantId,
          warehouseId,
          qtyOrdered: qty,
          ...(manualUnitPrice ? { manualUnitPrice } : {}),
        },
      ],
    };
  }

  it('createSalesOrder issues SO-YYYY-NNNNN, resolves base price, status DRAFT', async () => {
    const so = await createSalesOrder(db, createInput('5'));
    expect(so.number).toMatch(/^SO-\d{4}-\d{5}$/);
    expect(so.status).toBe(SalesOrderStatus.DRAFT);
    expect(so.lines).toHaveLength(1);
    expect(so.lines[0].priceRule).toBe(PriceResolutionRule.BASE_PRICE);
    expect(so.lines[0].unitPrice.toString()).toBe(new Prisma.Decimal('9.99').toString());
    expect(so.lines[0].qtyReserved.toString()).toBe(new Prisma.Decimal('0').toString());
    expect(so.lines[0].qtyShipped.toString()).toBe(new Prisma.Decimal('0').toString());
  });

  it('manualUnitPrice records MANUAL_OVERRIDE rule', async () => {
    const so = await createSalesOrder(db, createInput('3', '7.50'));
    expect(so.lines[0].priceRule).toBe(PriceResolutionRule.MANUAL_OVERRIDE);
    expect(so.lines[0].unitPrice.toString()).toBe(new Prisma.Decimal('7.50').toString());
  });

  it('createSalesOrder persists an explicit salesRepId; omitting it leaves null (inherit)', async () => {
    const withRep = await createSalesOrder(db, {
      ...createInput('1'),
      salesRepId: extraRepId,
    });
    expect(withRep.salesRepId).toBe(extraRepId);

    const withoutRep = await createSalesOrder(db, createInput('1'));
    expect(withoutRep.salesRepId).toBeNull();
  });

  it('SO numbering is monotonic across two creates', async () => {
    const a = await createSalesOrder(db, createInput('1'));
    const b = await createSalesOrder(db, createInput('1'));
    const [, yearA, seqA] = a.number.match(/^SO-(\d{4})-(\d{5})$/)!;
    const [, yearB, seqB] = b.number.match(/^SO-(\d{4})-(\d{5})$/)!;
    expect(yearA).toBe(yearB);
    // Other parallel test suites may bump the shared sales_order sequence
    // between A and B — assert strictly-greater rather than exactly +1.
    expect(parseInt(seqB, 10)).toBeGreaterThan(parseInt(seqA, 10));
  });

  it('DRAFT -> CONFIRMED bumps Reserved on the bin; OnHand untouched', async () => {
    await stockBin('20');
    const so = await createSalesOrder(db, createInput('5'));
    const inv0 = await db.inventoryItem.findUnique({
      where: { variantId_warehouseId: { variantId, warehouseId } },
    });
    expect(inv0!.onHand.toString()).toBe(new Prisma.Decimal('20').toString());
    expect(inv0!.reserved.toString()).toBe(new Prisma.Decimal('0').toString());

    const confirmed = await confirmSalesOrder(db, so.id);
    expect(confirmed.status).toBe(SalesOrderStatus.CONFIRMED);
    expect(confirmed.confirmedAt).not.toBeNull();
    expect(confirmed.lines[0].qtyReserved.toString()).toBe(
      new Prisma.Decimal('5').toString(),
    );

    const inv1 = await db.inventoryItem.findUnique({
      where: { variantId_warehouseId: { variantId, warehouseId } },
    });
    expect(inv1!.onHand.toString()).toBe(new Prisma.Decimal('20').toString());
    expect(inv1!.reserved.toString()).toBe(new Prisma.Decimal('5').toString());
  });

  it('CONFIRMED -> DISPATCHED has no inventory effect', async () => {
    await stockBin('20');
    const so = await createSalesOrder(db, createInput('5'));
    await confirmSalesOrder(db, so.id);
    const before = await db.inventoryItem.findUnique({
      where: { variantId_warehouseId: { variantId, warehouseId } },
    });
    const dispatched = await dispatchSalesOrder(db, so.id);
    expect(dispatched.status).toBe(SalesOrderStatus.DISPATCHED);
    const after = await db.inventoryItem.findUnique({
      where: { variantId_warehouseId: { variantId, warehouseId } },
    });
    expect(after!.onHand.toString()).toBe(before!.onHand.toString());
    expect(after!.reserved.toString()).toBe(before!.reserved.toString());
  });

  it('DISPATCHED -> CLOSED creates one CONSUME movement; OnHand drops, Reserved zeros', async () => {
    await stockBin('20');
    const so = await createSalesOrder(db, createInput('5'));
    await confirmSalesOrder(db, so.id);
    await dispatchSalesOrder(db, so.id);
    const closed = await closeSalesOrder(db, so.id, undefined);
    expect(closed.status).toBe(SalesOrderStatus.CLOSED);
    expect(closed.closedAt).not.toBeNull();
    expect(closed.lines[0].qtyShipped.toString()).toBe(new Prisma.Decimal('5').toString());
    expect(closed.lines[0].qtyReserved.toString()).toBe(new Prisma.Decimal('0').toString());

    const inv = await db.inventoryItem.findUnique({
      where: { variantId_warehouseId: { variantId, warehouseId } },
    });
    expect(inv!.onHand.toString()).toBe(new Prisma.Decimal('15').toString());
    expect(inv!.reserved.toString()).toBe(new Prisma.Decimal('0').toString());

    const movements = await db.inventoryMovement.findMany({
      where: { variantId, warehouseId, type: InventoryMovementType.CONSUME, reference: closed.number },
    });
    expect(movements).toHaveLength(1);
    expect(movements[0].qty.toString()).toBe(new Prisma.Decimal('-5').toString());
  });

  it('Pickup path: CONFIRMED -> CLOSED skips DISPATCHED legally', async () => {
    await stockBin('10');
    const so = await createSalesOrder(db, createInput('3'));
    await confirmSalesOrder(db, so.id);
    const closed = await closeSalesOrder(db, so.id, undefined);
    expect(closed.status).toBe(SalesOrderStatus.CLOSED);
    expect(closed.dispatchedAt).toBeNull();
    const inv = await db.inventoryItem.findUnique({
      where: { variantId_warehouseId: { variantId, warehouseId } },
    });
    expect(inv!.onHand.toString()).toBe(new Prisma.Decimal('7').toString());
    expect(inv!.reserved.toString()).toBe(new Prisma.Decimal('0').toString());
  });

  it('Insufficient stock at close throws AND emits an INSUFFICIENT_STOCK_AT_CLOSE audit row', async () => {
    await stockBin('2'); // only 2 in stock
    const so = await createSalesOrder(db, createInput('5'));
    await confirmSalesOrder(db, so.id);
    await dispatchSalesOrder(db, so.id);
    await expect(closeSalesOrder(db, so.id, undefined)).rejects.toThrow(/Insufficient stock/);

    const audits = await db.auditLog.findMany({
      where: { action: AuditAction.INSUFFICIENT_STOCK_AT_CLOSE, entityType: 'SalesOrder', entityId: so.id },
    });
    expect(audits).toHaveLength(1);
    const after = audits[0].afterJson as { qtyRequested?: string };
    expect(after.qtyRequested).toBe('5');

    // Status was rolled back with the failed tx — still DISPATCHED.
    const stillDispatched = await db.salesOrder.findUnique({ where: { id: so.id } });
    expect(stillDispatched!.status).toBe(SalesOrderStatus.DISPATCHED);
  });

  it('Partial close: per-line qtyShipped < qtyOrdered consumes only shipped qty and shorts the invoice', async () => {
    await stockBin('20');
    const so = await createSalesOrder(db, createInput('10'));
    await confirmSalesOrder(db, so.id);
    const lineId = so.lines[0].id;

    const closed = await closeSalesOrder(db, so.id, {
      lines: [{ id: lineId, qtyShipped: '7' }],
    });

    expect(closed.status).toBe(SalesOrderStatus.CLOSED);
    expect(closed.lines[0].qtyShipped.toString()).toBe(
      new Prisma.Decimal('7').toString(),
    );
    expect(closed.lines[0].qtyOrdered.toString()).toBe(
      new Prisma.Decimal('10').toString(),
    );
    expect(closed.lines[0].qtyReserved.toString()).toBe(
      new Prisma.Decimal('0').toString(),
    );

    // Consumed only the shipped qty — not the ordered qty.
    const movements = await db.inventoryMovement.findMany({
      where: {
        variantId,
        warehouseId,
        type: InventoryMovementType.CONSUME,
        reference: closed.number,
      },
    });
    expect(movements).toHaveLength(1);
    expect(movements[0].qty.toString()).toBe(
      new Prisma.Decimal('-7').toString(),
    );

    const inv = await db.inventoryItem.findUnique({
      where: { variantId_warehouseId: { variantId, warehouseId } },
    });
    expect(inv!.onHand.toString()).toBe(new Prisma.Decimal('13').toString());

    // Auto-invoice was billed on qtyShipped (7), not qtyOrdered (10).
    const invoice = await db.invoice.findUnique({
      where: { salesOrderId: so.id },
      include: { lines: true },
    });
    expect(invoice).not.toBeNull();
    expect(invoice!.lines).toHaveLength(1);
    expect(invoice!.lines[0].qty.toString()).toBe(
      new Prisma.Decimal('7').toString(),
    );
    expect(invoice!.lines[0].lineTotal.toString()).toBe(
      // 7 * 9.99 = 69.93
      new Prisma.Decimal('69.93').toString(),
    );
  });

  it('Close rejects qtyShipped > qtyOrdered when overShippingPolicy=BLOCK', async () => {
    // Same gate as the inline editor — defensive default is CONFIRM
    // (accept); flip to BLOCK to assert the historical reject path.
    // The dedicated overShippingPolicy.test.ts covers CONFIRM + ALLOW
    // accept paths for the close payload.
    await setSetting(
      db,
      SETTING_KEYS.OVER_SHIPPING_POLICY,
      { policy: 'BLOCK' },
      overShippingPolicyValueSchema,
    );
    try {
      await stockBin('20');
      const so = await createSalesOrder(db, createInput('5'));
      await confirmSalesOrder(db, so.id);
      const lineId = so.lines[0].id;

      await expect(
        closeSalesOrder(db, so.id, {
          lines: [{ id: lineId, qtyShipped: '6' }],
        }),
      ).rejects.toThrow(/exceeds qtyOrdered/);

      // SO still in CONFIRMED — close transaction rolled back.
      const stillOpen = await db.salesOrder.findUnique({ where: { id: so.id } });
      expect(stillOpen!.status).toBe(SalesOrderStatus.CONFIRMED);
    } finally {
      await setSetting(
        db,
        SETTING_KEYS.OVER_SHIPPING_POLICY,
        { policy: 'CONFIRM' },
        overShippingPolicyValueSchema,
      );
    }
  });

  it('Close rejects line id that does not belong to this SO', async () => {
    await stockBin('20');
    const so = await createSalesOrder(db, createInput('5'));
    await confirmSalesOrder(db, so.id);

    await expect(
      closeSalesOrder(db, so.id, {
        lines: [{ id: 'cln_does_not_exist', qtyShipped: '5' }],
      }),
    ).rejects.toThrow(/does not belong/);
  });

  it('Inline qtyShipped: persists on CONFIRMED and survives through close', async () => {
    await stockBin('20');
    const so = await createSalesOrder(db, createInput('10'));
    await confirmSalesOrder(db, so.id);
    const lineId = so.lines[0].id;

    await updateSalesOrderLineQtyShipped(db, so.id, lineId, {
      qtyShipped: '6',
    });

    const afterPatch = await db.salesOrderLine.findUnique({
      where: { id: lineId },
    });
    expect(afterPatch!.qtyShipped.toString()).toBe(
      new Prisma.Decimal('6').toString(),
    );

    // No `lines` payload on close → server falls back to the inline-
    // saved value (6), not qtyOrdered (10).
    const closed = await closeSalesOrder(db, so.id, undefined);
    expect(closed.lines[0].qtyShipped.toString()).toBe(
      new Prisma.Decimal('6').toString(),
    );

    const movements = await db.inventoryMovement.findMany({
      where: {
        variantId,
        warehouseId,
        type: InventoryMovementType.CONSUME,
        reference: closed.number,
      },
    });
    expect(movements).toHaveLength(1);
    expect(movements[0].qty.toString()).toBe(
      new Prisma.Decimal('-6').toString(),
    );

    const invoice = await db.invoice.findUnique({
      where: { salesOrderId: so.id },
      include: { lines: true },
    });
    expect(invoice!.lines[0].qty.toString()).toBe(
      new Prisma.Decimal('6').toString(),
    );
  });

  it('Inline qtyShipped: rejects qtyShipped > qtyOrdered when overShippingPolicy=BLOCK', async () => {
    // Defensive default is CONFIRM (accepts the over-ship); flip to
    // BLOCK to assert the historical reject path. Reset to CONFIRM
    // after the assertion so subsequent tests see the documented
    // default. The dedicated over-shipping-policy test file covers
    // the CONFIRM + ALLOW accept paths in matrix form.
    await setSetting(
      db,
      SETTING_KEYS.OVER_SHIPPING_POLICY,
      { policy: 'BLOCK' },
      overShippingPolicyValueSchema,
    );
    try {
      await stockBin('20');
      const so = await createSalesOrder(db, createInput('5'));
      await confirmSalesOrder(db, so.id);
      const lineId = so.lines[0].id;

      await expect(
        updateSalesOrderLineQtyShipped(db, so.id, lineId, {
          qtyShipped: '6',
        }),
      ).rejects.toThrow(/exceeds qtyOrdered/);
    } finally {
      await setSetting(
        db,
        SETTING_KEYS.OVER_SHIPPING_POLICY,
        { policy: 'CONFIRM' },
        overShippingPolicyValueSchema,
      );
    }
  });

  it('Inline qtyShipped: rejects edit while SO is DRAFT (not yet CONFIRMED)', async () => {
    await stockBin('20');
    const so = await createSalesOrder(db, createInput('5'));
    const lineId = so.lines[0].id;

    await expect(
      updateSalesOrderLineQtyShipped(db, so.id, lineId, {
        qtyShipped: '3',
      }),
    ).rejects.toThrow(/Cannot edit qtyShipped while SalesOrder is in status DRAFT/);
  });

  it('Inline qtyShipped: rejects line id from a different SO', async () => {
    await stockBin('20');
    const soA = await createSalesOrder(db, createInput('5'));
    const soB = await createSalesOrder(db, createInput('5'));
    await confirmSalesOrder(db, soA.id);
    await confirmSalesOrder(db, soB.id);

    // Apply soB's line to soA → must be rejected.
    await expect(
      updateSalesOrderLineQtyShipped(db, soA.id, soB.lines[0].id, {
        qtyShipped: '3',
      }),
    ).rejects.toThrow(/does not belong to SalesOrder/);
  });

  it('Inline qtyShipped: emits UPDATE audit row capturing before+after', async () => {
    await stockBin('20');
    const so = await createSalesOrder(db, createInput('10'));
    await confirmSalesOrder(db, so.id);
    const lineId = so.lines[0].id;

    await updateSalesOrderLineQtyShipped(
      db,
      so.id,
      lineId,
      { qtyShipped: '7' },
      { userId: 'TEST-USER-SHIPPED' },
    );

    const rows = await db.auditLog.findMany({
      where: {
        entityType: 'SalesOrderLine',
        entityId: lineId,
        action: AuditAction.UPDATE,
      },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe('TEST-USER-SHIPPED');
    const before = rows[0].beforeJson as { qtyShipped: string };
    const after = rows[0].afterJson as { qtyShipped: string };
    expect(before.qtyShipped).toBe('0');
    expect(after.qtyShipped).toBe('7');
  });

  // ===========================================================================
  // Inline per-field line edits (qty / unit price / discount / notes)
  // ===========================================================================

  it('updateSalesOrderLineFields: DRAFT qty change updates line + emits audit', async () => {
    const so = await createSalesOrder(db, createInput('5'));
    const lineId = so.lines[0].id;
    await updateSalesOrderLineFields(db, so.id, lineId, {
      qtyOrdered: '8',
    });
    const after = await db.salesOrderLine.findUniqueOrThrow({
      where: { id: lineId },
    });
    expect(after.qtyOrdered.toString()).toBe(new Prisma.Decimal('8').toString());
    // DRAFT — qtyReserved stays at 0.
    expect(after.qtyReserved.toString()).toBe('0');
    const rows = await db.auditLog.findMany({
      where: {
        entityType: 'SalesOrderLine',
        entityId: lineId,
        action: AuditAction.UPDATE,
      },
    });
    expect(rows).toHaveLength(1);
  });

  it('updateSalesOrderLineFields: CONFIRMED qty change syncs qtyReserved + bin counter', async () => {
    await stockBin('20');
    const so = await createSalesOrder(db, createInput('5'));
    await confirmSalesOrder(db, so.id);
    const lineId = so.lines[0].id;

    await updateSalesOrderLineFields(db, so.id, lineId, {
      qtyOrdered: '8',
    });
    const after = await db.salesOrderLine.findUniqueOrThrow({
      where: { id: lineId },
    });
    expect(after.qtyOrdered.toString()).toBe(new Prisma.Decimal('8').toString());
    expect(after.qtyReserved.toString()).toBe(new Prisma.Decimal('8').toString());
    const inv = await db.inventoryItem.findUnique({
      where: { variantId_warehouseId: { variantId, warehouseId } },
    });
    expect(inv!.reserved.toString()).toBe(new Prisma.Decimal('8').toString());
  });

  it('updateSalesOrderLineFields: unitPrice edit flips priceRule to MANUAL_OVERRIDE', async () => {
    const so = await createSalesOrder(db, createInput('1'));
    const lineId = so.lines[0].id;
    await updateSalesOrderLineFields(db, so.id, lineId, {
      unitPrice: '12.50',
    });
    const after = await db.salesOrderLine.findUniqueOrThrow({
      where: { id: lineId },
    });
    expect(after.unitPrice.toString()).toBe(
      new Prisma.Decimal('12.50').toString(),
    );
    expect(after.priceRule).toBe(PriceResolutionRule.MANUAL_OVERRIDE);
  });

  it('updateSalesOrderLineFields: setting discountPercent nulls discountAmount (mutual exclusion)', async () => {
    const so = await createSalesOrder(db, createInput('1'));
    const lineId = so.lines[0].id;
    // First put a discountAmount on the line so we can see the swap.
    await updateSalesOrderLineFields(db, so.id, lineId, {
      discountAmount: '5',
    });
    let after = await db.salesOrderLine.findUniqueOrThrow({ where: { id: lineId } });
    expect(after.discountAmount?.toString()).toBe(
      new Prisma.Decimal('5').toString(),
    );
    expect(after.discountPercent).toBeNull();

    // Now flip to percent — service should null the amount.
    await updateSalesOrderLineFields(db, so.id, lineId, {
      discountPercent: '10',
    });
    after = await db.salesOrderLine.findUniqueOrThrow({ where: { id: lineId } });
    expect(after.discountPercent?.toString()).toBe(
      new Prisma.Decimal('10').toString(),
    );
    expect(after.discountAmount).toBeNull();
  });

  it('updateSalesOrderLineFields: null clears discountPercent', async () => {
    const so = await createSalesOrder(db, createInput('1'));
    const lineId = so.lines[0].id;
    await updateSalesOrderLineFields(db, so.id, lineId, {
      discountPercent: '15',
    });
    await updateSalesOrderLineFields(db, so.id, lineId, {
      discountPercent: null,
    });
    const after = await db.salesOrderLine.findUniqueOrThrow({
      where: { id: lineId },
    });
    expect(after.discountPercent).toBeNull();
    expect(after.discountAmount).toBeNull();
  });

  it('updateSalesOrderLineFields: notes round-trip (set + clear)', async () => {
    const so = await createSalesOrder(db, createInput('1'));
    const lineId = so.lines[0].id;
    await updateSalesOrderLineFields(db, so.id, lineId, {
      customerNote: 'Gift wrap requested',
      internalNote: 'Verified address',
    });
    let after = await db.salesOrderLine.findUniqueOrThrow({ where: { id: lineId } });
    expect(after.customerNote).toBe('Gift wrap requested');
    expect(after.internalNote).toBe('Verified address');

    await updateSalesOrderLineFields(db, so.id, lineId, {
      customerNote: null,
    });
    after = await db.salesOrderLine.findUniqueOrThrow({ where: { id: lineId } });
    expect(after.customerNote).toBeNull();
    // internalNote untouched.
    expect(after.internalNote).toBe('Verified address');
  });

  it('updateSalesOrderLineFields: rejects edits on DISPATCHED', async () => {
    await stockBin('20');
    const so = await createSalesOrder(db, createInput('1'));
    await confirmSalesOrder(db, so.id);
    await dispatchSalesOrder(db, so.id);
    const lineId = so.lines[0].id;
    await expect(
      updateSalesOrderLineFields(db, so.id, lineId, { unitPrice: '99' }),
    ).rejects.toThrow(/Cannot edit line fields while SalesOrder is in status DISPATCHED/);
  });

  it('updateSalesOrderLineFields: rejects line id from a different SO', async () => {
    const soA = await createSalesOrder(db, createInput('1'));
    const soB = await createSalesOrder(db, createInput('1'));
    await expect(
      updateSalesOrderLineFields(db, soA.id, soB.lines[0].id, {
        qtyOrdered: '2',
      }),
    ).rejects.toThrow(/does not belong to SalesOrder/);
  });

  it('updateSalesOrderLineFields: validator rejects both discountPercent and discountAmount in one call', async () => {
    const so = await createSalesOrder(db, createInput('1'));
    const lineId = so.lines[0].id;
    await expect(
      updateSalesOrderLineFields(db, so.id, lineId, {
        discountPercent: '10',
        discountAmount: '5',
      }),
    ).rejects.toThrow(/discountPercent OR discountAmount/);
  });

  // ===========================================================================
  // Reversion workflows — undispatch, reopen, add-lines-on-confirmed
  // ===========================================================================

  it('undispatchSalesOrder flips DISPATCHED → CONFIRMED with no inventory effect', async () => {
    await stockBin('20');
    const so = await createSalesOrder(db, createInput('5'));
    await confirmSalesOrder(db, so.id);
    await dispatchSalesOrder(db, so.id);

    const beforeInv = await db.inventoryItem.findUnique({
      where: { variantId_warehouseId: { variantId, warehouseId } },
    });
    const undispatched = await undispatchSalesOrder(db, so.id);
    expect(undispatched.status).toBe(SalesOrderStatus.CONFIRMED);
    expect(undispatched.dispatchedAt).toBeNull();
    const afterInv = await db.inventoryItem.findUnique({
      where: { variantId_warehouseId: { variantId, warehouseId } },
    });
    // Reserved + OnHand should be identical — no inventory movement.
    expect(afterInv!.onHand.toString()).toBe(beforeInv!.onHand.toString());
    expect(afterInv!.reserved.toString()).toBe(beforeInv!.reserved.toString());
  });

  it('undispatchSalesOrder rejects when not DISPATCHED', async () => {
    const so = await createSalesOrder(db, createInput('1'));
    await expect(undispatchSalesOrder(db, so.id)).rejects.toThrow(
      /Cannot un-dispatch SalesOrder in status DRAFT/,
    );
  });

  it('reopenSalesOrder (no payments) → CONFIRMED: invoice detached, inventory restored, qtyShipped preserved', async () => {
    await stockBin('20');
    const so = await createSalesOrder(db, createInput('5'));
    await confirmSalesOrder(db, so.id);
    const closed = await closeSalesOrder(db, so.id, undefined);
    const invoiceBefore = await db.invoice.findUniqueOrThrow({
      where: { salesOrderId: so.id },
    });
    expect(closed.status).toBe(SalesOrderStatus.CLOSED);

    const reopened = await reopenSalesOrder(db, so.id, {
      targetStatus: 'CONFIRMED',
      paymentDecision: 'none',
    });
    expect(reopened.status).toBe(SalesOrderStatus.CONFIRMED);
    expect(reopened.closedAt).toBeNull();
    // qtyShipped is preserved across reopen — the close persisted it
    // (no override here, so the full qtyOrdered=5 became the shipped
    // value), and reopen leaves it alone so the operator's correction
    // workflow starts from the actual data.
    expect(reopened.lines[0].qtyShipped.toString()).toBe(
      new Prisma.Decimal('5').toString(),
    );
    expect(reopened.lines[0].qtyReserved.toString()).toBe(
      new Prisma.Decimal('5').toString(),
    );
    expect(reopened.lines[0].inventoryMovementId).toBeNull();

    // Invoice still exists; SO link is NULL; status flipped to VOIDED
    // with the offsetting AR/Revenue JE posted by voidInvoiceTx (called
    // inside the reopen tx).
    const invoiceAfter = await db.invoice.findUniqueOrThrow({
      where: { id: invoiceBefore.id },
    });
    expect(invoiceAfter.salesOrderId).toBeNull();
    expect(invoiceAfter.cogsReversed).toBe(true);
    expect(invoiceAfter.status).toBe('VOIDED');
    expect(invoiceAfter.voidedAt).not.toBeNull();
    expect(invoiceAfter.voidReason).toMatch(/reopened/i);

    // Inventory: onHand restored to seed (20), reserved equals qtyOrdered (5).
    const inv = await db.inventoryItem.findUnique({
      where: { variantId_warehouseId: { variantId, warehouseId } },
    });
    expect(inv!.onHand.toString()).toBe(new Prisma.Decimal('20').toString());
    expect(inv!.reserved.toString()).toBe(new Prisma.Decimal('5').toString());
  });

  it('reopenSalesOrder preserves an operator-edited qtyShipped (regression: was resetting to 0)', async () => {
    // Operator inline-edits qtyShipped to a short value (7 of 10),
    // closes the SO, then reopens → DISPATCHED to make a correction.
    // Reopen MUST keep qtyShipped at 7 — the bug reset it to 0, which
    // the QtyShippedInput pre-fill chain masked by showing qtyOrdered
    // (10), making it look like the warehouse's data had been lost.
    await stockBin('20');
    const so = await createSalesOrder(db, createInput('10'));
    await confirmSalesOrder(db, so.id);
    await updateSalesOrderLineQtyShipped(db, so.id, so.lines[0].id, {
      qtyShipped: '7',
    });
    const closed = await closeSalesOrder(db, so.id, undefined);
    expect(closed.lines[0].qtyShipped.toString()).toBe(
      new Prisma.Decimal('7').toString(),
    );

    const reopened = await reopenSalesOrder(db, so.id, {
      targetStatus: 'DISPATCHED',
      paymentDecision: 'none',
    });
    // The bug: qtyShipped was reset to 0 here. The fix: preserve it.
    expect(reopened.lines[0].qtyShipped.toString()).toBe(
      new Prisma.Decimal('7').toString(),
    );
    expect(reopened.lines[0].inventoryMovementId).toBeNull();
  });

  it('reopenSalesOrder preserves over-shipped qtyShipped (regression: was resetting to 0)', async () => {
    // The over-ship test scenario the user reported: ordered=1, the
    // warehouse over-ships and records qtyShipped=12 at close time.
    // Reopen MUST preserve the 12 — without the fix it reset to 0,
    // which the QtyShippedInput then masked by pre-filling qtyOrdered
    // (1), making it look to the operator like 12 became 1.
    await setSetting(
      db,
      SETTING_KEYS.OVER_SHIPPING_POLICY,
      { policy: 'ALLOW' },
      overShippingPolicyValueSchema,
    );
    try {
      await stockBin('20');
      const so = await createSalesOrder(db, createInput('1'));
      await confirmSalesOrder(db, so.id);
      // Inline-set qtyShipped=12 (over-ship) before close. Then close
      // using that persisted value via the fallback chain.
      await updateSalesOrderLineQtyShipped(db, so.id, so.lines[0].id, {
        qtyShipped: '12',
      });
      const closed = await closeSalesOrder(db, so.id, undefined);
      expect(closed.lines[0].qtyShipped.toString()).toBe(
        new Prisma.Decimal('12').toString(),
      );

      const reopened = await reopenSalesOrder(db, so.id, {
        targetStatus: 'DISPATCHED',
        paymentDecision: 'none',
      });
      // The bug: qtyShipped was reset to 0 here. The fix: preserve it.
      expect(reopened.lines[0].qtyShipped.toString()).toBe(
        new Prisma.Decimal('12').toString(),
      );
      expect(reopened.lines[0].inventoryMovementId).toBeNull();
    } finally {
      await setSetting(
        db,
        SETTING_KEYS.OVER_SHIPPING_POLICY,
        { policy: 'CONFIRM' },
        overShippingPolicyValueSchema,
      );
    }
  });

  it('reopenSalesOrder → CANCELLED zeroes reservation and stamps cancelledAt', async () => {
    await stockBin('20');
    const so = await createSalesOrder(db, createInput('5'));
    await confirmSalesOrder(db, so.id);
    await closeSalesOrder(db, so.id, undefined);

    const reopened = await reopenSalesOrder(db, so.id, {
      targetStatus: 'CANCELLED',
      paymentDecision: 'none',
    });
    expect(reopened.status).toBe(SalesOrderStatus.CANCELLED);
    expect(reopened.cancelledAt).not.toBeNull();
    expect(reopened.lines[0].qtyReserved.toString()).toBe('0');

    const inv = await db.inventoryItem.findUnique({
      where: { variantId_warehouseId: { variantId, warehouseId } },
    });
    expect(inv!.onHand.toString()).toBe(new Prisma.Decimal('20').toString());
    expect(inv!.reserved.toString()).toBe('0');
  });

  it('reopenSalesOrder followed by re-close generates a fresh invoice; prior invoice is VOIDED so AR balance reflects only the latest revision', async () => {
    // Regression test for the duplicate-open-invoice bug: pre-fix, the
    // prior invoice was left OPEN after reopen, so a re-close left two
    // OPEN invoices contributing to AR. Post-fix, reopen voids the
    // prior invoice and posts the offsetting AR/Revenue JE, so only
    // the latest revision's total counts.
    await stockBin('20');
    const so = await createSalesOrder(db, createInput('3'));
    await confirmSalesOrder(db, so.id);
    const closed1 = await closeSalesOrder(db, so.id, undefined);
    const inv1 = await db.invoice.findUniqueOrThrow({
      where: { salesOrderId: so.id },
    });

    await reopenSalesOrder(db, so.id, {
      targetStatus: 'CONFIRMED',
      paymentDecision: 'none',
    });
    const closed2 = await closeSalesOrder(db, so.id, undefined);
    const inv2 = await db.invoice.findUniqueOrThrow({
      where: { salesOrderId: so.id },
    });

    expect(inv1.id).not.toBe(inv2.id);
    expect(inv2.salesOrderId).toBe(so.id);
    expect(inv2.status).toBe('OPEN');

    // Old invoice now orphaned AND voided. Voided status excludes it
    // from arBalanceForCustomer's OPEN/PARTIAL filter.
    const orphan = await db.invoice.findUniqueOrThrow({ where: { id: inv1.id } });
    expect(orphan.salesOrderId).toBeNull();
    expect(orphan.status).toBe('VOIDED');
    expect(orphan.voidedAt).not.toBeNull();

    // Net AR check: should equal inv2.total alone — NOT inv1.total + inv2.total.
    const { arBalance } = await arBalanceForCustomer(db, customerId);
    expect(arBalance.toString()).toBe(inv2.total.toString());

    void closed1;
    void closed2;
  });

  it('reopenSalesOrder is blocked by applied payment when paymentDecision=none; structured error carries payment details', async () => {
    await stockBin('20');
    const so = await createSalesOrder(db, createInput('5'));
    await confirmSalesOrder(db, so.id);
    await closeSalesOrder(db, so.id, undefined);
    const invoice = await db.invoice.findUniqueOrThrow({
      where: { salesOrderId: so.id },
    });

    // Record a payment + apply to the invoice.
    const payment = await recordPayment(db, {
      customerId,
      method: 'CHECK',
      amount: invoice.total.toString(),
      applications: [{ invoiceId: invoice.id, amount: invoice.total.toString() }],
    });
    void payment;

    let threw: SalesOrderReopenBlockedError | null = null;
    try {
      await reopenSalesOrder(db, so.id, {
        targetStatus: 'CONFIRMED',
        paymentDecision: 'none',
      });
    } catch (e) {
      if (e instanceof SalesOrderReopenBlockedError) threw = e;
      else throw e;
    }
    expect(threw).not.toBeNull();
    expect(threw!.invoiceId).toBe(invoice.id);
    expect(threw!.payments.length).toBe(1);
    expect(threw!.payments[0].amountAppliedToThisInvoice).toBe(
      invoice.total.toString(),
    );
  });

  it('reopenSalesOrder with paymentDecision=unapply reverses the payment and completes the reopen', async () => {
    await stockBin('20');
    const so = await createSalesOrder(db, createInput('5'));
    await confirmSalesOrder(db, so.id);
    await closeSalesOrder(db, so.id, undefined);
    const invoice = await db.invoice.findUniqueOrThrow({
      where: { salesOrderId: so.id },
    });
    const payment = await recordPayment(db, {
      customerId,
      method: 'CHECK',
      amount: invoice.total.toString(),
      applications: [{ invoiceId: invoice.id, amount: invoice.total.toString() }],
    });

    const reopened = await reopenSalesOrder(db, so.id, {
      targetStatus: 'CONFIRMED',
      paymentDecision: 'unapply',
      unapplyReason: 'test reopen',
    });
    expect(reopened.status).toBe(SalesOrderStatus.CONFIRMED);

    const reversedPayment = await db.payment.findUniqueOrThrow({
      where: { id: payment.id },
    });
    expect(reversedPayment.status).toBe('REVERSED');
    expect(reversedPayment.reversedAt).not.toBeNull();

    // Invoice's amountPaid back to 0.
    const invAfter = await db.invoice.findUniqueOrThrow({
      where: { id: invoice.id },
    });
    expect(invAfter.amountPaid.toString()).toBe('0');
    expect(invAfter.salesOrderId).toBeNull();
  });

  it('addSalesOrderLines: appends a line to a CONFIRMED order with inventory reserved immediately', async () => {
    await stockBin('20');
    const so = await createSalesOrder(db, createInput('3'));
    await confirmSalesOrder(db, so.id);

    const after = await addSalesOrderLines(db, so.id, {
      lines: [{ variantId, warehouseId, qtyOrdered: '4' }],
    });
    expect(after.lines).toHaveLength(2);
    const newLine = after.lines.find(
      (l) => l.qtyOrdered.toString() === new Prisma.Decimal('4').toString(),
    );
    expect(newLine).toBeTruthy();
    expect(newLine!.qtyReserved.toString()).toBe(
      new Prisma.Decimal('4').toString(),
    );

    const inv = await db.inventoryItem.findUnique({
      where: { variantId_warehouseId: { variantId, warehouseId } },
    });
    // Reserved bumped from 3 (original line) to 7 (3 + 4).
    expect(inv!.reserved.toString()).toBe(new Prisma.Decimal('7').toString());
  });

  it('addSalesOrderLines rejects when SO is not CONFIRMED', async () => {
    const so = await createSalesOrder(db, createInput('3'));
    await expect(
      addSalesOrderLines(db, so.id, {
        lines: [{ variantId, warehouseId, qtyOrdered: '1' }],
      }),
    ).rejects.toThrow(/only supported on CONFIRMED orders/);
  });

  it('Audit rows: CREATE on createSalesOrder, STATUS_CHANGE on each transition', async () => {
    await stockBin('20');
    const so = await createSalesOrder(db, createInput('2'));
    await confirmSalesOrder(db, so.id);
    await dispatchSalesOrder(db, so.id);
    await closeSalesOrder(db, so.id, undefined);

    const auditRows = await db.auditLog.findMany({
      where: { entityType: 'SalesOrder', entityId: so.id },
      orderBy: { createdAt: 'asc' },
    });
    const actions = auditRows.map((r) => r.action);
    // Assert by SET membership rather than order — Postgres
    // CURRENT_TIMESTAMP sub-microsecond collisions can make
    // createdAt-ordering unstable when multiple transactions land
    // within the same instant. The semantic invariant is "exactly
    // one CREATE and exactly three STATUS_CHANGE rows".
    expect(actions.filter((a) => a === AuditAction.CREATE)).toHaveLength(1);
    expect(actions.filter((a) => a === AuditAction.STATUS_CHANGE)).toHaveLength(3);
  });
});

async function wipe(
  db: PrismaClient,
  ids: { customerId: string; variantId: string; warehouseId: string },
): Promise<void> {
  // Audit rows referencing our movements + SOs (other test files can run
  // in parallel against the same DB, so scope by id).
  const ourMovements = await db.inventoryMovement.findMany({
    where: { variantId: ids.variantId },
    select: { id: true },
  });
  if (ourMovements.length > 0) {
    await db.auditLog.deleteMany({
      where: {
        entityType: 'InventoryMovement',
        entityId: { in: ourMovements.map((m) => m.id) },
      },
    });
  }
  const ourSos = await db.salesOrder.findMany({
    where: { customerId: ids.customerId },
    select: { id: true, lines: { select: { id: true } } },
  });
  if (ourSos.length > 0) {
    await db.auditLog.deleteMany({
      where: {
        entityType: 'SalesOrder',
        entityId: { in: ourSos.map((s) => s.id) },
      },
    });
    const ourLineIds = ourSos.flatMap((s) => s.lines.map((l) => l.id));
    if (ourLineIds.length > 0) {
      await db.auditLog.deleteMany({
        where: {
          entityType: 'SalesOrderLine',
          entityId: { in: ourLineIds },
        },
      });
    }
  }
  await wipeInvoiceArtifactsForSOs(db, ourSos.map((s) => s.id));
  // After reopen, the SO's invoice has salesOrderId=NULL — the
  // by-SO-id sweep above misses it. Catch orphans by customerId.
  const orphanInvoices = await db.invoice.findMany({
    where: { customerId: ids.customerId, salesOrderId: null },
    select: { id: true },
  });
  if (orphanInvoices.length > 0) {
    const orphanIds = orphanInvoices.map((i) => i.id);
    const orphanJes = await db.journalEntry.findMany({
      where: { entityType: 'Invoice', entityId: { in: orphanIds } },
      select: { id: true },
    });
    if (orphanJes.length > 0) {
      const jeIds = orphanJes.map((j) => j.id);
      await db.journalEntryLine.deleteMany({
        where: { journalEntryId: { in: jeIds } },
      });
      await db.journalEntry.deleteMany({ where: { id: { in: jeIds } } });
    }
    await db.creditApplication.deleteMany({
      where: { invoiceId: { in: orphanIds } },
    });
    await db.auditLog.deleteMany({
      where: { entityType: 'Invoice', entityId: { in: orphanIds } },
    });
    await db.invoiceLine.deleteMany({ where: { invoiceId: { in: orphanIds } } });
    await db.invoice.deleteMany({ where: { id: { in: orphanIds } } });
  }
  // Payments + their JEs/audit (reopen-with-unapply leaves REVERSED
  // payments behind).
  const ourPayments = await db.payment.findMany({
    where: { customerId: ids.customerId },
    select: { id: true },
  });
  if (ourPayments.length > 0) {
    const paymentIds = ourPayments.map((p) => p.id);
    const paymentJes = await db.journalEntry.findMany({
      where: { entityType: 'Payment', entityId: { in: paymentIds } },
      select: { id: true },
    });
    if (paymentJes.length > 0) {
      const jeIds = paymentJes.map((j) => j.id);
      await db.journalEntryLine.deleteMany({
        where: { journalEntryId: { in: jeIds } },
      });
      await db.journalEntry.deleteMany({ where: { id: { in: jeIds } } });
    }
    await db.creditApplication.deleteMany({
      where: { paymentId: { in: paymentIds } },
    });
    await db.auditLog.deleteMany({
      where: { entityType: 'Payment', entityId: { in: paymentIds } },
    });
    await db.payment.deleteMany({ where: { id: { in: paymentIds } } });
  }
  await db.salesOrderLine.deleteMany({ where: { salesOrder: { customerId: ids.customerId } } });
  await db.salesOrder.deleteMany({ where: { customerId: ids.customerId } });
  await db.inventoryMovement.deleteMany({ where: { variantId: ids.variantId } });
  await db.inventoryItem.deleteMany({ where: { variantId: ids.variantId } });
}
