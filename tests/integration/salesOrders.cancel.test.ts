import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PaymentMethod, Prisma, SalesOrderStatus } from '@/generated/tenant';
import type { PrismaClient } from '@/generated/tenant';
import {
  cancelSalesOrder,
  closeSalesOrder,
  confirmSalesOrder,
  createSalesOrder,
  dispatchSalesOrder,
} from '@/server/services/salesOrders';
import { receiveInventory } from '@/server/services/movements';
import { recordPayment, reversePayment } from '@/server/services/payments';
import { SalesOrderCancelBlockedError } from '@/lib/errors/credit';
import { hasTenantDb, makeClient } from '../helpers/db';
import { wipeInvoiceArtifactsForSOs } from '../helpers/wipeInvoiceArtifacts';
import { upsertTestCustomer } from '../helpers/customerStub';
import { upsertTestWarehouse } from '../helpers/warehouseStub';

const suite = hasTenantDb ? describe : describe.skip;

suite('SalesOrder cancel', () => {
  let db: PrismaClient;
  let customerId: string;
  let warehouseId: string;
  let productId: string;
  let variantId: string;

  beforeAll(async () => {
    db = makeClient();
    const c = await upsertTestCustomer(db, {
      code: 'TEST-CUST-SO-CN',
      name: 'Cancel Cust',
    });
    customerId = c.id;
    const wh = await upsertTestWarehouse(db, {
      code: 'TEST-WH-SO-CN',
      name: 'Cancel WH',
    });
    warehouseId = wh.id;
    const product = await db.product.upsert({
      where: { sku: 'TEST-PROD-SO-CN' },
      create: {
        sku: 'TEST-PROD-SO-CN',
        name: 'Cancel Product',
        basePrice: new Prisma.Decimal('1.00'),
      },
      update: { active: true, deletedAt: null, basePrice: new Prisma.Decimal('1.00') },
    });
    productId = product.id;
    const variant = await db.productVariant.upsert({
      where: { sku: 'TEST-PROD-SO-CN-V1' },
      create: { productId: product.id, sku: 'TEST-PROD-SO-CN-V1', name: 'V1' },
      update: { productId: product.id, active: true, deletedAt: null },
    });
    variantId = variant.id;
  });

  beforeEach(async () => {
    await wipe(db, { customerId, variantId });
  });

  afterAll(async () => {
    await wipe(db, { customerId, variantId });
    await db.productVariant.deleteMany({ where: { id: variantId } });
    await db.product.deleteMany({ where: { id: productId } });
    await db.warehouse.deleteMany({ where: { id: warehouseId } });
    await db.customer.deleteMany({ where: { id: customerId } });
    await db.$disconnect();
  });

  function input(qty = '5') {
    return {
      customerId,
      warehouseId,
      lines: [{ variantId, warehouseId, qtyOrdered: qty }],
    };
  }

  it('Cancel from DRAFT — no inventory effect', async () => {
    const so = await createSalesOrder(db, input('5'));
    const cancelled = await cancelSalesOrder(db, so.id, { reason: 'changed mind' });
    expect(cancelled.status).toBe(SalesOrderStatus.CANCELLED);
    expect(cancelled.cancelReason).toBe('changed mind');
    const inv = await db.inventoryItem.findUnique({
      where: { variantId_warehouseId: { variantId, warehouseId } },
    });
    // No InventoryItem row was ever created — that's fine.
    expect(inv?.reserved.toString() ?? '0').toBe('0');
  });

  it('Cancel from CONFIRMED — Reserved goes back to 0', async () => {
    await receiveInventory(db, { variantId, warehouseId, qty: '10' });
    const so = await createSalesOrder(db, input('4'));
    await confirmSalesOrder(db, so.id);
    let inv = await db.inventoryItem.findUnique({
      where: { variantId_warehouseId: { variantId, warehouseId } },
    });
    expect(inv!.reserved.toString()).toBe(new Prisma.Decimal('4').toString());

    await cancelSalesOrder(db, so.id, { reason: 'cust cancel' });
    inv = await db.inventoryItem.findUnique({
      where: { variantId_warehouseId: { variantId, warehouseId } },
    });
    expect(inv!.reserved.toString()).toBe(new Prisma.Decimal('0').toString());
    expect(inv!.onHand.toString()).toBe(new Prisma.Decimal('10').toString());

    const line = (await db.salesOrderLine.findFirst({ where: { salesOrderId: so.id } }))!;
    expect(line.qtyReserved.toString()).toBe(new Prisma.Decimal('0').toString());
  });

  it('Cancel from DISPATCHED — Reserved goes back to 0', async () => {
    await receiveInventory(db, { variantId, warehouseId, qty: '10' });
    const so = await createSalesOrder(db, input('4'));
    await confirmSalesOrder(db, so.id);
    await dispatchSalesOrder(db, so.id);
    await cancelSalesOrder(db, so.id, { reason: 'pulled before ship' });
    const inv = await db.inventoryItem.findUnique({
      where: { variantId_warehouseId: { variantId, warehouseId } },
    });
    expect(inv!.reserved.toString()).toBe(new Prisma.Decimal('0').toString());
  });

  it('Cancel from CLOSED is rejected — must use RMA', async () => {
    await receiveInventory(db, { variantId, warehouseId, qty: '10' });
    const so = await createSalesOrder(db, input('4'));
    await confirmSalesOrder(db, so.id);
    await dispatchSalesOrder(db, so.id);
    await closeSalesOrder(db, so.id, undefined);
    await expect(
      cancelSalesOrder(db, so.id, { reason: 'too late' }),
    ).rejects.toThrow(/RMA/);
  });

  it('Cancel requires a reason', async () => {
    const so = await createSalesOrder(db, input('1'));
    // Zod requires non-empty reason.
    await expect(
      // @ts-expect-error - intentionally missing required field
      cancelSalesOrder(db, so.id, {}),
    ).rejects.toThrow();
  });

  it('Re-cancel rejected', async () => {
    const so = await createSalesOrder(db, input('1'));
    await cancelSalesOrder(db, so.id, { reason: 'first' });
    await expect(
      cancelSalesOrder(db, so.id, { reason: 'second' }),
    ).rejects.toThrow(/already CANCELLED/);
  });

  // ---------------------------------------------------------------------------
  // Audit fix #10 — payment-state-gated cancellation.
  // CLOSED still routes through RMA (Q3 = option b). Pre-CLOSED cancel
  // is the no-op happy path today (no invoice exists pre-CLOSED → no
  // payment can attach). The block fires the moment a future workflow
  // attaches a payment to a pre-close invoice; simulated here by
  // forcibly creating an invoice + payment on a CONFIRMED SO and
  // confirming the cancel refuses with the typed error.
  // ---------------------------------------------------------------------------

  it('CONFIRMED with attached payment → SalesOrderCancelBlockedError', async () => {
    await receiveInventory(db, { variantId, warehouseId, qty: '10' });
    const so = await createSalesOrder(db, input('4'));
    await confirmSalesOrder(db, so.id);

    // Simulate a future deposit-on-confirm workflow: synthesize an
    // invoice tied to this SO so a payment can apply against it.
    // Pilot doesn't ship pre-close invoicing, but the cancel guard
    // must be honest about the case.
    const inv = await db.invoice.create({
      data: {
        number: `${so.number}-DEP`,
        salesOrderId: so.id,
        customerId,
        warehouseId,
        subtotal: new Prisma.Decimal('40'),
        total: new Prisma.Decimal('40'),
      },
    });
    const pmt = await recordPayment(db, {
      customerId,
      method: PaymentMethod.CHECK,
      amount: '20',
      applications: [{ invoiceId: inv.id, amount: '20' }],
    });

    const err = await cancelSalesOrder(db, so.id, { reason: 'oops' }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SalesOrderCancelBlockedError);
    const e = err as SalesOrderCancelBlockedError;
    expect(e.code).toBe('SO_CANCEL_BLOCKED_BY_PAYMENT');
    expect(e.salesOrderId).toBe(so.id);
    expect(e.paymentNumbers).toContain(pmt.number);

    const fresh = await db.salesOrder.findUniqueOrThrow({ where: { id: so.id } });
    expect(fresh.status).toBe(SalesOrderStatus.CONFIRMED);
  });

  it('CONFIRMED with reversed payment → cancel succeeds', async () => {
    await receiveInventory(db, { variantId, warehouseId, qty: '10' });
    const so = await createSalesOrder(db, input('4'));
    await confirmSalesOrder(db, so.id);
    const inv = await db.invoice.create({
      data: {
        number: `${so.number}-DEP2`,
        salesOrderId: so.id,
        customerId,
        warehouseId,
        subtotal: new Prisma.Decimal('40'),
        total: new Prisma.Decimal('40'),
      },
    });
    const pmt = await recordPayment(db, {
      customerId,
      method: PaymentMethod.CHECK,
      amount: '20',
      applications: [{ invoiceId: inv.id, amount: '20' }],
    });
    await reversePayment(db, { paymentId: pmt.id, reason: 'NSF' });

    const cancelled = await cancelSalesOrder(db, so.id, { reason: 'finally' });
    expect(cancelled.status).toBe(SalesOrderStatus.CANCELLED);
  });

  it('CLOSED still throws RMA-redirect error regardless of payment state', async () => {
    // Reaffirms Q3 option (b): CLOSED cancel never gets the new gate
    // logic; the RMA path is still the only escape.
    await receiveInventory(db, { variantId, warehouseId, qty: '10' });
    const so = await createSalesOrder(db, input('4'));
    await confirmSalesOrder(db, so.id);
    await dispatchSalesOrder(db, so.id);
    await closeSalesOrder(db, so.id, undefined);
    await expect(
      cancelSalesOrder(db, so.id, { reason: 'no payment so should pass right?' }),
    ).rejects.toThrow(/RMA/);
  });
});

async function wipe(
  db: PrismaClient,
  ids: { customerId: string; variantId: string },
): Promise<void> {
  const ourMovements = await db.inventoryMovement.findMany({
    where: { variantId: ids.variantId },
    select: { id: true },
  });
  if (ourMovements.length > 0) {
    await db.auditLog.deleteMany({
      where: { entityType: 'InventoryMovement', entityId: { in: ourMovements.map((m) => m.id) } },
    });
  }
  const ourSos = await db.salesOrder.findMany({
    where: { customerId: ids.customerId },
    select: { id: true },
  });
  if (ourSos.length > 0) {
    await db.auditLog.deleteMany({
      where: { entityType: 'SalesOrder', entityId: { in: ourSos.map((s) => s.id) } },
    });
  }
  // Payments + their JEs / applications come before invoices (FK).
  // The new audit-#10 tests synthesize invoices + payments to drive
  // the SalesOrderCancelBlockedError gate; clean them up here.
  const ourPayments = await db.payment.findMany({
    where: { customerId: ids.customerId },
    select: { id: true },
  });
  if (ourPayments.length > 0) {
    const pmtIds = ourPayments.map((p) => p.id);
    const pmtJes = await db.journalEntry.findMany({
      where: { entityType: 'Payment', entityId: { in: pmtIds } },
      select: { id: true },
    });
    if (pmtJes.length > 0) {
      const jeIds = pmtJes.map((j) => j.id);
      await db.journalEntryLine.deleteMany({ where: { journalEntryId: { in: jeIds } } });
      await db.journalEntry.deleteMany({ where: { id: { in: jeIds } } });
    }
    await db.creditApplication.deleteMany({ where: { paymentId: { in: pmtIds } } });
    await db.auditLog.deleteMany({
      where: { entityType: 'Payment', entityId: { in: pmtIds } },
    });
    await db.payment.deleteMany({ where: { id: { in: pmtIds } } });
  }
  await wipeInvoiceArtifactsForSOs(db, ourSos.map((s) => s.id));
  await db.salesOrderLine.deleteMany({ where: { salesOrder: { customerId: ids.customerId } } });
  await db.salesOrder.deleteMany({ where: { customerId: ids.customerId } });
  await db.inventoryMovement.deleteMany({ where: { variantId: ids.variantId } });
  await db.inventoryItem.deleteMany({ where: { variantId: ids.variantId } });
}
