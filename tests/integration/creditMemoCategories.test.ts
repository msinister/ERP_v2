import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CreditMemoStatus,
  Prisma,
} from '@/generated/tenant';
import type { PrismaClient } from '@/generated/tenant';
import {
  createCategory,
  getCategoryByCode,
  getCategoryById,
  listCategories,
  softDeleteCategory,
  updateCategory,
} from '@/server/services/creditMemoCategories';
import { createCreditMemoCategoryInputSchema, updateCreditMemoCategoryInputSchema } from '@/lib/validation/creditMemoCategories';
import { hasTenantDb, makeClient } from '../helpers/db';
import { upsertTestCustomer } from '../helpers/customerStub';

const suite = hasTenantDb ? describe : describe.skip;

const TAG = 'TEST_CMC';

const SEEDED: ReadonlyArray<{ code: string; affectsInventory: boolean }> = [
  { code: 'RETURN', affectsInventory: true },
  { code: 'DAMAGED', affectsInventory: false },
  { code: 'PRICING_DISPUTE', affectsInventory: false },
  { code: 'GOODWILL', affectsInventory: false },
  { code: 'CANCELLED', affectsInventory: false },
  { code: 'BAD_DEBT', affectsInventory: false },
];

suite('CreditMemoCategory service', () => {
  let db: PrismaClient;

  beforeAll(async () => {
    db = makeClient();
  });

  beforeEach(async () => {
    await wipe(db);
  });

  afterAll(async () => {
    await wipe(db);
    await db.$disconnect();
  });

  // ---------- Seeded categories ----------

  it('all 6 seeded categories exist with correct affectsInventory flags (only RETURN: true)', async () => {
    for (const expected of SEEDED) {
      const cat = await getCategoryByCode(db, expected.code);
      expect(cat, `seed code ${expected.code} present`).not.toBeNull();
      expect(cat!.affectsInventory).toBe(expected.affectsInventory);
      expect(cat!.deletedAt).toBeNull();
    }
    // Sanity: only RETURN has affectsInventory=true.
    const all = await listCategories(db);
    const inventoryAffectingSeed = all.filter(
      (c) => c.affectsInventory && SEEDED.some((s) => s.code === c.code),
    );
    expect(inventoryAffectingSeed).toHaveLength(1);
    expect(inventoryAffectingSeed[0].code).toBe('RETURN');
  });

  it('listCategories sorted by code ascending', async () => {
    const all = await listCategories(db);
    for (let i = 1; i < all.length; i++) {
      expect(all[i].code.localeCompare(all[i - 1].code)).toBeGreaterThanOrEqual(0);
    }
  });

  it('listCategories with active-only filter', async () => {
    const code = `${TAG}_INACTIVE_FLT`;
    await createCategory(db, { code, label: 'Filter Test', active: false });
    const all = await listCategories(db);
    const onlyActive = await listCategories(db, { active: true });
    const inAll = all.find((c) => c.code === code);
    const inActive = onlyActive.find((c) => c.code === code);
    expect(inAll).toBeDefined();
    expect(inActive).toBeUndefined();
  });

  it('getCategoryByCode returns null for missing', async () => {
    const cat = await getCategoryByCode(db, `${TAG}_NEVER`);
    expect(cat).toBeNull();
  });

  // ---------- Create / update ----------

  it('createCategory happy path', async () => {
    const created = await createCategory(db, {
      code: `${TAG}_NEW`,
      label: 'New Cat',
      affectsInventory: true,
    });
    expect(created.code).toBe(`${TAG}_NEW`);
    expect(created.label).toBe('New Cat');
    expect(created.affectsInventory).toBe(true);
    expect(created.active).toBe(true);

    // Round-trip via id.
    const fetched = await getCategoryById(db, created.id);
    expect(fetched?.code).toBe(`${TAG}_NEW`);
  });

  it('duplicate code throws', async () => {
    const code = `${TAG}_DUP`;
    await createCategory(db, { code, label: 'A' });
    await expect(createCategory(db, { code, label: 'B' })).rejects.toThrow();
  });

  it('updateCategory: label change works', async () => {
    const created = await createCategory(db, {
      code: `${TAG}_LBL`,
      label: 'Original',
    });
    const updated = await updateCategory(db, created.id, { label: 'Renamed' });
    expect(updated.label).toBe('Renamed');
    expect(updated.code).toBe(`${TAG}_LBL`); // unchanged
  });

  it('updateCategory: affectsInventory toggle works', async () => {
    const created = await createCategory(db, {
      code: `${TAG}_TGL`,
      label: 'Toggle',
      affectsInventory: false,
    });
    const updated = await updateCategory(db, created.id, { affectsInventory: true });
    expect(updated.affectsInventory).toBe(true);
  });

  it('updateCategory: code field is silently stripped by validation (not present in update schema)', async () => {
    // Validation enforces immutability by simply not including `code` in
    // the update shape — extra keys are silently dropped by Zod's
    // default object behavior. The route layer additionally rejects any
    // body containing a `code` key with a 400.
    const result = updateCreditMemoCategoryInputSchema.safeParse({
      label: 'X',
      code: 'NEW_CODE',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect('code' in result.data).toBe(false);
      expect(result.data.label).toBe('X');
    }
  });

  it('createCategoryInputSchema enforces code regex (uppercase + digits + underscore)', async () => {
    const lower = createCreditMemoCategoryInputSchema.safeParse({
      code: 'lowercase',
      label: 'L',
    });
    expect(lower.success).toBe(false);

    const dashed = createCreditMemoCategoryInputSchema.safeParse({
      code: 'UPPER-CASE',
      label: 'L',
    });
    expect(dashed.success).toBe(false);

    const ok = createCreditMemoCategoryInputSchema.safeParse({
      code: 'OK_123',
      label: 'L',
    });
    expect(ok.success).toBe(true);
  });

  // ---------- Soft-delete + reference count ----------

  it('softDeleteCategory when no CreditMemos reference it → succeeds', async () => {
    const created = await createCategory(db, {
      code: `${TAG}_DEL_OK`,
      label: 'Deletable',
    });
    const deleted = await softDeleteCategory(db, created.id);
    expect(deleted.deletedAt).not.toBeNull();
    expect(await getCategoryById(db, created.id)).toBeNull();
  });

  it('softDeleteCategory when active CreditMemo references it → throws with reference count', async () => {
    const cat = await createCategory(db, {
      code: `${TAG}_DEL_BLOCK`,
      label: 'Has refs',
    });
    const customer = await upsertTestCustomer(db, {
      code: `${TAG}-CUST-BLOCK`,
      name: `${TAG} Block Customer`,
    });
    await db.creditMemo.create({
      data: {
        number: `CM-TEST-BLOCK-${Date.now()}`,
        customerId: customer.id,
        categoryId: cat.id,
        amount: new Prisma.Decimal('10'),
        netCredit: new Prisma.Decimal('10'),
        status: CreditMemoStatus.DRAFT,
      },
    });
    await expect(softDeleteCategory(db, cat.id)).rejects.toThrow(
      /1 active credit memo\(s\) reference it/,
    );
  });

  it('softDeleteCategory when only soft-deleted CreditMemos reference it → succeeds', async () => {
    const cat = await createCategory(db, {
      code: `${TAG}_DEL_SOFT`,
      label: 'Has soft-deleted refs',
    });
    const customer = await upsertTestCustomer(db, {
      code: `${TAG}-CUST-SOFT`,
      name: `${TAG} Soft Customer`,
    });
    await db.creditMemo.create({
      data: {
        number: `CM-TEST-SOFT-${Date.now()}`,
        customerId: customer.id,
        categoryId: cat.id,
        amount: new Prisma.Decimal('5'),
        netCredit: new Prisma.Decimal('5'),
        status: CreditMemoStatus.DRAFT,
        deletedAt: new Date(),
      },
    });
    const deleted = await softDeleteCategory(db, cat.id);
    expect(deleted.deletedAt).not.toBeNull();
  });

  it('softDeleteCategory when only voided CreditMemos reference it → succeeds', async () => {
    const cat = await createCategory(db, {
      code: `${TAG}_DEL_VOID`,
      label: 'Has voided refs',
    });
    const customer = await upsertTestCustomer(db, {
      code: `${TAG}-CUST-VOID`,
      name: `${TAG} Void Customer`,
    });
    await db.creditMemo.create({
      data: {
        number: `CM-TEST-VOID-${Date.now()}`,
        customerId: customer.id,
        categoryId: cat.id,
        amount: new Prisma.Decimal('5'),
        netCredit: new Prisma.Decimal('5'),
        status: CreditMemoStatus.VOIDED,
        voidedAt: new Date(),
        voidReason: 'test',
      },
    });
    const deleted = await softDeleteCategory(db, cat.id);
    expect(deleted.deletedAt).not.toBeNull();
  });
});

async function wipe(db: PrismaClient): Promise<void> {
  // Drop test memos and their categories in dependency order.
  const ourMemos = await db.creditMemo.findMany({
    where: { number: { startsWith: 'CM-TEST-' } },
    select: { id: true },
  });
  if (ourMemos.length > 0) {
    const ids = ourMemos.map((m) => m.id);
    await db.creditMemoLine.deleteMany({ where: { creditMemoId: { in: ids } } });
    await db.creditMemo.deleteMany({ where: { id: { in: ids } } });
  }
  const ourCats = await db.creditMemoCategory.findMany({
    where: { code: { startsWith: TAG } },
    select: { id: true },
  });
  if (ourCats.length > 0) {
    const ids = ourCats.map((c) => c.id);
    await db.auditLog.deleteMany({
      where: { entityType: 'CreditMemoCategory', entityId: { in: ids } },
    });
    await db.creditMemoCategory.deleteMany({ where: { id: { in: ids } } });
  }
  // Test customers.
  const ourCustomers = await db.customer.findMany({
    where: { code: { startsWith: `${TAG}-CUST-` } },
    select: { id: true },
  });
  if (ourCustomers.length > 0) {
    const ids = ourCustomers.map((c) => c.id);
    await db.customerActivity.deleteMany({ where: { customerId: { in: ids } } });
    await db.customerAddress.deleteMany({ where: { customerId: { in: ids } } });
    await db.auditLog.deleteMany({
      where: { entityType: 'Customer', entityId: { in: ids } },
    });
    await db.customer.deleteMany({ where: { id: { in: ids } } });
  }
}
