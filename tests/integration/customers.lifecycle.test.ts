import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AuditAction,
  CustomerActivityKind,
  CustomerType,
  Prisma,
} from '@/generated/tenant';
import type { Customer, PrismaClient, SalesRep, PaymentTerm } from '@/generated/tenant';
import {
  createCustomer,
  getCustomer,
  listCustomers,
  softDeleteCustomer,
  updateCustomer,
} from '@/server/services/customers';
import { hasTenantDb, makeClient } from '../helpers/db';
import { wipeInvoiceArtifactsForSOs } from '../helpers/wipeInvoiceArtifacts';

const suite = hasTenantDb ? describe : describe.skip;

const TAG = 'TEST-CUSTLC';

suite('Customer master lifecycle', () => {
  let db: PrismaClient;
  let salesRep: SalesRep;
  let term: PaymentTerm;
  let altSalesRep: SalesRep;
  let altTerm: PaymentTerm;
  let testWarehouseId: string;

  beforeAll(async () => {
    db = makeClient();
    salesRep = await db.salesRep.findFirstOrThrow({ where: { code: 'UNASSIGNED' } });
    term = await db.paymentTerm.findFirstOrThrow({ where: { code: 'NET30' } });
    altSalesRep = await db.salesRep.upsert({
      where: { code: `${TAG}-REP-ALT` },
      create: { code: `${TAG}-REP-ALT`, name: 'Alt Rep' },
      update: { active: true, deletedAt: null },
    });
    altTerm = await db.paymentTerm.findFirstOrThrow({ where: { code: 'COD' } });
    const wh = await db.warehouse.upsert({
      where: { code: `${TAG}-WH` },
      create: { code: `${TAG}-WH`, name: 'Lifecycle Test WH' },
      update: { active: true, deletedAt: null },
    });
    testWarehouseId = wh.id;
  });

  beforeEach(async () => {
    await wipe(db);
  });

  afterAll(async () => {
    await wipe(db);
    await db.salesRep.deleteMany({ where: { code: { startsWith: `${TAG}-REP` } } });
    await db.warehouse.deleteMany({ where: { code: `${TAG}-WH` } });
    await db.$disconnect();
  });

  function buildInput(name: string, overrides: Partial<Parameters<typeof createCustomer>[1]> = {}) {
    return {
      name,
      salesRepId: salesRep.id,
      paymentTermId: term.id,
      billingAddress: {
        kind: 'BILLING' as const,
        line1: '123 Main',
        city: 'Dallas',
        region: 'TX',
        postalCode: '75201',
      },
      ...overrides,
    };
  }

  it('create issues CUST-YYYY-NNNNN, writes CREATE audit + seed activity row', async () => {
    const c = await createCustomer(db, buildInput(`${TAG} A`));
    expect(c.code).toMatch(/^CUST-\d{4}-\d{5}$/);
    expect(c.name).toBe(`${TAG} A`);
    expect(c.type).toBe(CustomerType.WHOLESALE_REGULAR);
    expect(c.salesRepId).toBe(salesRep.id);
    expect(c.paymentTermId).toBe(term.id);

    // Default billing address was created.
    const addresses = await db.customerAddress.findMany({
      where: { customerId: c.id, deletedAt: null },
    });
    expect(addresses).toHaveLength(1);
    expect(addresses[0].kind).toBe('BILLING');
    expect(addresses[0].isDefault).toBe(true);

    // Audit row + seed activity row.
    const audits = await db.auditLog.findMany({
      where: { entityType: 'Customer', entityId: c.id },
    });
    expect(audits.map((a) => a.action)).toContain(AuditAction.CREATE);
    const activities = await db.customerActivity.findMany({ where: { customerId: c.id } });
    expect(activities).toHaveLength(1);
    expect(activities[0].kind).toBe(CustomerActivityKind.AUTO);
    expect(activities[0].summary).toBe('customer_created');
  });

  it('composite create — billing + default ship-to + extra ship-to + contact + tag + category', async () => {
    const cat = await db.customerCategory.upsert({
      where: { code: `${TAG}-CAT-1` },
      create: { code: `${TAG}-CAT-1`, label: 'Trade Show Lead' },
      update: { active: true, deletedAt: null },
    });

    const c = await createCustomer(
      db,
      buildInput(`${TAG} Composite`, {
        defaultShippingAddress: {
          kind: 'SHIPPING' as const,
          line1: '500 Loading Dock',
          city: 'Dallas',
          region: 'TX',
          postalCode: '75202',
          isDefault: false, // service forces true
        },
        additionalShippingAddresses: [
          {
            kind: 'SHIPPING' as const,
            line1: '999 Side Door',
            city: 'Dallas',
            region: 'TX',
            postalCode: '75203',
          },
        ],
        contacts: [
          { name: 'Jane Buyer', role: 'Buyer', isPrimary: true, email: 'j@example.com' },
        ],
        tagLabels: ['Glass-Only Buyer'],
        categoryIds: [cat.id],
      }),
    );

    const addresses = await db.customerAddress.findMany({
      where: { customerId: c.id, deletedAt: null },
      orderBy: [{ kind: 'asc' }, { createdAt: 'asc' }],
    });
    expect(addresses).toHaveLength(3);
    const billing = addresses.find((a) => a.kind === 'BILLING')!;
    const shipDefault = addresses.find((a) => a.kind === 'SHIPPING' && a.isDefault === true)!;
    const shipExtra = addresses.find((a) => a.kind === 'SHIPPING' && a.isDefault === false)!;
    expect(billing.isDefault).toBe(true);
    expect(shipDefault.line1).toBe('500 Loading Dock');
    expect(shipExtra.line1).toBe('999 Side Door');

    const contacts = await db.customerContact.findMany({ where: { customerId: c.id } });
    expect(contacts).toHaveLength(1);
    expect(contacts[0].isPrimary).toBe(true);

    const tagAsg = await db.customerTagAssignment.findMany({ where: { customerId: c.id } });
    expect(tagAsg).toHaveLength(1);

    const catAsg = await db.customerCategoryAssignment.findMany({ where: { customerId: c.id } });
    expect(catAsg).toHaveLength(1);
    expect(catAsg[0].categoryId).toBe(cat.id);
  });

  it('display name is case-insensitively unique (citext)', async () => {
    await createCustomer(db, buildInput(`${TAG} Acme`));
    await expect(createCustomer(db, buildInput(`${TAG} ACME`))).rejects.toThrow();
  });

  it('partial update — tracked field change writes both AuditLog and CustomerActivity with { field, from, to }', async () => {
    const c = await createCustomer(db, buildInput(`${TAG} U`, { creditLimit: '1000' }));
    await updateCustomer(db, c.id, { creditLimit: '2500' });

    const audits = await db.auditLog.findMany({
      where: { entityType: 'Customer', entityId: c.id, action: AuditAction.UPDATE },
    });
    expect(audits).toHaveLength(1);

    const acts = await db.customerActivity.findMany({
      where: { customerId: c.id, summary: 'creditLimit_changed' },
    });
    expect(acts).toHaveLength(1);
    const detail = acts[0].detailJson as { field: string; from: string | null; to: string | null };
    expect(detail.field).toBe('creditLimit');
    expect(detail.from).toBe(new Prisma.Decimal('1000').toString());
    expect(detail.to).toBe(new Prisma.Decimal('2500').toString());
  });

  it('partial update — non-tracked field writes AuditLog only, NO CustomerActivity row', async () => {
    const c = await createCustomer(db, buildInput(`${TAG} NT`));
    await updateCustomer(db, c.id, { primaryEmail: 'new@example.com' });

    const audits = await db.auditLog.findMany({
      where: { entityType: 'Customer', entityId: c.id, action: AuditAction.UPDATE },
    });
    expect(audits).toHaveLength(1);

    const acts = await db.customerActivity.findMany({
      where: { customerId: c.id, kind: CustomerActivityKind.AUTO, summary: { endsWith: '_changed' } },
    });
    expect(acts).toHaveLength(0);
  });

  it('partial update — multiple tracked fields write multiple activity rows', async () => {
    const c = await createCustomer(db, buildInput(`${TAG} M`));
    await updateCustomer(db, c.id, {
      type: CustomerType.WHOLESALE_DISTRIBUTOR,
      salesRepId: altSalesRep.id,
      paymentTermId: altTerm.id,
    });
    const acts = await db.customerActivity.findMany({
      where: { customerId: c.id, kind: CustomerActivityKind.AUTO },
      orderBy: { createdAt: 'asc' },
    });
    // seed (customer_created) + 3 changes
    expect(acts).toHaveLength(4);
    expect(new Set(acts.slice(1).map((a) => a.summary))).toEqual(
      new Set(['type_changed', 'salesRepId_changed', 'paymentTermId_changed']),
    );
  });

  it('softDelete blocked when a non-deleted SalesOrder references the customer', async () => {
    const c = await createCustomer(db, buildInput(`${TAG} SoBlk`));

    // Make a SO referencing this customer.
    await db.salesOrder.create({
      data: {
        number: `SO-TEST-${Date.now()}`,
        customerId: c.id,
        warehouseId: testWarehouseId,
      },
    });
    await expect(softDeleteCustomer(db, c.id)).rejects.toThrow(
      /1 non-deleted sales order\(s\) reference it/,
    );

    // After SO soft-delete the customer can be soft-deleted.
    await db.salesOrder.updateMany({
      where: { customerId: c.id },
      data: { deletedAt: new Date() },
    });
    const deleted = await softDeleteCustomer(db, c.id);
    expect(deleted.deletedAt).not.toBeNull();
    expect(await getCustomer(db, c.id)).toBeNull();
  });

  it('listCustomers filters by type, salesRepId, q (citext substring)', async () => {
    await createCustomer(db, buildInput(`${TAG} Reg`, { type: CustomerType.WHOLESALE_REGULAR }));
    await createCustomer(db, buildInput(`${TAG} Dist`, {
      type: CustomerType.WHOLESALE_DISTRIBUTOR,
      salesRepId: altSalesRep.id,
    }));

    const allRegular = (await listCustomers(db, { type: CustomerType.WHOLESALE_REGULAR })).filter(
      (c) => c.name.startsWith(TAG),
    );
    expect(allRegular.map((c) => c.name).sort()).toEqual([`${TAG} Reg`]);

    const byRep = (await listCustomers(db, { salesRepId: altSalesRep.id })).filter(
      (c) => c.name.startsWith(TAG),
    );
    expect(byRep.map((c) => c.name)).toEqual([`${TAG} Dist`]);

    // citext substring match.
    const byQ = (await listCustomers(db, { q: 'reg' })).filter((c) => c.name.startsWith(TAG));
    expect(byQ.map((c) => c.name)).toEqual([`${TAG} Reg`]);
  });
});

async function wipe(db: PrismaClient): Promise<void> {
  // Scope by name prefix and the matching code prefix.
  const ours = await db.customer.findMany({
    where: { OR: [{ name: { startsWith: TAG } }, { code: { startsWith: `${TAG}-` } }] },
    select: { id: true },
  });
  const ids = ours.map((o) => o.id);
  if (ids.length === 0) {
    await db.customerCategory.deleteMany({ where: { code: { startsWith: TAG } } });
    return;
  }
  // Hard-delete dependent rows we created in tests.
  const ourSos = await db.salesOrder.findMany({
    where: { customerId: { in: ids } },
    select: { id: true },
  });
  await wipeInvoiceArtifactsForSOs(db, ourSos.map((s) => s.id));
  await db.salesOrder.deleteMany({ where: { customerId: { in: ids } } });
  await db.customerActivity.deleteMany({ where: { customerId: { in: ids } } });
  await db.customerAddress.deleteMany({ where: { customerId: { in: ids } } });
  await db.customerContact.deleteMany({ where: { customerId: { in: ids } } });
  await db.customerTagAssignment.deleteMany({ where: { customerId: { in: ids } } });
  await db.customerCategoryAssignment.deleteMany({ where: { customerId: { in: ids } } });
  await db.auditLog.deleteMany({
    where: { entityType: 'Customer', entityId: { in: ids } },
  });
  await db.auditLog.deleteMany({
    where: { entityType: { in: ['CustomerAddress', 'CustomerContact'] } },
  });
  await db.customer.deleteMany({ where: { id: { in: ids } } });
  await db.customerCategory.deleteMany({ where: { code: { startsWith: TAG } } });
  await db.customerTag.deleteMany({ where: { label: 'Glass-Only Buyer' } });
}
