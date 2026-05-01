import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  Customer,
  PaymentTerm,
  PrismaClient,
  SalesRep,
} from '@/generated/tenant';
import { createCustomer } from '@/server/services/customers';
import {
  assignTag,
  listTagsForCustomer,
  searchTags,
  unassignTag,
} from '@/server/services/customerTags';
import {
  assignCategory,
  createCategory,
  getCategory,
  listCategories,
  listCategoriesForCustomer,
  softDeleteCategory,
  unassignCategory,
  updateCategory,
} from '@/server/services/customerCategories';
import { hasTenantDb, makeClient } from '../helpers/db';

const suite = hasTenantDb ? describe : describe.skip;

const TAG = 'TEST-CTC';

suite('Customer tags + categories', () => {
  let db: PrismaClient;
  let salesRep: SalesRep;
  let term: PaymentTerm;

  beforeAll(async () => {
    db = makeClient();
    salesRep = await db.salesRep.findFirstOrThrow({ where: { code: 'UNASSIGNED' } });
    term = await db.paymentTerm.findFirstOrThrow({ where: { code: 'NET30' } });
  });

  beforeEach(async () => {
    await wipe(db);
  });

  afterAll(async () => {
    await wipe(db);
    await db.$disconnect();
  });

  async function makeCustomer(name: string): Promise<Customer> {
    return createCustomer(db, {
      name: `${TAG} ${name}`,
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

  // ---------- Tags ----------

  it('assignTag lazy-creates the tag + the assignment', async () => {
    const c = await makeCustomer('TAG-A');
    const result = await assignTag(db, c.id, { label: `${TAG}-Glass-Only` });
    expect(result.created).toBe(true);
    expect(result.tag.label).toBe(`${TAG}-Glass-Only`);

    const tags = await listTagsForCustomer(db, c.id);
    expect(tags.map((t) => t.label)).toEqual([`${TAG}-Glass-Only`]);
  });

  it('assignTag for an existing tag reuses the row (no duplicate, no second assignment)', async () => {
    const a = await makeCustomer('TAG-B1');
    const b = await makeCustomer('TAG-B2');
    const r1 = await assignTag(db, a.id, { label: `${TAG}-Reorder` });
    const r2 = await assignTag(db, b.id, { label: `${TAG}-Reorder` });
    expect(r1.tag.id).toBe(r2.tag.id);

    // Re-assigning the same tag to the same customer is idempotent.
    const r3 = await assignTag(db, a.id, { label: `${TAG}-Reorder` });
    expect(r3.created).toBe(false);
    expect(r3.tag.id).toBe(r1.tag.id);

    const aAssignments = await db.customerTagAssignment.findMany({
      where: { customerId: a.id },
    });
    expect(aAssignments).toHaveLength(1);
  });

  it('unassignTag removes the assignment, leaves the tag row', async () => {
    const c = await makeCustomer('TAG-U');
    await assignTag(db, c.id, { label: `${TAG}-Trade-Show` });
    const removed = await unassignTag(db, c.id, `${TAG}-Trade-Show`);
    expect(removed.removed).toBe(true);

    expect(await listTagsForCustomer(db, c.id)).toHaveLength(0);
    const tag = await db.customerTag.findUnique({ where: { label: `${TAG}-Trade-Show` } });
    expect(tag).not.toBeNull();
  });

  it('unassignTag is a no-op when not assigned', async () => {
    const c = await makeCustomer('TAG-N');
    const r = await unassignTag(db, c.id, `${TAG}-Never-Assigned`);
    expect(r.removed).toBe(false);
  });

  it('searchTags case-insensitive substring match', async () => {
    const c = await makeCustomer('TAG-S');
    await assignTag(db, c.id, { label: `${TAG}-Wholesale-Texas` });
    await assignTag(db, c.id, { label: `${TAG}-Kratom-Buyer` });

    const upper = await searchTags(db, `${TAG}-WHOLESALE`);
    const lower = await searchTags(db, `${TAG}-wholesale`);
    expect(upper.map((t) => t.label)).toContain(`${TAG}-Wholesale-Texas`);
    expect(lower.map((t) => t.label)).toContain(`${TAG}-Wholesale-Texas`);
  });

  it('citext: same-label different-case collides into ONE tag row', async () => {
    const a = await makeCustomer('CASE-A');
    const b = await makeCustomer('CASE-B');
    const r1 = await assignTag(db, a.id, { label: `${TAG}-VIP` });
    const r2 = await assignTag(db, b.id, { label: `${TAG}-vip` });
    expect(r1.tag.id).toBe(r2.tag.id);

    const allMatching = await db.customerTag.findMany({
      where: { label: { contains: TAG } },
    });
    const vipOnly = allMatching.filter((t) =>
      t.label.toLowerCase().endsWith('vip'),
    );
    expect(vipOnly).toHaveLength(1);
  });

  // ---------- Categories — dictionary CRUD ----------

  it('Category dictionary CRUD: create, update, soft-delete, list', async () => {
    const cat = await createCategory(db, {
      code: `${TAG}-cat-tradeshow`,
      label: 'Trade Show Lead',
    });
    expect(cat.code).toBe(`${TAG}-CAT-TRADESHOW`); // uppercased
    expect(cat.label).toBe('Trade Show Lead');

    const updated = await updateCategory(db, cat.id, { label: 'Trade Show Lead (2026)' });
    expect(updated.label).toBe('Trade Show Lead (2026)');

    const all = (await listCategories(db)).filter((c) => c.code === cat.code);
    expect(all).toHaveLength(1);

    const deleted = await softDeleteCategory(db, cat.id);
    expect(deleted.deletedAt).not.toBeNull();
    expect(await getCategory(db, cat.id)).toBeNull();
  });

  // ---------- Categories — assignment ----------

  it('assignCategory adds the assignment row; idempotent on second call', async () => {
    const c = await makeCustomer('CAT-A');
    const cat = await createCategory(db, {
      code: `${TAG}-CAT-A`,
      label: 'Cat A',
    });
    const r1 = await assignCategory(db, c.id, cat.id);
    expect(r1.created).toBe(true);
    const r2 = await assignCategory(db, c.id, cat.id);
    expect(r2.created).toBe(false);

    const list = await listCategoriesForCustomer(db, c.id);
    expect(list.map((x) => x.id)).toEqual([cat.id]);
  });

  it('listCategoriesForCustomer excludes assignments to soft-deleted categories', async () => {
    const c = await makeCustomer('CAT-D');
    const live = await createCategory(db, { code: `${TAG}-CAT-LIVE`, label: 'Live' });
    const dead = await createCategory(db, { code: `${TAG}-CAT-DEAD`, label: 'Dead' });
    await assignCategory(db, c.id, live.id);
    await assignCategory(db, c.id, dead.id);

    // Soft-delete the dead category.
    await softDeleteCategory(db, dead.id);

    const visible = await listCategoriesForCustomer(db, c.id);
    expect(visible.map((x) => x.id)).toEqual([live.id]);

    // The historical assignment row IS still there at the DB level.
    const allAssignments = await db.customerCategoryAssignment.findMany({
      where: { customerId: c.id },
    });
    expect(allAssignments.map((a) => a.categoryId).sort()).toEqual(
      [live.id, dead.id].sort(),
    );
  });

  it('assignCategory throws when target category is soft-deleted', async () => {
    const c = await makeCustomer('CAT-X');
    const cat = await createCategory(db, { code: `${TAG}-CAT-X`, label: 'X' });
    await softDeleteCategory(db, cat.id);
    await expect(assignCategory(db, c.id, cat.id)).rejects.toThrow(
      /soft-deleted category/,
    );
  });

  it('unassignCategory removes the row, returns removed=false on a second call', async () => {
    const c = await makeCustomer('CAT-U');
    const cat = await createCategory(db, { code: `${TAG}-CAT-U`, label: 'U' });
    await assignCategory(db, c.id, cat.id);

    const r1 = await unassignCategory(db, c.id, cat.id);
    expect(r1.removed).toBe(true);
    const r2 = await unassignCategory(db, c.id, cat.id);
    expect(r2.removed).toBe(false);
  });
});

async function wipe(db: PrismaClient): Promise<void> {
  const customers = await db.customer.findMany({
    where: { name: { startsWith: TAG } },
    select: { id: true },
  });
  const ids = customers.map((c) => c.id);
  if (ids.length > 0) {
    // Snapshot child IDs BEFORE deleting the assignment/address rows,
    // so we can scope the audit cleanup to test-owned rows only.
    const ourAddresses = await db.customerAddress.findMany({
      where: { customerId: { in: ids } },
      select: { id: true },
    });
    const addressIds = ourAddresses.map((a) => a.id);
    const ourTagAssignments = await db.customerTagAssignment.findMany({
      where: { customerId: { in: ids } },
      select: { customerId: true, tagId: true },
    });
    // Audit entityId for assignments is the composite "customerId:tagId"
    // string (see src/server/services/customerTags.ts).
    const tagAssignmentAuditIds = ourTagAssignments.map(
      (a) => `${a.customerId}:${a.tagId}`,
    );
    const ourCategoryAssignments = await db.customerCategoryAssignment.findMany({
      where: { customerId: { in: ids } },
      select: { customerId: true, categoryId: true },
    });
    const categoryAssignmentAuditIds = ourCategoryAssignments.map(
      (a) => `${a.customerId}:${a.categoryId}`,
    );
    await db.customerActivity.deleteMany({ where: { customerId: { in: ids } } });
    await db.customerAddress.deleteMany({ where: { customerId: { in: ids } } });
    await db.customerTagAssignment.deleteMany({ where: { customerId: { in: ids } } });
    await db.customerCategoryAssignment.deleteMany({ where: { customerId: { in: ids } } });
    await db.auditLog.deleteMany({
      where: { entityType: 'Customer', entityId: { in: ids } },
    });
    if (addressIds.length > 0) {
      await db.auditLog.deleteMany({
        where: { entityType: 'CustomerAddress', entityId: { in: addressIds } },
      });
    }
    if (tagAssignmentAuditIds.length > 0) {
      await db.auditLog.deleteMany({
        where: {
          entityType: 'CustomerTagAssignment',
          entityId: { in: tagAssignmentAuditIds },
        },
      });
    }
    if (categoryAssignmentAuditIds.length > 0) {
      await db.auditLog.deleteMany({
        where: {
          entityType: 'CustomerCategoryAssignment',
          entityId: { in: categoryAssignmentAuditIds },
        },
      });
    }
    await db.customer.deleteMany({ where: { id: { in: ids } } });
  }
  await db.customerTag.deleteMany({ where: { label: { startsWith: TAG } } });
  const ourCategories = await db.customerCategory.findMany({
    where: { code: { startsWith: `${TAG}-CAT` } },
    select: { id: true },
  });
  const categoryIds = ourCategories.map((c) => c.id);
  if (categoryIds.length > 0) {
    await db.auditLog.deleteMany({
      where: { entityType: 'CustomerCategory', entityId: { in: categoryIds } },
    });
  }
  await db.customerCategory.deleteMany({ where: { code: { startsWith: `${TAG}-CAT` } } });
}
