import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { InvoiceStatus, Prisma } from '@/generated/tenant';
import type { PrismaClient } from '@/generated/tenant';
import {
  closeSalesOrder,
  confirmSalesOrder,
  createSalesOrder,
} from '@/server/services/salesOrders';
import {
  createDraftReceipt,
  postReceipt,
} from '@/server/services/receipts';
import { postCogsForInvoiceTx } from '@/server/services/cogsPosting';
import { setSetting } from '@/server/services/settings';
import {
  SETTING_KEYS,
  negativeInventoryAllowedValueSchema,
} from '@/lib/validation/settings';
import { hasTenantDb, makeClient } from '../helpers/db';
import { upsertTestCustomer } from '../helpers/customerStub';
import { upsertTestWarehouse } from '../helpers/warehouseStub';
import { wipeInvoiceArtifactsForSOs } from '../helpers/wipeInvoiceArtifacts';

const suite = hasTenantDb ? describe : describe.skip;

const TAG = 'TEST-COGS';

suite('COGS posting (Part 3 of costing engine)', () => {
  let db: PrismaClient;
  let customerId: string;
  let vendorId: string;
  let warehouseAId: string;
  let warehouseBId: string;
  let unlinkedWarehouseId: string;
  let productId: string;
  let variantId: string;
  let variantBId: string;

  beforeAll(async () => {
    db = makeClient();
    const c = await upsertTestCustomer(db, {
      code: `${TAG}-CUST`,
      name: 'COGS Test Customer',
    });
    customerId = c.id;
    const v = await db.vendor.upsert({
      where: { code: `${TAG}-VEND` },
      create: { code: `${TAG}-VEND`, name: 'COGS Test Vendor' },
      update: { active: true, deletedAt: null },
    });
    vendorId = v.id;
    const wa = await upsertTestWarehouse(db, {
      code: `${TAG}-WH-A`,
      name: 'COGS WH A',
    });
    const wb = await upsertTestWarehouse(db, {
      code: `${TAG}-WH-B`,
      name: 'COGS WH B',
    });
    warehouseAId = wa.id;
    warehouseBId = wb.id;
    // Intentionally NOT linked to an inventory account — used by the
    // strict-throw test.
    const unlinked = await db.warehouse.upsert({
      where: { code: `${TAG}-WH-UNLINKED` },
      create: { code: `${TAG}-WH-UNLINKED`, name: 'COGS WH Unlinked' },
      update: { active: true, deletedAt: null, inventoryAccountId: null },
    });
    unlinkedWarehouseId = unlinked.id;

    const product = await db.product.upsert({
      where: { sku: `${TAG}-PROD` },
      create: {
        sku: `${TAG}-PROD`,
        name: 'COGS Test Product',
        basePrice: new Prisma.Decimal('20'),
      },
      update: { active: true, deletedAt: null, basePrice: new Prisma.Decimal('20') },
    });
    productId = product.id;
    const va = await db.productVariant.upsert({
      where: { sku: `${TAG}-PROD-V1` },
      create: { productId: product.id, sku: `${TAG}-PROD-V1`, name: 'V1' },
      update: { productId: product.id, active: true, deletedAt: null },
    });
    variantId = va.id;
    const vb = await db.productVariant.upsert({
      where: { sku: `${TAG}-PROD-V2` },
      create: { productId: product.id, sku: `${TAG}-PROD-V2`, name: 'V2' },
      update: { productId: product.id, active: true, deletedAt: null },
    });
    variantBId = vb.id;
  });

  beforeEach(async () => {
    await wipe();
  });

  afterEach(async () => {
    // Reset neg-inv flag back to false so test order doesn't matter.
    // Test 4 below flips it ON; this ensures the rest of the suite (and
    // subsequent suites) see the documented default.
    await db.setting.update({
      where: { key: SETTING_KEYS.NEGATIVE_INVENTORY_ALLOWED },
      data: { value: { allowed: false } },
    });
    const settingRow = await db.setting.findUnique({
      where: { key: SETTING_KEYS.NEGATIVE_INVENTORY_ALLOWED },
      select: { id: true },
    });
    if (settingRow) {
      await db.auditLog.deleteMany({
        where: { entityType: 'Setting', entityId: settingRow.id },
      });
    }
  });

  afterAll(async () => {
    await wipe();
    await db.productVariant.deleteMany({
      where: { id: { in: [variantId, variantBId] } },
    });
    await db.product.deleteMany({ where: { id: productId } });
    await db.warehouse.deleteMany({
      where: {
        id: { in: [warehouseAId, warehouseBId, unlinkedWarehouseId] },
      },
    });
    await db.vendor.deleteMany({ where: { id: vendorId } });
    await db.customer.deleteMany({ where: { id: customerId } });
    await db.$disconnect();
  });

  // --------------------------------------------------------------------------
  // Scoped cleanup — walks the FK graph children-first across SO/Invoice/JE/
  // FifoLayer/FifoConsumption/InventoryMovement/Receipt, all scoped to this
  // suite's variants/warehouses/customer.
  // --------------------------------------------------------------------------
  async function wipe(): Promise<void> {
    const variantIds = [variantId, variantBId];
    const warehouseIds = [warehouseAId, warehouseBId, unlinkedWarehouseId];

    // Collect SO ids first so wipeInvoiceArtifacts can join the invoices.
    const sos = await db.salesOrder.findMany({
      where: { customerId },
      select: { id: true },
    });
    const soIds = sos.map((s) => s.id);

    await wipeInvoiceArtifactsForSOs(db, soIds);

    // SOLines reference InventoryMovement — null the FK before deleting
    // movements (movements are deleted further down via the variantIds
    // path). Same trick wipeInvoiceArtifacts uses for receipt lines.
    await db.salesOrderLine.updateMany({
      where: { salesOrderId: { in: soIds } },
      data: { inventoryMovementId: null },
    });
    await db.salesOrderLine.deleteMany({
      where: { salesOrderId: { in: soIds } },
    });
    if (soIds.length > 0) {
      await db.auditLog.deleteMany({
        where: { entityType: 'SalesOrder', entityId: { in: soIds } },
      });
    }
    await db.salesOrder.deleteMany({ where: { id: { in: soIds } } });

    // FIFO layers + consumptions + movements + receipts for the variants.
    const layers = await db.fifoLayer.findMany({
      where: { variantId: { in: variantIds } },
      select: { id: true },
    });
    const layerIds = layers.map((l) => l.id);

    const movements = await db.inventoryMovement.findMany({
      where: { variantId: { in: variantIds } },
      select: { id: true },
    });
    const movementIds = movements.map((m) => m.id);

    if (layerIds.length > 0) {
      await db.fifoConsumption.deleteMany({
        where: { layerId: { in: layerIds } },
      });
      await db.auditLog.deleteMany({
        where: { entityType: 'FifoLayer', entityId: { in: layerIds } },
      });
      await db.fifoLayer.deleteMany({ where: { id: { in: layerIds } } });
    }
    if (movementIds.length > 0) {
      await db.fifoConsumption.deleteMany({
        where: { movementId: { in: movementIds } },
      });
      await db.auditLog.deleteMany({
        where: { entityType: 'InventoryMovement', entityId: { in: movementIds } },
      });
      await db.receiptLine.updateMany({
        where: { inventoryMovementId: { in: movementIds } },
        data: { inventoryMovementId: null },
      });
    }
    await db.receiptLine.deleteMany({ where: { variantId: { in: variantIds } } });
    await db.receipt.deleteMany({ where: { vendorId } });
    if (movementIds.length > 0) {
      await db.inventoryMovement.deleteMany({ where: { id: { in: movementIds } } });
    }
    await db.inventoryItem.deleteMany({
      where: { variantId: { in: variantIds }, warehouseId: { in: warehouseIds } },
    });
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  // Stock the bin via a real Receipt → postReceipt → FifoLayer creation
  // path. Necessary because postCogsForInvoiceTx reads from
  // FifoConsumption rows produced by consumeFromLayersTx, which only fire
  // when there are layers to walk.
  async function stockBinViaReceipt(
    qty: string,
    unitCost: string,
    opts?: { variant?: string; warehouse?: string },
  ): Promise<void> {
    const v = opts?.variant ?? variantId;
    const w = opts?.warehouse ?? warehouseAId;
    const draft = await createDraftReceipt(db, {
      vendorId,
      warehouseId: w,
      lines: [{ variantId: v, warehouseId: w, qtyReceived: qty, unitCost }],
    });
    await postReceipt(db, draft.id);
  }

  async function createConfirmedSO(opts: {
    qty: string;
    variant?: string;
    warehouse?: string;
  }): Promise<string> {
    const v = opts.variant ?? variantId;
    const w = opts.warehouse ?? warehouseAId;
    const so = await createSalesOrder(db, {
      customerId,
      warehouseId: w,
      lines: [{ variantId: v, warehouseId: w, qtyOrdered: opts.qty }],
    });
    await confirmSalesOrder(db, so.id);
    return so.id;
  }

  async function getInvoiceForSO(soId: string) {
    return db.invoice.findUniqueOrThrow({ where: { salesOrderId: soId } });
  }

  async function getCogsJe(invoiceId: string) {
    return db.journalEntry.findFirst({
      where: {
        entityType: 'Invoice',
        entityId: invoiceId,
        description: { startsWith: 'Post COGS for invoice' },
      },
      include: { lines: { include: { account: true } } },
    });
  }

  // ==========================================================================
  // Forward path
  // ==========================================================================

  it('closeSalesOrder posts a COGS JE: DR 5100 / CR 1310 at FIFO cost; flips Invoice.cogsPosted', async () => {
    await stockBinViaReceipt('10', '4'); // 10 units @ $4 layer

    const soId = await createConfirmedSO({ qty: '6' });
    await closeSalesOrder(db, soId, undefined);

    const invoice = await getInvoiceForSO(soId);
    expect(invoice.cogsPosted).toBe(true);

    const je = await getCogsJe(invoice.id);
    expect(je).not.toBeNull();
    expect(je!.lines).toHaveLength(2);

    const dr = je!.lines.find((l) => l.account.code === '5100')!;
    const cr = je!.lines.find((l) => l.account.code === '1310')!;
    // 6 units @ $4 = $24.
    expect(dr.debit.toString()).toBe(new Prisma.Decimal('24').toString());
    expect(cr.credit.toString()).toBe(new Prisma.Decimal('24').toString());
    expect(dr.credit.toString()).toBe(new Prisma.Decimal('0').toString());
    expect(cr.debit.toString()).toBe(new Prisma.Decimal('0').toString());
  });

  it('multi-layer FIFO consume produces COGS = SUM(qty * layerCost) — 5@$1 + 2@$3 → DR 11', async () => {
    await stockBinViaReceipt('5', '1');
    await stockBinViaReceipt('5', '3');
    const soId = await createConfirmedSO({ qty: '7' });
    await closeSalesOrder(db, soId, undefined);

    const invoice = await getInvoiceForSO(soId);
    const je = await getCogsJe(invoice.id);
    expect(je).not.toBeNull();
    // 5 * 1 + 2 * 3 = 11. Exact at column precision.
    const dr = je!.lines.find((l) => l.account.code === '5100')!;
    expect(dr.debit.toFixed(5)).toBe(new Prisma.Decimal('11').toFixed(5));
  });

  it('multi-warehouse SO produces ONE JE with one CR per warehouse', async () => {
    // Warehouse A: 4 units @ $5 = $20. Warehouse B: 3 units @ $7 = $21.
    await stockBinViaReceipt('4', '5', { warehouse: warehouseAId });
    await stockBinViaReceipt('3', '7', {
      variant: variantBId,
      warehouse: warehouseBId,
    });

    // Two-line SO touching both warehouses.
    const so = await createSalesOrder(db, {
      customerId,
      warehouseId: warehouseAId,
      lines: [
        { variantId, warehouseId: warehouseAId, qtyOrdered: '4' },
        { variantId: variantBId, warehouseId: warehouseBId, qtyOrdered: '3' },
      ],
    });
    await confirmSalesOrder(db, so.id);
    await closeSalesOrder(db, so.id, undefined);

    const invoice = await getInvoiceForSO(so.id);
    const je = await getCogsJe(invoice.id);
    expect(je).not.toBeNull();
    // 1 DR + 2 CR (both warehouses share the seeded 1310 account, so the
    // CR lines collapse to ONE in the JE because they share an account).
    // Wait — they DON'T collapse. cogsPosting groups by warehouseId, not
    // by account code. Both warehouses share account 1310 in the pilot,
    // so the JE has one DR + two CRs with the same account but different
    // memos.
    expect(je!.lines).toHaveLength(3);
    const drs = je!.lines.filter((l) => l.debit.greaterThan(0));
    const crs = je!.lines.filter((l) => l.credit.greaterThan(0));
    expect(drs).toHaveLength(1);
    expect(crs).toHaveLength(2);
    expect(drs[0].account.code).toBe('5100');
    // Total credits = 41.
    const crTotal = crs.reduce((acc, l) => acc.plus(l.credit), new Prisma.Decimal(0));
    expect(crTotal.toFixed(5)).toBe(new Prisma.Decimal('41').toFixed(5));
    expect(drs[0].debit.toFixed(5)).toBe(new Prisma.Decimal('41').toFixed(5));
  });

  it('SOLine.inventoryMovementId is set during close (Part 3 schema addition)', async () => {
    await stockBinViaReceipt('5', '2');
    const soId = await createConfirmedSO({ qty: '3' });
    await closeSalesOrder(db, soId, undefined);

    const sols = await db.salesOrderLine.findMany({
      where: { salesOrderId: soId },
    });
    expect(sols).toHaveLength(1);
    expect(sols[0].inventoryMovementId).not.toBeNull();
    const mv = await db.inventoryMovement.findUniqueOrThrow({
      where: { id: sols[0].inventoryMovementId! },
    });
    expect(mv.type).toBe('CONSUME');
  });

  // ==========================================================================
  // Idempotency
  // ==========================================================================

  it('postCogsForInvoiceTx is idempotent: re-call after closeSalesOrder no-ops', async () => {
    await stockBinViaReceipt('5', '2');
    const soId = await createConfirmedSO({ qty: '3' });
    await closeSalesOrder(db, soId, undefined);

    const invoice = await getInvoiceForSO(soId);
    expect(invoice.cogsPosted).toBe(true);

    // Re-call directly — should short-circuit on the cogsPosted flag.
    const result = await db.$transaction((tx) =>
      postCogsForInvoiceTx(tx, invoice.id),
    );
    expect(result.skipped).toBe('already_posted');
    expect(result.jeId).toBeNull();

    // Exactly one COGS JE exists (no duplicate).
    const cogsJes = await db.journalEntry.count({
      where: {
        entityType: 'Invoice',
        entityId: invoice.id,
        description: { startsWith: 'Post COGS for invoice' },
      },
    });
    expect(cogsJes).toBe(1);
  });

  // ==========================================================================
  // Strict-throw on unlinked warehouse
  // ==========================================================================

  it('throws "no inventoryAccountId" when SOLine.warehouse has no inventoryAccount link', async () => {
    // Use the unlinked warehouse — close should fail before COGS can post.
    // We bypass postReceipt (which doesn't require inventoryAccountId) and
    // seed a layer the same way fifoLayers tests do, so the consume
    // succeeds but COGS posting then sees a null inventoryAccount.
    const draft = await createDraftReceipt(db, {
      vendorId,
      warehouseId: unlinkedWarehouseId,
      lines: [
        {
          variantId,
          warehouseId: unlinkedWarehouseId,
          qtyReceived: '5',
          unitCost: '4',
        },
      ],
    });
    await postReceipt(db, draft.id);

    const so = await createSalesOrder(db, {
      customerId,
      warehouseId: unlinkedWarehouseId,
      lines: [
        { variantId, warehouseId: unlinkedWarehouseId, qtyOrdered: '3' },
      ],
    });
    await confirmSalesOrder(db, so.id);

    await expect(closeSalesOrder(db, so.id, undefined)).rejects.toThrow(
      /has no inventoryAccountId/,
    );

    // Tx rolled back — Invoice exists is FALSE, layer untouched, etc.
    const invoice = await db.invoice.findFirst({ where: { salesOrderId: so.id } });
    expect(invoice).toBeNull();
  });

  // ==========================================================================
  // Audit
  // ==========================================================================

  it('writes an AuditLog row for the cogsPosted state change', async () => {
    await stockBinViaReceipt('5', '6');
    const soId = await createConfirmedSO({ qty: '2' });
    await closeSalesOrder(db, soId, undefined);

    const invoice = await getInvoiceForSO(soId);
    const audits = await db.auditLog.findMany({
      where: { entityType: 'Invoice', entityId: invoice.id, action: 'UPDATE' },
    });
    // Exactly one UPDATE audit row from the COGS post.
    expect(audits.length).toBeGreaterThanOrEqual(1);
    const cogsAudit = audits.find(
      (a) =>
        a.afterJson != null &&
        typeof a.afterJson === 'object' &&
        (a.afterJson as Record<string, unknown>).cogsPosted === true,
    );
    expect(cogsAudit).toBeDefined();
    const after = cogsAudit!.afterJson as Record<string, unknown>;
    expect(after.cogsAmount).toBe(new Prisma.Decimal('12').toString());
  });

  // ==========================================================================
  // Zero-COGS path + skippedLines reason codes
  // ==========================================================================

  it('zero-COGS invoice (all lines have no SO link) flips flag, writes audit row, posts no JE, re-call short-circuits', async () => {
    // Manually craft an Invoice with one InvoiceLine whose salesOrderLineId
    // is null — simulating a drop-ship/service-only invoice. The SO row
    // exists (Invoice.salesOrderId is required + unique) but isn't closed.
    const so = await createSalesOrder(db, {
      customerId,
      warehouseId: warehouseAId,
      lines: [{ variantId, warehouseId: warehouseAId, qtyOrdered: '1' }],
    });
    await confirmSalesOrder(db, so.id);

    const invoice = await db.invoice.create({
      data: {
        number: `${TAG}-INV-ZERO-${Math.random().toString(36).slice(2, 8)}`,
        salesOrderId: so.id,
        customerId,
        warehouseId: warehouseAId,
        status: InvoiceStatus.OPEN,
        subtotal: new Prisma.Decimal('10'),
        total: new Prisma.Decimal('10'),
        lines: {
          create: [
            {
              salesOrderLineId: null,
              variantId,
              description: 'Drop-ship line',
              qty: new Prisma.Decimal('1'),
              unitPrice: new Prisma.Decimal('10'),
              lineTotal: new Prisma.Decimal('10'),
            },
          ],
        },
      },
      include: { lines: true },
    });
    expect(invoice.cogsPosted).toBe(false);

    const result = await db.$transaction((tx) =>
      postCogsForInvoiceTx(tx, invoice.id),
    );

    expect(result.skipped).toBe('zero_cogs');
    expect(result.jeId).toBeNull();
    expect(result.cogsAmount.equals(new Prisma.Decimal(0))).toBe(true);
    expect(result.warehousesPosted).toEqual([]);

    // Flag flipped on the persisted row.
    const after = await db.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(after.cogsPosted).toBe(true);

    // No COGS JE was posted.
    const cogsJe = await getCogsJe(invoice.id);
    expect(cogsJe).toBeNull();

    // Zero-COGS path emits an UPDATE audit row tagged reason='zero_cogs'.
    const audits = await db.auditLog.findMany({
      where: { entityType: 'Invoice', entityId: invoice.id, action: 'UPDATE' },
    });
    const zeroAudit = audits.find(
      (a) =>
        a.afterJson != null &&
        typeof a.afterJson === 'object' &&
        (a.afterJson as Record<string, unknown>).reason === 'zero_cogs',
    );
    expect(zeroAudit).toBeDefined();

    // Re-call short-circuits via the cogsPosted flag (layer-1 idempotency).
    const re = await db.$transaction((tx) =>
      postCogsForInvoiceTx(tx, invoice.id),
    );
    expect(re.skipped).toBe('already_posted');
    expect(re.jeId).toBeNull();
  });

  it('skippedLines records no_inventory_movement when SOLine has null inventoryMovementId', async () => {
    // SOLines created via createSalesOrder default to inventoryMovementId=null
    // because the FK is set by closeSalesOrder. A manually-crafted Invoice
    // pointing at an unclosed SO's line therefore exercises the
    // no_inventory_movement skip path (legacy / build-component case).
    const so = await createSalesOrder(db, {
      customerId,
      warehouseId: warehouseAId,
      lines: [{ variantId, warehouseId: warehouseAId, qtyOrdered: '2' }],
    });
    await confirmSalesOrder(db, so.id);
    const sol = await db.salesOrderLine.findFirstOrThrow({
      where: { salesOrderId: so.id },
    });
    expect(sol.inventoryMovementId).toBeNull();

    const invoice = await db.invoice.create({
      data: {
        number: `${TAG}-INV-NOMV-${Math.random().toString(36).slice(2, 8)}`,
        salesOrderId: so.id,
        customerId,
        warehouseId: warehouseAId,
        status: InvoiceStatus.OPEN,
        subtotal: new Prisma.Decimal('20'),
        total: new Prisma.Decimal('20'),
        lines: {
          create: [
            {
              salesOrderLineId: sol.id,
              variantId,
              description: 'No movement line',
              qty: new Prisma.Decimal('2'),
              unitPrice: new Prisma.Decimal('10'),
              lineTotal: new Prisma.Decimal('20'),
            },
          ],
        },
      },
      include: { lines: true },
    });

    const result = await db.$transaction((tx) =>
      postCogsForInvoiceTx(tx, invoice.id),
    );

    expect(result.skipped).toBe('zero_cogs');
    expect(result.skippedLines).toHaveLength(1);
    expect(result.skippedLines[0].reason).toBe('no_inventory_movement');
    expect(result.skippedLines[0].invoiceLineId).toBe(invoice.lines[0].id);
  });

  it('skippedLines records no_so_link when InvoiceLine has null salesOrderLineId', async () => {
    const so = await createSalesOrder(db, {
      customerId,
      warehouseId: warehouseAId,
      lines: [{ variantId, warehouseId: warehouseAId, qtyOrdered: '1' }],
    });
    await confirmSalesOrder(db, so.id);

    const invoice = await db.invoice.create({
      data: {
        number: `${TAG}-INV-NOLINK-${Math.random().toString(36).slice(2, 8)}`,
        salesOrderId: so.id,
        customerId,
        warehouseId: warehouseAId,
        status: InvoiceStatus.OPEN,
        subtotal: new Prisma.Decimal('5'),
        total: new Prisma.Decimal('5'),
        lines: {
          create: [
            {
              salesOrderLineId: null,
              variantId,
              description: 'Service line — no SO link',
              qty: new Prisma.Decimal('1'),
              unitPrice: new Prisma.Decimal('5'),
              lineTotal: new Prisma.Decimal('5'),
            },
          ],
        },
      },
      include: { lines: true },
    });

    const result = await db.$transaction((tx) =>
      postCogsForInvoiceTx(tx, invoice.id),
    );

    expect(result.skipped).toBe('zero_cogs');
    expect(result.skippedLines).toHaveLength(1);
    expect(result.skippedLines[0].reason).toBe('no_so_link');
    expect(result.skippedLines[0].invoiceLineId).toBe(invoice.lines[0].id);
  });

  // ==========================================================================
  // negative_allocation sub-case B partial COGS contribution
  // ==========================================================================

  it('negative_allocation sub-case B contributes partial COGS for the covered portion', async () => {
    // Flip neg-inv flag ON for this test; afterEach resets to false.
    await setSetting(
      db,
      SETTING_KEYS.NEGATIVE_INVENTORY_ALLOWED,
      { allowed: true },
      negativeInventoryAllowedValueSchema,
    );

    // Stock 3 units @ $5. SO orders 10 → consume drains the layer (3 covered)
    // and over-draws by 7 (negative-allocation portion).
    await stockBinViaReceipt('3', '5');
    const soId = await createConfirmedSO({ qty: '10' });
    await closeSalesOrder(db, soId, undefined);

    // Sanity: Phase 1C marked the movement as negative-allocated.
    const sol = await db.salesOrderLine.findFirstOrThrow({
      where: { salesOrderId: soId },
    });
    expect(sol.inventoryMovementId).not.toBeNull();
    const mv = await db.inventoryMovement.findUniqueOrThrow({
      where: { id: sol.inventoryMovementId! },
    });
    expect(mv.negativeAllocation).toBe(true);

    // Sanity: 1 FifoConsumption row for the 3-unit covered portion. The
    // 7-unit over-draw has no layer to attribute to → no consumption row.
    const consumptions = await db.fifoConsumption.findMany({
      where: { movementId: mv.id },
    });
    expect(consumptions).toHaveLength(1);
    expect(consumptions[0].qty.toString()).toBe(new Prisma.Decimal('3').toString());
    expect(consumptions[0].unitCost.toString()).toBe(new Prisma.Decimal('5').toString());

    // COGS posted at the partial cost: 3 * 5 = 15. Per the sub-case B
    // documentation in cogsPosting.ts, the over-draw sits as future retro-
    // adjustment work; the JE today is honest about the partial.
    const invoice = await getInvoiceForSO(soId);
    expect(invoice.cogsPosted).toBe(true);
    const je = await getCogsJe(invoice.id);
    expect(je).not.toBeNull();
    const dr = je!.lines.find((l) => l.account.code === '5100')!;
    const cr = je!.lines.find((l) => l.account.code === '1310')!;
    expect(dr.debit.toFixed(5)).toBe(new Prisma.Decimal('15').toFixed(5));
    expect(cr.credit.toFixed(5)).toBe(new Prisma.Decimal('15').toFixed(5));
  });
});
