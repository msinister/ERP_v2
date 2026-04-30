import { Prisma } from '../src/generated/tenant';
import { db } from '../src/lib/db';
import {
  cancelSalesOrder,
  closeSalesOrder,
  confirmSalesOrder,
  createSalesOrder,
} from '../src/server/services/salesOrders';

const CUSTOMER_CODE = 'MANUAL-TEST-CUSTOMER';
const OVERRIDE_PRICE = '4.44'; // distinct from the seed product basePrice (9.99)

async function ensureSalesRepAndPaymentTerm() {
  // Idempotently re-assert the seeded UNASSIGNED rep + NET30 term so
  // the script works even on a freshly-migrated DB before db:seed:tenant
  // has been run.
  await db.salesRep.upsert({
    where: { code: 'UNASSIGNED' },
    create: { code: 'UNASSIGNED', name: 'Unassigned' },
    update: { name: 'Unassigned', active: true, deletedAt: null },
  });
  await db.paymentTerm.upsert({
    where: { code: 'NET30' },
    create: { code: 'NET30', label: 'Net 30', netDays: 30 },
    update: { label: 'Net 30', netDays: 30, active: true, deletedAt: null },
  });
}

async function ensureCustomer() {
  // Full master shape: customer + billing address. Default ship-to is
  // optional; the SO flow doesn't require it. The first run creates;
  // subsequent runs leave the customer in place (the upsert path
  // requires a billing-address-less update, which we do via a separate
  // findFirst-then-create flow).
  const existing = await db.customer.findFirst({
    where: { code: CUSTOMER_CODE, deletedAt: null },
  });
  if (existing) return existing;

  return db.$transaction(async (tx) => {
    const customer = await tx.customer.create({
      data: {
        code: CUSTOMER_CODE,
        name: 'Manual Test Customer',
        salesRep: { connect: { code: 'UNASSIGNED' } },
        paymentTerm: { connect: { code: 'NET30' } },
      },
    });
    await tx.customerAddress.create({
      data: {
        customerId: customer.id,
        kind: 'BILLING',
        isDefault: true,
        line1: '1 Manual Test Way',
        city: 'Dallas',
        region: 'TX',
        postalCode: '75201',
      },
    });
    await tx.customerAddress.create({
      data: {
        customerId: customer.id,
        kind: 'SHIPPING',
        isDefault: true,
        line1: '1 Manual Test Way',
        city: 'Dallas',
        region: 'TX',
        postalCode: '75201',
      },
    });
    return customer;
  });
}

async function ensurePriceOverride(customerId: string, variantId: string) {
  // Idempotent: leaves an existing override in place but resets the
  // unit price + un-soft-deletes if needed so the script's expected
  // CUSTOMER_SPECIFIC rule fires reliably across runs.
  const existing = await db.customerPriceOverride.findFirst({
    where: { customerId, variantId },
  });
  if (existing) {
    return db.customerPriceOverride.update({
      where: { id: existing.id },
      data: {
        unitPrice: new Prisma.Decimal(OVERRIDE_PRICE),
        currency: 'USD',
        deletedAt: null,
      },
    });
  }
  return db.customerPriceOverride.create({
    data: {
      customerId,
      variantId,
      unitPrice: new Prisma.Decimal(OVERRIDE_PRICE),
      currency: 'USD',
    },
  });
}

// The seed product doesn't ship with a basePrice. The pricing resolver
// requires it for the BASE_PRICE branch, so we set one here idempotently
// (only if missing) — same spirit as the seed: safe to re-run.
async function ensureSeedProductHasBasePrice(productId: string) {
  const p = await db.product.findUnique({ where: { id: productId } });
  if (!p) throw new Error(`Product not found: ${productId}`);
  if (p.basePrice == null) {
    await db.product.update({
      where: { id: productId },
      data: { basePrice: new Prisma.Decimal('9.99') },
    });
  }
}

function banner(label: string) {
  console.log('\n' + '='.repeat(60));
  console.log(label);
  console.log('='.repeat(60));
}

async function readInventory(variantId: string, warehouseId: string) {
  const inv = await db.inventoryItem.findUnique({
    where: { variantId_warehouseId: { variantId, warehouseId } },
  });
  return {
    onHand: inv?.onHand.toString() ?? '0',
    reserved: inv?.reserved.toString() ?? '0',
  };
}

async function main() {
  banner('1. Ensure sales rep + payment term + customer (full master shape)');
  await ensureSalesRepAndPaymentTerm();
  const customer = await ensureCustomer();
  console.log({ id: customer.id, code: customer.code, name: customer.name });

  banner('2. Read seed variant + warehouse');
  const variant = await db.productVariant.findFirst({
    where: { sku: 'SEED-PROD-1-RED', deletedAt: null },
  });
  const warehouse = await db.warehouse.findFirst({
    where: { code: 'WH-MAIN', deletedAt: null },
  });
  if (!variant) throw new Error('Seed variant SEED-PROD-1-RED not found — run db:seed:tenant first');
  if (!warehouse) throw new Error('Seed warehouse WH-MAIN not found — run db:seed:tenant first');
  await ensureSeedProductHasBasePrice(variant.productId);
  const product = await db.product.findUnique({ where: { id: variant.productId } });
  console.log({
    variantId: variant.id,
    variantSku: variant.sku,
    warehouseId: warehouse.id,
    productBasePrice: product!.basePrice!.toString(),
  });

  banner(`2b. Ensure customer-specific price override at $${OVERRIDE_PRICE} (vs base ${product!.basePrice!.toString()})`);
  const override = await ensurePriceOverride(customer.id, variant.id);
  console.log({
    overrideId: override.id,
    unitPrice: override.unitPrice.toString(),
    currency: override.currency,
  });

  banner('3. Create SO (1 line, 5 units — should resolve via CUSTOMER_SPECIFIC override)');
  const so = await createSalesOrder(db, {
    customerId: customer.id,
    warehouseId: warehouse.id,
    lines: [
      {
        variantId: variant.id,
        warehouseId: warehouse.id,
        qtyOrdered: '5',
      },
    ],
  });
  console.log({
    id: so.id,
    number: so.number,
    status: so.status,
    lineCount: so.lines.length,
    line0: {
      qtyOrdered: so.lines[0].qtyOrdered.toString(),
      unitPrice: so.lines[0].unitPrice.toString(),
      priceRule: so.lines[0].priceRule,
      qtyReserved: so.lines[0].qtyReserved.toString(),
      qtyShipped: so.lines[0].qtyShipped.toString(),
    },
  });
  console.log(
    `Pricing rule fired: ${so.lines[0].priceRule}` +
      (so.lines[0].priceRule === 'CUSTOMER_SPECIFIC'
        ? '  ← override took effect ✓'
        : '  ← UNEXPECTED: override did not fire'),
  );

  banner('4a. Inventory BEFORE confirm');
  console.log(await readInventory(variant.id, warehouse.id));

  banner('4b. Confirm SO');
  const confirmed = await confirmSalesOrder(db, so.id);
  console.log({
    id: confirmed.id,
    status: confirmed.status,
    confirmedAt: confirmed.confirmedAt,
    line0Reserved: confirmed.lines[0].qtyReserved.toString(),
  });

  banner('4c. Inventory AFTER confirm (reserved should be +5)');
  console.log(await readInventory(variant.id, warehouse.id));

  banner('5a. Inventory BEFORE close');
  console.log(await readInventory(variant.id, warehouse.id));

  banner('5b. Close SO (pickup path: CONFIRMED -> CLOSED)');
  const closed = await closeSalesOrder(db, so.id, undefined);
  console.log({
    id: closed.id,
    status: closed.status,
    closedAt: closed.closedAt,
    line0: {
      qtyReserved: closed.lines[0].qtyReserved.toString(),
      qtyShipped: closed.lines[0].qtyShipped.toString(),
    },
  });

  banner('5c. Inventory AFTER close (onHand should be -5, reserved back to 0)');
  console.log(await readInventory(variant.id, warehouse.id));

  banner('6. Audit log entries for this SO + its CONSUME movement');
  const consumeMovementIds = (
    await db.inventoryMovement.findMany({
      where: { variantId: variant.id, warehouseId: warehouse.id, reference: closed.number },
      select: { id: true },
    })
  ).map((m) => m.id);
  const auditRows = await db.auditLog.findMany({
    where: {
      OR: [
        { entityType: 'SalesOrder', entityId: so.id },
        { entityType: 'InventoryMovement', entityId: { in: consumeMovementIds } },
      ],
    },
    orderBy: { createdAt: 'asc' },
  });
  for (const a of auditRows) {
    console.log({
      action: a.action,
      entityType: a.entityType,
      entityId: a.entityId,
      reason: a.reason,
      createdAt: a.createdAt,
    });
  }

  banner('7. Create + cancel a fresh test SO (cancellation path)');
  const cancelMe = await createSalesOrder(db, {
    customerId: customer.id,
    warehouseId: warehouse.id,
    lines: [
      {
        variantId: variant.id,
        warehouseId: warehouse.id,
        qtyOrdered: '2',
      },
    ],
  });
  await confirmSalesOrder(db, cancelMe.id);
  console.log('Inventory after confirm of cancel-target:', await readInventory(variant.id, warehouse.id));
  const cancelled = await cancelSalesOrder(db, cancelMe.id, {
    reason: 'manual flow test cancel',
  });
  console.log({
    id: cancelled.id,
    number: cancelled.number,
    status: cancelled.status,
    cancelReason: cancelled.cancelReason,
  });
  console.log('Inventory after cancel (reserved should be back to 0):', await readInventory(variant.id, warehouse.id));

  // Cleanup so the script is re-runnable. Wipe SO rows we just created plus
  // their audit rows and the CONSUME movement we generated against the seed
  // bin (the seed itself is left intact). Rolling our CONSUME back via a
  // matching adjustment keeps the seed inventory stable across re-runs.
  banner('Cleanup');
  const closeMovements = await db.inventoryMovement.findMany({
    where: { variantId: variant.id, warehouseId: warehouse.id, reference: closed.number },
  });
  for (const m of closeMovements) {
    // Reverse the CONSUME with a positive ADJUST to restore the bin so the
    // script can re-run without progressively draining the seed.
    await db.inventoryMovement.create({
      data: {
        variantId: m.variantId,
        warehouseId: m.warehouseId,
        type: 'ADJUST',
        qty: m.qty.negated(),
        reference: `MANUAL_SO_CLEANUP:${closed.number}`,
        notes: 'Manual flow test cleanup — reversing the test CONSUME',
      },
    });
  }
  // Recompute onHand from the ledger so InventoryItem stays consistent.
  const agg = await db.inventoryMovement.aggregate({
    where: { variantId: variant.id, warehouseId: warehouse.id },
    _sum: { qty: true },
  });
  await db.inventoryItem.update({
    where: { variantId_warehouseId: { variantId: variant.id, warehouseId: warehouse.id } },
    data: { onHand: agg._sum.qty ?? new Prisma.Decimal(0), reserved: new Prisma.Decimal(0) },
  });

  // Drop audit rows tied to the SOs and their movements.
  const allMovementIds = await db.inventoryMovement.findMany({
    where: {
      variantId: variant.id,
      warehouseId: warehouse.id,
      reference: { in: [closed.number, `MANUAL_SO_CLEANUP:${closed.number}`] },
    },
    select: { id: true },
  });
  if (allMovementIds.length > 0) {
    await db.auditLog.deleteMany({
      where: {
        entityType: 'InventoryMovement',
        entityId: { in: allMovementIds.map((x) => x.id) },
      },
    });
    await db.inventoryMovement.deleteMany({
      where: { id: { in: allMovementIds.map((x) => x.id) } },
    });
  }
  await db.auditLog.deleteMany({
    where: { entityType: 'SalesOrder', entityId: { in: [so.id, cancelMe.id] } },
  });
  await db.salesOrderLine.deleteMany({
    where: { salesOrderId: { in: [so.id, cancelMe.id] } },
  });
  await db.salesOrder.deleteMany({ where: { id: { in: [so.id, cancelMe.id] } } });

  // Remove the price override + its audit row so the next run starts
  // from a clean slate. (The customer + addresses stay — they're cheap
  // and ensureCustomer is idempotent.)
  await db.auditLog.deleteMany({
    where: { entityType: 'CustomerPriceOverride', entityId: override.id },
  });
  await db.customerPriceOverride.deleteMany({ where: { id: override.id } });

  console.log('Inventory after cleanup:', await readInventory(variant.id, warehouse.id));
  console.log('done');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
