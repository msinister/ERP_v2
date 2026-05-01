import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Customer, PaymentTerm, PrismaClient, SalesRep } from '@/generated/tenant';
import { createCustomer } from '@/server/services/customers';
import {
  createPaymentMethod,
  findPaymentMethodsExpiringWithin,
  listPaymentMethodsForCustomer,
  setPreferred,
  softDeletePaymentMethod,
} from '@/server/services/customerPaymentMethods';
import { createPaymentMethodInputSchema } from '@/lib/validation/customers';
import { hasTenantDb, makeClient } from '../helpers/db';

const suite = hasTenantDb ? describe : describe.skip;

const TAG = 'TEST-CPM';

suite('CustomerPaymentMethod service', () => {
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

  function tokenInput(suffix: string, overrides: Record<string, unknown> = {}) {
    return {
      authorizeNetCustomerProfileId: `cim-cust-${suffix}`,
      authorizeNetPaymentProfileId: `cim-pp-${suffix}-abcd1234`,
      brand: 'VISA',
      last4: '1234',
      expirationMonth: 12,
      expirationYear: 2030,
      ...overrides,
    };
  }

  // ---------- CRUD ----------

  it('create / list / softDelete round-trip', async () => {
    const c = await makeCustomer('CRUD');
    const pm = await createPaymentMethod(db, c.id, tokenInput('crud-1'));
    expect(pm.brand).toBe('VISA');
    expect(pm.last4).toBe('1234');

    const listed = await listPaymentMethodsForCustomer(db, c.id);
    expect(listed).toHaveLength(1);

    const deleted = await softDeletePaymentMethod(db, pm.id);
    expect(deleted.deletedAt).not.toBeNull();
    expect(deleted.isPreferred).toBe(false);

    const after = await listPaymentMethodsForCustomer(db, c.id);
    expect(after).toHaveLength(0);
  });

  it('@@unique on authorizeNetPaymentProfileId enforced (across customers too)', async () => {
    const c1 = await makeCustomer('U1');
    const c2 = await makeCustomer('U2');
    const sharedToken = tokenInput('shared');
    await createPaymentMethod(db, c1.id, sharedToken);
    await expect(createPaymentMethod(db, c2.id, sharedToken)).rejects.toThrow();
  });

  // ---------- setPreferred exclusivity ----------

  it('setPreferred clears the prior preferred — exactly one isPreferred=true at the end', async () => {
    const c = await makeCustomer('P');
    const a = await createPaymentMethod(db, c.id, { ...tokenInput('a'), isPreferred: true });
    const b = await createPaymentMethod(db, c.id, { ...tokenInput('b'), isPreferred: false });
    await setPreferred(db, b.id);

    const fresh = await db.customerPaymentMethod.findMany({
      where: { customerId: c.id, deletedAt: null, isPreferred: true },
    });
    expect(fresh).toHaveLength(1);
    expect(fresh[0].id).toBe(b.id);
    expect((await db.customerPaymentMethod.findUnique({ where: { id: a.id } }))!.isPreferred).toBe(false);
  });

  it('creating a new method with isPreferred=true clears the previous preferred', async () => {
    const c = await makeCustomer('NEW');
    const a = await createPaymentMethod(db, c.id, { ...tokenInput('a'), isPreferred: true });
    const b = await createPaymentMethod(db, c.id, { ...tokenInput('b'), isPreferred: true });
    expect(b.isPreferred).toBe(true);
    const refreshed = await db.customerPaymentMethod.findUnique({ where: { id: a.id } });
    expect(refreshed!.isPreferred).toBe(false);
  });

  it('concurrent setPreferred calls serialize via FOR UPDATE — exactly one preferred remains', async () => {
    const c = await makeCustomer('CONC');
    const a = await createPaymentMethod(db, c.id, { ...tokenInput('a'), isPreferred: true });
    const b = await createPaymentMethod(db, c.id, tokenInput('b'));
    const d = await createPaymentMethod(db, c.id, tokenInput('d'));

    const results = await Promise.allSettled([
      setPreferred(db, b.id),
      setPreferred(db, d.id),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);

    const fresh = await db.customerPaymentMethod.findMany({
      where: { customerId: c.id, deletedAt: null, isPreferred: true },
    });
    expect(fresh).toHaveLength(1);
    void a;
  });

  it('softDelete clears isPreferred — a new preferred can be set immediately', async () => {
    const c = await makeCustomer('SD');
    const a = await createPaymentMethod(db, c.id, { ...tokenInput('a'), isPreferred: true });
    const b = await createPaymentMethod(db, c.id, tokenInput('b'));

    const deleted = await softDeletePaymentMethod(db, a.id);
    expect(deleted.deletedAt).not.toBeNull();
    expect(deleted.isPreferred).toBe(false); // cleared in same tx

    // Setting B as preferred should not violate the partial unique index.
    const after = await setPreferred(db, b.id);
    expect(after.isPreferred).toBe(true);

    const liveCount = await db.customerPaymentMethod.count({
      where: { customerId: c.id, deletedAt: null, isPreferred: true },
    });
    expect(liveCount).toBe(1);
  });

  // ---------- Validation gate ----------

  it('schema rejects PAN-shaped payloads with the documented error message', () => {
    const panAsCimId = '4111111111111111'; // looks like a card number
    const result = createPaymentMethodInputSchema.safeParse({
      authorizeNetCustomerProfileId: panAsCimId,
      authorizeNetPaymentProfileId: 'cim-pp-ok',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message).join(' | ');
      expect(messages).toMatch(/Raw card data detected/);
    }
  });

  it('schema also catches PAN-shaped payloads with spaces or dashes', () => {
    const formatted = '4111-1111-1111-1111';
    const result = createPaymentMethodInputSchema.safeParse({
      authorizeNetCustomerProfileId: 'cim-cust',
      authorizeNetPaymentProfileId: formatted,
    });
    expect(result.success).toBe(false);
  });

  // ---------- Audit redaction ----------

  it('audit JSON redacts authorizeNetPaymentProfileId to last 4 chars', async () => {
    const c = await makeCustomer('AUD');
    const pm = await createPaymentMethod(db, c.id, tokenInput('audit-test'));

    const audits = await db.auditLog.findMany({
      where: { entityType: 'CustomerPaymentMethod', entityId: pm.id },
    });
    expect(audits).toHaveLength(1);
    const after = audits[0].afterJson as { authorizeNetPaymentProfileId?: string };
    expect(after.authorizeNetPaymentProfileId).toMatch(/^…\w{4}$/);
    expect(after.authorizeNetPaymentProfileId).not.toContain('audit-test');
  });

  // ---------- Expiring query ----------

  it('findPaymentMethodsExpiringWithin returns cards expiring inside the window, excludes others', async () => {
    const c = await makeCustomer('EXP');
    // Anchor a deterministic "now" so the window is reproducible across runs.
    const NOW = new Date('2026-04-15T00:00:00Z');

    // Three cards: expired-already, in-window, far-future.
    const expired = await createPaymentMethod(db, c.id, {
      ...tokenInput('expired'),
      expirationMonth: 1,
      expirationYear: 2026,
    });
    const within = await createPaymentMethod(db, c.id, {
      ...tokenInput('within'),
      expirationMonth: 5,
      expirationYear: 2026,
    });
    const future = await createPaymentMethod(db, c.id, {
      ...tokenInput('future'),
      expirationMonth: 12,
      expirationYear: 2030,
    });

    const found = await findPaymentMethodsExpiringWithin(db, 60, NOW);
    const ids = found.map((f) => f.id);
    expect(ids).toContain(within.id);
    expect(ids).not.toContain(expired.id); // already past at NOW
    expect(ids).not.toContain(future.id);

    // Soft-deleted cards are excluded too.
    await softDeletePaymentMethod(db, within.id);
    const found2 = await findPaymentMethodsExpiringWithin(db, 60, NOW);
    expect(found2.map((f) => f.id)).not.toContain(within.id);
  });
});

async function wipe(db: PrismaClient): Promise<void> {
  const customers = await db.customer.findMany({
    where: { name: { startsWith: TAG } },
    select: { id: true },
  });
  const ids = customers.map((c) => c.id);
  if (ids.length === 0) return;
  const ourAddresses = await db.customerAddress.findMany({
    where: { customerId: { in: ids } },
    select: { id: true },
  });
  const addressIds = ourAddresses.map((a) => a.id);
  const ourPaymentMethods = await db.customerPaymentMethod.findMany({
    where: { customerId: { in: ids } },
    select: { id: true },
  });
  const paymentMethodIds = ourPaymentMethods.map((p) => p.id);
  await db.customerPaymentMethod.deleteMany({ where: { customerId: { in: ids } } });
  await db.customerActivity.deleteMany({ where: { customerId: { in: ids } } });
  await db.customerAddress.deleteMany({ where: { customerId: { in: ids } } });
  await db.auditLog.deleteMany({
    where: { entityType: 'Customer', entityId: { in: ids } },
  });
  if (addressIds.length > 0) {
    await db.auditLog.deleteMany({
      where: { entityType: 'CustomerAddress', entityId: { in: addressIds } },
    });
  }
  if (paymentMethodIds.length > 0) {
    await db.auditLog.deleteMany({
      where: { entityType: 'CustomerPaymentMethod', entityId: { in: paymentMethodIds } },
    });
  }
  await db.customer.deleteMany({ where: { id: { in: ids } } });
}
