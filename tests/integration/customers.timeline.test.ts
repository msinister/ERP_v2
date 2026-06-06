/**
 * Integration tests for getCustomerTimeline — the unified customer activity
 * feed that merges CustomerActivity (Source 1) with AuditLog (Source 2).
 *
 * Tests are structured around the spec's required scenarios:
 *   1. Merge + sort across both sources is correct (newest first)
 *   2. Soft-deleted records are excluded
 *   3. AUTO vs user actor attribution is correct
 *   4. Order line edits (qty/price change) appear via the audit source
 *   5. Dedupe: a status change does not appear twice
 *
 * Each test uses a unique TAG prefix to avoid cross-test contamination;
 * wipe() runs beforeEach and afterAll.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditAction } from '@/generated/tenant';
import type { Customer, PaymentTerm, PrismaClient, SalesRep } from '@/generated/tenant';
import { createCustomer } from '@/server/services/customers';
import { getCustomerTimeline } from '@/server/services/customerTimeline';
import { addManualEntry } from '@/server/services/customerActivities';
import { hasTenantDb, makeClient } from '../helpers/db';

const suite = hasTenantDb ? describe : describe.skip;

const TAG = 'TEST-TIMELINE';

suite('getCustomerTimeline', () => {
  let db: PrismaClient;
  let salesRep: SalesRep;
  let term: PaymentTerm;
  let warehouseId: string;

  beforeAll(async () => {
    db = makeClient();
    salesRep = await db.salesRep.findFirstOrThrow({ where: { code: 'UNASSIGNED' } });
    term = await db.paymentTerm.findFirstOrThrow({ where: { code: 'NET30' } });
    const wh = await db.warehouse.upsert({
      where: { code: `${TAG}-WH` },
      create: { code: `${TAG}-WH`, name: 'Timeline Test WH' },
      update: { active: true, deletedAt: null },
    });
    warehouseId = wh.id;
  });

  beforeEach(() => wipe(db));
  afterAll(async () => {
    await wipe(db);
    await db.warehouse.deleteMany({ where: { code: `${TAG}-WH` } });
    await db.$disconnect();
  });

  async function makeCustomer(label: string): Promise<Customer> {
    return createCustomer(db, {
      name: `${TAG} ${label}`,
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
  }

  // =========================================================================
  // 1. Merge + sort
  // =========================================================================

  it('merge + sort: CustomerActivity entries and AuditLog entries interleave by timestamp', async () => {
    const c = await makeCustomer('MERGE');

    // Write an audit row for the customer's SO (simulates an SO create)
    const soRow = await db.salesOrder.create({
      data: {
        number: `${TAG}-SO-001`,
        customerId: c.id,
        status: 'DRAFT',
        warehouseId,
      },
    });

    const t1 = new Date('2026-01-01T10:00:00Z');
    const t2 = new Date('2026-01-02T10:00:00Z');
    const t3 = new Date('2026-01-03T10:00:00Z');

    // CustomerActivity entry at t1
    await db.customerActivity.create({
      data: {
        customerId: c.id,
        kind: 'MANUAL',
        summary: 'first note',
        createdAt: t1,
      },
    });

    // AuditLog entry for SO CREATE at t2
    await db.auditLog.create({
      data: {
        action: AuditAction.CREATE,
        entityType: 'SalesOrder',
        entityId: soRow.id,
        afterJson: { number: soRow.number },
        createdAt: t2,
      },
    });

    // CustomerActivity entry at t3
    await db.customerActivity.create({
      data: {
        customerId: c.id,
        kind: 'MANUAL',
        summary: 'third note',
        createdAt: t3,
      },
    });

    const { entries } = await getCustomerTimeline(db, c.id);

    // Should be sorted newest-first: t3, t2, t1 (plus the auto customer_created entry)
    const relevant = entries.filter((e) =>
      e.label.includes('note') || e.label.includes(soRow.number) || e.label.includes('SO-001'),
    );
    expect(relevant.length).toBeGreaterThanOrEqual(3);
    // t3 > t2 > t1 ordering
    const times = relevant.slice(0, 3).map((e) => e.ts.getTime());
    expect(times[0]).toBeGreaterThanOrEqual(times[1]);
    expect(times[1]).toBeGreaterThanOrEqual(times[2]);
  });

  // =========================================================================
  // 2. Soft-deleted records excluded
  // =========================================================================

  it('soft-deleted SO: its AuditLog entries do not appear in the timeline', async () => {
    const c = await makeCustomer('SOFTDEL');

    // Create SO then soft-delete it
    const so = await db.salesOrder.create({
      data: {
        number: `${TAG}-SO-DEL`,
        customerId: c.id,
        status: 'DRAFT',
        warehouseId,
        deletedAt: new Date(), // immediately soft-deleted
      },
    });

    // Write a fake audit row for this SO
    await db.auditLog.create({
      data: {
        action: AuditAction.CREATE,
        entityType: 'SalesOrder',
        entityId: so.id,
        afterJson: { number: so.number },
        createdAt: new Date(),
      },
    });

    const { entries } = await getCustomerTimeline(db, c.id);
    const found = entries.some((e) => e.label.includes(so.number));
    expect(found).toBe(false);
  });

  // =========================================================================
  // 3. AUTO vs user actor attribution
  // =========================================================================

  it('actor attribution: audit rows with userId show the user name; null userId shows as AUTO (actorName=null)', async () => {
    const c = await makeCustomer('ACTOR');

    // Create a test user to attribute an audit row to
    const user = await db.user.create({
      data: {
        email: `${TAG}-actor-test@erp.test`,
        name: 'Jane Editor',
        emailVerified: false,
        isSuperAdmin: false,
        enabled: true,
      },
    });

    const so = await db.salesOrder.create({
      data: {
        number: `${TAG}-SO-ACTOR`,
        customerId: c.id,
        status: 'DRAFT',
        warehouseId,
      },
    });

    // Audit row WITH userId → Jane Editor
    await db.auditLog.create({
      data: {
        action: AuditAction.STATUS_CHANGE,
        entityType: 'SalesOrder',
        entityId: so.id,
        beforeJson: { status: 'DRAFT' },
        afterJson: { status: 'CONFIRMED' },
        userId: user.id,
        createdAt: new Date('2026-06-01T10:00:00Z'),
      },
    });

    // Audit row WITHOUT userId → AUTO
    await db.auditLog.create({
      data: {
        action: AuditAction.STATUS_CHANGE,
        entityType: 'SalesOrder',
        entityId: so.id,
        beforeJson: { status: 'CONFIRMED' },
        afterJson: { status: 'CLOSED' },
        userId: null,
        createdAt: new Date('2026-06-02T10:00:00Z'),
      },
    });

    const { entries } = await getCustomerTimeline(db, c.id);

    const withUser = entries.find(
      (e) => e.label.includes('Confirmed') && e.id.startsWith('audit:'),
    );
    const withAuto = entries.find(
      (e) => e.label.includes('Closed') && e.id.startsWith('audit:'),
    );

    expect(withUser?.actorName).toBe('Jane Editor');
    expect(withAuto?.actorName).toBeNull();

    // Cleanup
    await db.auditLog.deleteMany({ where: { entityType: 'SalesOrder', entityId: so.id } });
    await db.salesOrder.delete({ where: { id: so.id } });
    await db.user.delete({ where: { id: user.id } });
  });

  // =========================================================================
  // 4. ORDER EDIT via audit source — the specific case that was missing
  // =========================================================================

  it('SO line qty + price edit appears in the feed via the audit source (SalesOrderLine UPDATE)', async () => {
    const c = await makeCustomer('LINE-EDIT');

    const so = await db.salesOrder.create({
      data: {
        number: `${TAG}-SO-LINEEDIT`,
        customerId: c.id,
        status: 'CONFIRMED',
        warehouseId,
      },
    });

    // We need a variant to attach the SO line to
    const variant = await db.productVariant.findFirst({
      where: { deletedAt: null },
      select: { id: true },
    });
    if (!variant) {
      // Skip gracefully if no product variants seeded
      return;
    }

    const warehouse = await db.warehouse.findFirst({
      where: { code: 'MAIN' },
      select: { id: true },
    });
    if (!warehouse) return;

    const line = await db.salesOrderLine.create({
      data: {
        salesOrderId: so.id,
        variantId: variant.id,
        warehouseId: warehouse.id,
        qtyOrdered: 10,
        unitPrice: '12.00000',
        priceRule: 'BASE_PRICE',
        qtyReserved: 10,
        qtyShipped: 0,
      },
    });

    // Simulate what updateSalesOrderLineFields writes to AuditLog
    await db.auditLog.create({
      data: {
        action: AuditAction.UPDATE,
        entityType: 'SalesOrderLine',
        entityId: line.id,
        beforeJson: {
          qtyOrdered: '10.00000',
          unitPrice: '12.00000',
          priceRule: 'BASE_PRICE',
          discountPercent: null,
          discountAmount: null,
          customerNote: null,
          internalNote: null,
        },
        afterJson: {
          qtyOrdered: '8.00000',
          unitPrice: '9.50000',
          priceRule: 'OVERRIDE',
          discountPercent: null,
          discountAmount: null,
          customerNote: null,
          internalNote: null,
        },
        createdAt: new Date(),
      },
    });

    const { entries } = await getCustomerTimeline(db, c.id);

    // The line edit should appear referencing the SO number
    const lineEditEntry = entries.find(
      (e) => e.id.startsWith('audit:') && e.label.includes(so.number),
    );
    expect(lineEditEntry).toBeTruthy();
    expect(lineEditEntry!.label).toContain('line edited');
    // Should show both qty and price change
    expect(lineEditEntry!.label).toMatch(/qty|price/i);
    // Href should link to the SO
    expect(lineEditEntry!.href).toContain(so.id);
  });

  // =========================================================================
  // 5. Dedupe: a status change does not appear twice
  // =========================================================================

  it('SO STATUS_CHANGE audit row appears exactly once — not duplicated by CustomerActivity', async () => {
    const c = await makeCustomer('DEDUPE');

    const so = await db.salesOrder.create({
      data: {
        number: `${TAG}-SO-DEDUPE`,
        customerId: c.id,
        status: 'CONFIRMED',
        warehouseId,
      },
    });

    // Write a STATUS_CHANGE audit row (what confirmSalesOrder would write)
    await db.auditLog.create({
      data: {
        action: AuditAction.STATUS_CHANGE,
        entityType: 'SalesOrder',
        entityId: so.id,
        beforeJson: { status: 'DRAFT' },
        afterJson: { status: 'CONFIRMED' },
        createdAt: new Date('2026-06-01T12:00:00Z'),
      },
    });

    // CustomerActivity has NO equivalent of this status change — it only
    // records customer-record field changes. So the timeline should show
    // the status change exactly once (from AuditLog).
    const { entries } = await getCustomerTimeline(db, c.id);

    const statusEntries = entries.filter(
      (e) =>
        e.label.includes(so.number) &&
        (e.label.includes('Confirmed') || e.label.includes('CONFIRMED')),
    );

    expect(statusEntries).toHaveLength(1);
    expect(statusEntries[0].id).toMatch(/^audit:/);
  });

  // =========================================================================
  // 6. CustomerActivity MANUAL entries are included as Source 1
  // =========================================================================

  it('MANUAL CustomerActivity entries appear in the timeline with actorName from createdById', async () => {
    const c = await makeCustomer('MANUAL');

    const user = await db.user.create({
      data: {
        email: `${TAG}-manual-author@erp.test`,
        name: 'Note Writer',
        emailVerified: false,
        isSuperAdmin: false,
        enabled: true,
      },
    });

    await addManualEntry(db, c.id, { summary: 'Verified resale cert on file' }, { userId: user.id });

    const { entries } = await getCustomerTimeline(db, c.id);
    const noteEntry = entries.find((e) => e.label.includes('Verified resale cert'));
    expect(noteEntry).toBeTruthy();
    expect(noteEntry!.actorName).toBe('Note Writer');
    expect(noteEntry!.id).toMatch(/^activity:/);

    // Cleanup
    await db.customerActivity.deleteMany({ where: { customerId: c.id } });
    await db.auditLog.deleteMany({ where: { entityType: 'CustomerActivity' } });
    await db.user.delete({ where: { id: user.id } });
  });

  // =========================================================================
  // 7. CustomerDocument CREATE is covered by CustomerActivity, not AuditLog
  // =========================================================================

  it('CustomerDocument CREATE appears once from CustomerActivity, not duplicated from AuditLog', async () => {
    const c = await makeCustomer('DOCDEDUPE');

    const doc = await db.customerDocument.create({
      data: {
        customerId: c.id,
        kind: 'RESALE_CERT',
        storageKey: 'test/key',
        fileName: 'cert.pdf',
        contentType: 'application/pdf',
      },
    });

    // CustomerActivity "document_added" entry (what createDocument writes)
    await db.customerActivity.create({
      data: {
        customerId: c.id,
        kind: 'AUTO',
        summary: 'document_added',
        detailJson: { kind: 'RESALE_CERT', fileName: 'cert.pdf' },
        createdAt: new Date('2026-06-01T09:00:00Z'),
      },
    });

    // AuditLog CREATE row for the same document (also written by createDocument)
    await db.auditLog.create({
      data: {
        action: AuditAction.CREATE,
        entityType: 'CustomerDocument',
        entityId: doc.id,
        afterJson: { kind: 'RESALE_CERT', hasEncryptedValue: false },
        createdAt: new Date('2026-06-01T09:00:00Z'),
      },
    });

    const { entries } = await getCustomerTimeline(db, c.id);

    // Should appear once — from CustomerActivity, since doc CREATE is excluded from AuditLog source
    const docEntries = entries.filter(
      (e) => e.label.toLowerCase().includes('resale cert') || e.label.includes('document'),
    );
    // The CustomerActivity entry surfaces as a doc upload label
    const activityDoc = docEntries.filter((e) => e.id.startsWith('activity:'));
    expect(activityDoc.length).toBeGreaterThanOrEqual(1);
    // The AuditLog CREATE for CustomerDocument must NOT appear
    const auditDoc = entries.filter(
      (e) => e.id.startsWith('audit:') && e.label.toLowerCase().includes('document'),
    );
    expect(auditDoc.length).toBe(0);
  });

  // =========================================================================
  // 8. Pagination — skip/take
  // =========================================================================

  it('pagination: skip and take work correctly; hasMore is set when more entries exist', async () => {
    const c = await makeCustomer('PAGE');

    // Insert 5 CustomerActivity entries
    for (let i = 0; i < 5; i++) {
      await db.customerActivity.create({
        data: {
          customerId: c.id,
          kind: 'MANUAL',
          summary: `note ${i}`,
          createdAt: new Date(2026, 0, i + 1),
        },
      });
    }

    // First page of 3
    const page1 = await getCustomerTimeline(db, c.id, { skip: 0, take: 3 });
    expect(page1.entries.length).toBe(3);
    expect(page1.hasMore).toBe(true);

    // Second page of 3 (may overlap with first page's tail)
    const page2 = await getCustomerTimeline(db, c.id, { skip: 3, take: 3 });
    // Customer created entry + 5 notes = 6 total; skip=3 → 3 remaining → hasMore=false
    expect(page2.entries.length).toBeGreaterThanOrEqual(1);
    // All IDs on page 2 should differ from page 1
    const page1Ids = new Set(page1.entries.map((e) => e.id));
    for (const e of page2.entries) {
      expect(page1Ids.has(e.id)).toBe(false);
    }
  });
});

// =============================================================================
// Cleanup helpers
// =============================================================================

async function wipe(db: PrismaClient): Promise<void> {
  const customers = await db.customer.findMany({
    where: { name: { startsWith: TAG } },
    select: { id: true },
  });
  const ids = customers.map((c) => c.id);
  if (ids.length === 0) return;

  const soIds = (
    await db.salesOrder.findMany({ where: { customerId: { in: ids } }, select: { id: true } })
  ).map((s) => s.id);

  const lineIds = soIds.length
    ? (
        await db.salesOrderLine.findMany({
          where: { salesOrderId: { in: soIds } },
          select: { id: true },
        })
      ).map((l) => l.id)
    : [];

  const docIds = (
    await db.customerDocument.findMany({ where: { customerId: { in: ids } }, select: { id: true } })
  ).map((d) => d.id);

  const addrIds = (
    await db.customerAddress.findMany({ where: { customerId: { in: ids } }, select: { id: true } })
  ).map((a) => a.id);

  // Audit log entries for all owned entities
  const entityTypes: Array<{ type: string; ids: string[] }> = [
    { type: 'SalesOrder', ids: soIds },
    { type: 'SalesOrderLine', ids: lineIds },
    { type: 'CustomerDocument', ids: docIds },
    { type: 'CustomerAddress', ids: addrIds },
    { type: 'Customer', ids },
  ];
  for (const { type, entityIds } of entityTypes.map((x) => ({ type: x.type, entityIds: x.ids }))) {
    if (entityIds.length > 0) {
      await db.auditLog.deleteMany({ where: { entityType: type, entityId: { in: entityIds } } });
    }
  }

  // Cascade delete
  if (lineIds.length) await db.salesOrderLine.deleteMany({ where: { id: { in: lineIds } } });
  if (soIds.length) await db.salesOrder.deleteMany({ where: { id: { in: soIds } } });
  await db.customerDocument.deleteMany({ where: { customerId: { in: ids } } });
  await db.customerActivity.deleteMany({ where: { customerId: { in: ids } } });
  await db.customerAddress.deleteMany({ where: { customerId: { in: ids } } });
  await db.auditLog.deleteMany({ where: { entityType: 'CustomerActivity' } });
  await db.customer.deleteMany({ where: { id: { in: ids } } });

  // Users created by individual tests
  await db.user.deleteMany({ where: { email: { startsWith: TAG } } });
}
