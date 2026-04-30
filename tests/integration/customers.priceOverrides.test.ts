import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AuditAction,
  CustomerActivityKind,
  PriceResolutionRule,
  Prisma,
} from '@/generated/tenant';
import type {
  Customer,
  PaymentTerm,
  PrismaClient,
  Product,
  ProductVariant,
  SalesRep,
} from '@/generated/tenant';
import { createCustomer } from '@/server/services/customers';
import {
  bulkImportFromCsv,
  createOverride,
  listOverridesForCustomer,
  softDeleteOverride,
  updateOverride,
} from '@/server/services/customerPriceOverrides';
import { createSalesOrder } from '@/server/services/salesOrders';
import { hasTenantDb, makeClient } from '../helpers/db';

const suite = hasTenantDb ? describe : describe.skip;

const TAG = 'TEST-CPO';

suite('CustomerPriceOverride service + CSV importer', () => {
  let db: PrismaClient;
  let salesRep: SalesRep;
  let term: PaymentTerm;
  let customer: Customer;
  let warehouseId: string;
  let product: Product;
  const variants: ProductVariant[] = [];

  beforeAll(async () => {
    db = makeClient();
    salesRep = await db.salesRep.findFirstOrThrow({ where: { code: 'UNASSIGNED' } });
    term = await db.paymentTerm.findFirstOrThrow({ where: { code: 'NET30' } });
    const wh = await db.warehouse.upsert({
      where: { code: `${TAG}-WH` },
      create: { code: `${TAG}-WH`, name: 'CPO WH' },
      update: { active: true, deletedAt: null },
    });
    warehouseId = wh.id;
    product = await db.product.upsert({
      where: { sku: `${TAG}-PROD` },
      create: {
        sku: `${TAG}-PROD`,
        name: 'CPO Product',
        basePrice: new Prisma.Decimal('10.00'),
      },
      update: {
        active: true,
        deletedAt: null,
        basePrice: new Prisma.Decimal('10.00'),
      },
    });
    for (let i = 1; i <= 6; i++) {
      const v = await db.productVariant.upsert({
        where: { sku: `${TAG}-V${i}` },
        create: { productId: product.id, sku: `${TAG}-V${i}`, name: `V${i}` },
        update: { productId: product.id, active: true, deletedAt: null },
      });
      variants.push(v);
    }
  });

  beforeEach(async () => {
    await wipe(db);
    customer = await createCustomer(db, {
      name: `${TAG} Customer`,
      salesRepId: salesRep.id,
      paymentTermId: term.id,
      billingAddress: {
        kind: 'BILLING',
        line1: '1 St',
        city: 'Dallas',
        region: 'TX',
        postalCode: '75201',
      },
    });
  });

  afterAll(async () => {
    await wipe(db);
    await db.productVariant.deleteMany({ where: { productId: product.id } });
    await db.product.deleteMany({ where: { id: product.id } });
    await db.warehouse.deleteMany({ where: { code: `${TAG}-WH` } });
    await db.$disconnect();
  });

  // ---------- CRUD ----------

  it('createOverride / list / update / softDelete round-trip', async () => {
    const created = await createOverride(db, customer.id, {
      variantId: variants[0].id,
      unitPrice: '7.50',
    });
    expect(created.unitPrice.toString()).toBe(new Prisma.Decimal('7.50').toString());

    const listed = await listOverridesForCustomer(db, customer.id);
    expect(listed).toHaveLength(1);

    const updated = await updateOverride(db, created.id, { unitPrice: '6.25' });
    expect(updated.unitPrice.toString()).toBe(new Prisma.Decimal('6.25').toString());

    const deleted = await softDeleteOverride(db, created.id);
    expect(deleted.deletedAt).not.toBeNull();
    const listedAfter = await listOverridesForCustomer(db, customer.id);
    expect(listedAfter).toHaveLength(0);
  });

  it('partial unique enforcement — second active override for same (customer, variant) throws', async () => {
    await createOverride(db, customer.id, {
      variantId: variants[0].id,
      unitPrice: '5.00',
    });
    await expect(
      createOverride(db, customer.id, {
        variantId: variants[0].id,
        unitPrice: '4.00',
      }),
    ).rejects.toThrow();
  });

  it('soft-deleting an override frees the slot — new override for same (customer, variant) succeeds', async () => {
    const first = await createOverride(db, customer.id, {
      variantId: variants[0].id,
      unitPrice: '5.00',
    });
    await softDeleteOverride(db, first.id);
    const second = await createOverride(db, customer.id, {
      variantId: variants[0].id,
      unitPrice: '4.00',
    });
    expect(second.id).not.toBe(first.id);
    expect(second.unitPrice.toString()).toBe(new Prisma.Decimal('4.00').toString());

    // Both rows exist; only the second is non-deleted.
    const all = await db.customerPriceOverride.findMany({
      where: { customerId: customer.id, variantId: variants[0].id },
    });
    expect(all).toHaveLength(2);
    const live = all.filter((x) => x.deletedAt == null);
    expect(live).toHaveLength(1);
    expect(live[0].id).toBe(second.id);
  });

  // ---------- Bulk CSV ----------

  it('CSV happy path — 5 valid rows, 5 created, summary audit + activity rows written', async () => {
    const csv = [
      'sku,unitPrice',
      `${TAG}-V1,9.00`,
      `${TAG}-V2,8.50`,
      `${TAG}-V3,8.00`,
      `${TAG}-V4,7.50`,
      `${TAG}-V5,7.00`,
    ].join('\n');
    const result = await bulkImportFromCsv(db, customer.id, csv);
    expect(result.created).toBe(5);
    expect(result.updated).toBe(0);
    expect(result.errors).toEqual([]);

    const rows = await listOverridesForCustomer(db, customer.id);
    expect(rows).toHaveLength(5);

    const auditRows = await db.auditLog.findMany({
      where: { entityType: 'Customer', entityId: customer.id, action: AuditAction.UPDATE },
    });
    const importAudits = auditRows.filter(
      (a) => (a.afterJson as { operation?: string } | null)?.operation === 'price_overrides_imported',
    );
    expect(importAudits).toHaveLength(1);

    const activityRows = await db.customerActivity.findMany({
      where: {
        customerId: customer.id,
        kind: CustomerActivityKind.AUTO,
        summary: 'price_overrides_imported',
      },
    });
    expect(activityRows).toHaveLength(1);
    const detail = activityRows[0].detailJson as { created: number; updated: number; errors: number };
    expect(detail).toEqual({ created: 5, updated: 0, errors: 0 });
  });

  it('CSV mixed — 3 valid + 2 unknown SKUs → 3 created, 2 errors, no aborted tx', async () => {
    const csv = [
      'sku,unitPrice',
      `${TAG}-V1,9.00`,
      `${TAG}-NOPE-A,5.00`,
      `${TAG}-V2,8.50`,
      `${TAG}-NOPE-B,5.00`,
      `${TAG}-V3,8.00`,
    ].join('\n');
    const result = await bulkImportFromCsv(db, customer.id, csv);
    expect(result.created).toBe(3);
    expect(result.updated).toBe(0);
    expect(result.errors).toHaveLength(2);
    expect(result.errors.map((e) => e.sku).sort()).toEqual([
      `${TAG}-NOPE-A`,
      `${TAG}-NOPE-B`,
    ]);
    for (const e of result.errors) {
      expect(e.message).toMatch(/unknown SKU/);
    }
    const rows = await listOverridesForCustomer(db, customer.id);
    expect(rows).toHaveLength(3);
  });

  it('CSV updates existing — same SKU different price overwrites the row, no duplicate', async () => {
    await createOverride(db, customer.id, {
      variantId: variants[0].id,
      unitPrice: '9.99',
    });

    const csv = ['sku,unitPrice', `${TAG}-V1,5.55`].join('\n');
    const result = await bulkImportFromCsv(db, customer.id, csv);
    expect(result.created).toBe(0);
    expect(result.updated).toBe(1);

    const rows = await listOverridesForCustomer(db, customer.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].unitPrice.toString()).toBe(new Prisma.Decimal('5.55').toString());
  });

  it('UPSERT-ONLY — overrides not in the CSV are LEFT ALONE (critical contract test)', async () => {
    // Seed 5 active overrides.
    for (let i = 0; i < 5; i++) {
      await createOverride(db, customer.id, {
        variantId: variants[i].id,
        unitPrice: `${10 + i}.00`,
      });
    }
    expect(await listOverridesForCustomer(db, customer.id)).toHaveLength(5);

    // CSV only mentions 2 of them (one update, one new).
    const csv = [
      'sku,unitPrice',
      `${TAG}-V1,1.00`, // update existing V1
      `${TAG}-V6,2.00`, // new V6
    ].join('\n');
    const result = await bulkImportFromCsv(db, customer.id, csv);
    expect(result).toMatchObject({ created: 1, updated: 1, errors: [] });

    // After import: original 5 + new 1 = 6 active overrides. The 4
    // overrides for V2..V5 that weren't in the CSV are STILL THERE
    // and untouched.
    const rows = await listOverridesForCustomer(db, customer.id);
    expect(rows).toHaveLength(6);
    const v1 = rows.find((r) => r.variantId === variants[0].id)!;
    expect(v1.unitPrice.toString()).toBe(new Prisma.Decimal('1.00').toString());
    for (let i = 1; i < 5; i++) {
      const r = rows.find((x) => x.variantId === variants[i].id);
      expect(r).toBeDefined();
      expect(r!.unitPrice.toString()).toBe(new Prisma.Decimal(`${10 + i}.00`).toString());
    }
  });

  it('CSV empty → no-op, returns zeros', async () => {
    const result = await bulkImportFromCsv(db, customer.id, '');
    expect(result).toEqual({ created: 0, updated: 0, errors: [] });
  });

  it('CSV malformed (missing required columns) → all-rows fail with header error, no rows imported', async () => {
    const csv = ['name,price', `${TAG}-V1,9.00`].join('\n');
    const result = await bulkImportFromCsv(db, customer.id, csv);
    expect(result.created).toBe(0);
    expect(result.updated).toBe(0);
    expect(result.errors.length).toBeGreaterThan(0);
    // Both required columns are flagged.
    const messages = result.errors.map((e) => e.message).join(' | ');
    expect(messages).toMatch(/missing required column: sku/);
    expect(messages).toMatch(/missing required column: unitPrice/);
    const rows = await listOverridesForCustomer(db, customer.id);
    expect(rows).toHaveLength(0);
  });

  it('CSV — single audit row + single activity row written, NOT per-row', async () => {
    const csv = [
      'sku,unitPrice',
      `${TAG}-V1,9.00`,
      `${TAG}-V2,8.00`,
      `${TAG}-V3,7.00`,
    ].join('\n');
    await bulkImportFromCsv(db, customer.id, csv);

    const overrideAudits = await db.auditLog.findMany({
      where: { entityType: 'CustomerPriceOverride' },
    });
    // Per-row CRUD audits are intentionally not written by the bulk path.
    expect(overrideAudits).toHaveLength(0);

    const activityImports = await db.customerActivity.findMany({
      where: { customerId: customer.id, summary: 'price_overrides_imported' },
    });
    expect(activityImports).toHaveLength(1);
  });

  // ---------- Resolver wiring through the real SO service ----------

  it('end-to-end: SO line for a customer with an active override resolves to CUSTOMER_SPECIFIC', async () => {
    await createOverride(db, customer.id, {
      variantId: variants[0].id,
      unitPrice: '3.33',
    });

    const so = await createSalesOrder(db, {
      customerId: customer.id,
      warehouseId,
      lines: [
        {
          variantId: variants[0].id,
          warehouseId,
          qtyOrdered: '2',
        },
      ],
    });
    expect(so.lines).toHaveLength(1);
    expect(so.lines[0].priceRule).toBe(PriceResolutionRule.CUSTOMER_SPECIFIC);
    expect(so.lines[0].unitPrice.toString()).toBe(new Prisma.Decimal('3.33').toString());

    // Cleanup the SO row so the next test starts clean.
    await db.auditLog.deleteMany({
      where: { entityType: 'SalesOrder', entityId: so.id },
    });
    await db.salesOrderLine.deleteMany({ where: { salesOrderId: so.id } });
    await db.salesOrder.deleteMany({ where: { id: so.id } });
  });
});

async function wipe(db: PrismaClient): Promise<void> {
  const customers = await db.customer.findMany({
    where: { name: { startsWith: TAG } },
    select: { id: true },
  });
  const ids = customers.map((c) => c.id);
  if (ids.length === 0) return;
  await db.salesOrderLine.deleteMany({ where: { salesOrder: { customerId: { in: ids } } } });
  await db.salesOrder.deleteMany({ where: { customerId: { in: ids } } });
  await db.customerPriceOverride.deleteMany({ where: { customerId: { in: ids } } });
  await db.customerActivity.deleteMany({ where: { customerId: { in: ids } } });
  await db.customerAddress.deleteMany({ where: { customerId: { in: ids } } });
  await db.auditLog.deleteMany({
    where: { entityType: 'Customer', entityId: { in: ids } },
  });
  await db.auditLog.deleteMany({
    where: { entityType: { in: ['CustomerAddress', 'CustomerPriceOverride'] } },
  });
  await db.customer.deleteMany({ where: { id: { in: ids } } });
}
