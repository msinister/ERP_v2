import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AuditAction,
  CreditMemoStatus,
  Prisma,
  RmaStatus,
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
  closeSalesOrder,
  confirmSalesOrder,
  createSalesOrder,
} from '@/server/services/salesOrders';
import { receiveInventory } from '@/server/services/movements';
import {
  RMA_TRANSITIONS,
  createRma,
  creditFromRma,
  transitionRma,
} from '@/server/services/rmas';
import { setRestockingFeeDefault } from '@/server/services/restockingFee';
import { hasTenantDb, makeClient } from '../helpers/db';
import { upsertTestWarehouse } from '../helpers/warehouseStub';

const suite = hasTenantDb ? describe : describe.skip;

const TAG = 'TEST-RMALC';

function assertJournalEntryBalanced(
  je: { lines: Array<{ debit: Prisma.Decimal; credit: Prisma.Decimal }> },
): void {
  const dr = je.lines.reduce((acc, l) => acc.plus(l.debit), new Prisma.Decimal(0));
  const cr = je.lines.reduce((acc, l) => acc.plus(l.credit), new Prisma.Decimal(0));
  if (!dr.equals(cr)) {
    throw new Error(`JE not balanced: debits=${dr.toString()} credits=${cr.toString()}`);
  }
}

suite('RMA lifecycle', () => {
  let db: PrismaClient;
  let salesRep: SalesRep;
  let term: PaymentTerm;
  let customer: Customer;
  let warehouseId: string;
  let product: Product;
  let variant: ProductVariant;

  beforeAll(async () => {
    db = makeClient();
    salesRep = await db.salesRep.findFirstOrThrow({ where: { code: 'UNASSIGNED' } });
    term = await db.paymentTerm.findFirstOrThrow({ where: { code: 'NET30' } });
    const wh = await upsertTestWarehouse(db, {
      code: `${TAG}-WH`,
      name: 'RMA WH',
    });
    warehouseId = wh.id;
    product = await db.product.upsert({
      where: { sku: `${TAG}-PROD` },
      create: {
        sku: `${TAG}-PROD`,
        name: 'RMA Product',
        basePrice: new Prisma.Decimal('10.00'),
      },
      update: { active: true, deletedAt: null, basePrice: new Prisma.Decimal('10.00') },
    });
    variant = await db.productVariant.upsert({
      where: { sku: `${TAG}-V` },
      create: { productId: product.id, sku: `${TAG}-V`, name: 'V' },
      update: { productId: product.id, active: true, deletedAt: null },
    });
  });

  beforeEach(async () => {
    await wipe(db);
    // Reset restocking-fee default to all-null between tests.
    await db.setting.update({
      where: { key: 'restocking_fee_default' },
      data: { value: { percent: null, flat: null } },
    });
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
    await receiveInventory(db, { variantId: variant.id, warehouseId, qty: '1000' });
  });

  afterAll(async () => {
    await wipe(db);
    await db.setting.update({
      where: { key: 'restocking_fee_default' },
      data: { value: { percent: null, flat: null } },
    });
    await db.productVariant.deleteMany({ where: { productId: product.id } });
    await db.product.deleteMany({ where: { id: product.id } });
    await db.warehouse.deleteMany({ where: { code: `${TAG}-WH` } });
    await db.$disconnect();
  });

  async function makeInvoice(qty: string) {
    const so = await createSalesOrder(db, {
      customerId: customer.id,
      warehouseId,
      lines: [{ variantId: variant.id, warehouseId, qtyOrdered: qty }],
    });
    await confirmSalesOrder(db, so.id);
    await closeSalesOrder(db, so.id, undefined);
    return db.invoice.findFirstOrThrow({
      where: { salesOrderId: so.id },
      include: { lines: { where: { deletedAt: null } } },
    });
  }

  async function newRma(opts?: {
    returnless?: boolean;
    qty?: string;
    fee?: { percent?: string; flat?: string };
  }) {
    const inv = await makeInvoice('10'); // total 100
    return {
      inv,
      rma: await createRma(db, {
        customerId: customer.id,
        invoiceId: inv.id,
        returnless: opts?.returnless ?? false,
        ...(opts?.fee?.percent ? { restockingFeePercent: opts.fee.percent } : {}),
        ...(opts?.fee?.flat ? { restockingFeeFlat: opts.fee.flat } : {}),
        lines: [{ invoiceLineId: inv.lines[0].id, qty: opts?.qty ?? '5' }],
      }),
    };
  }

  // ---------- State machine: legal transitions ----------

  it('PENDING → APPROVED stamps approvedAt', async () => {
    const { rma } = await newRma();
    const after = await transitionRma(db, { rmaId: rma.id, to: RmaStatus.APPROVED });
    expect(after.status).toBe(RmaStatus.APPROVED);
    expect(after.approvedAt).not.toBeNull();
  });

  it('PENDING → REJECTED stamps rejectedAt + reason', async () => {
    const { rma } = await newRma();
    const after = await transitionRma(db, {
      rmaId: rma.id,
      to: RmaStatus.REJECTED,
      reason: 'cust withdrew',
    });
    expect(after.status).toBe(RmaStatus.REJECTED);
    expect(after.rejectedAt).not.toBeNull();
    expect(after.rejectedReason).toBe('cust withdrew');
  });

  it('APPROVED → IN_TRANSIT, IN_TRANSIT → RECEIVED stamps receivedAt', async () => {
    const { rma } = await newRma();
    await transitionRma(db, { rmaId: rma.id, to: RmaStatus.APPROVED });
    await transitionRma(db, { rmaId: rma.id, to: RmaStatus.IN_TRANSIT });
    const after = await transitionRma(db, { rmaId: rma.id, to: RmaStatus.RECEIVED });
    expect(after.status).toBe(RmaStatus.RECEIVED);
    expect(after.receivedAt).not.toBeNull();
  });

  it('APPROVED → REJECTED', async () => {
    const { rma } = await newRma();
    await transitionRma(db, { rmaId: rma.id, to: RmaStatus.APPROVED });
    const after = await transitionRma(db, {
      rmaId: rma.id,
      to: RmaStatus.REJECTED,
      reason: 'damage assessment',
    });
    expect(after.status).toBe(RmaStatus.REJECTED);
  });

  it('IN_TRANSIT → REJECTED', async () => {
    const { rma } = await newRma();
    await transitionRma(db, { rmaId: rma.id, to: RmaStatus.APPROVED });
    await transitionRma(db, { rmaId: rma.id, to: RmaStatus.IN_TRANSIT });
    const after = await transitionRma(db, {
      rmaId: rma.id,
      to: RmaStatus.REJECTED,
      reason: 'lost in transit',
    });
    expect(after.status).toBe(RmaStatus.REJECTED);
  });

  it('RECEIVED → INSPECTED stamps inspectedAt', async () => {
    const { rma } = await newRma();
    await transitionRma(db, { rmaId: rma.id, to: RmaStatus.APPROVED });
    await transitionRma(db, { rmaId: rma.id, to: RmaStatus.RECEIVED });
    const after = await transitionRma(db, { rmaId: rma.id, to: RmaStatus.INSPECTED });
    expect(after.status).toBe(RmaStatus.INSPECTED);
    expect(after.inspectedAt).not.toBeNull();
  });

  it('RECEIVED → REJECTED', async () => {
    const { rma } = await newRma();
    await transitionRma(db, { rmaId: rma.id, to: RmaStatus.APPROVED });
    await transitionRma(db, { rmaId: rma.id, to: RmaStatus.RECEIVED });
    const after = await transitionRma(db, {
      rmaId: rma.id,
      to: RmaStatus.REJECTED,
      reason: 'failed inspection',
    });
    expect(after.status).toBe(RmaStatus.REJECTED);
  });

  it('INSPECTED → REJECTED', async () => {
    const { rma } = await newRma();
    await transitionRma(db, { rmaId: rma.id, to: RmaStatus.APPROVED });
    await transitionRma(db, { rmaId: rma.id, to: RmaStatus.RECEIVED });
    await transitionRma(db, { rmaId: rma.id, to: RmaStatus.INSPECTED });
    const after = await transitionRma(db, {
      rmaId: rma.id,
      to: RmaStatus.REJECTED,
      reason: 'rejected post-inspection',
    });
    expect(after.status).toBe(RmaStatus.REJECTED);
  });

  // ---------- Returnless ----------

  it('Returnless: APPROVED → IN_TRANSIT throws even though it is in the table', async () => {
    const { rma } = await newRma({ returnless: true });
    await transitionRma(db, { rmaId: rma.id, to: RmaStatus.APPROVED });
    await expect(
      transitionRma(db, { rmaId: rma.id, to: RmaStatus.IN_TRANSIT }),
    ).rejects.toThrow(/Returnless RMA cannot transition to IN_TRANSIT/);
  });

  it('Returnless: APPROVED → RECEIVED succeeds (skip path)', async () => {
    const { rma } = await newRma({ returnless: true });
    await transitionRma(db, { rmaId: rma.id, to: RmaStatus.APPROVED });
    const after = await transitionRma(db, { rmaId: rma.id, to: RmaStatus.RECEIVED });
    expect(after.status).toBe(RmaStatus.RECEIVED);
    expect(after.receivedAt).not.toBeNull();
  });

  // ---------- Illegal transitions ----------

  it.each([
    [RmaStatus.PENDING, RmaStatus.IN_TRANSIT],
    [RmaStatus.PENDING, RmaStatus.RECEIVED],
    [RmaStatus.PENDING, RmaStatus.INSPECTED],
    [RmaStatus.APPROVED, RmaStatus.PENDING],
    [RmaStatus.APPROVED, RmaStatus.INSPECTED],
    [RmaStatus.RECEIVED, RmaStatus.IN_TRANSIT],
    [RmaStatus.RECEIVED, RmaStatus.PENDING],
    [RmaStatus.INSPECTED, RmaStatus.IN_TRANSIT],
  ])('illegal transition %s → %s throws', async (from, to) => {
    const { rma } = await newRma();
    // Walk the RMA to `from` via the legal path.
    if (from !== RmaStatus.PENDING) {
      await transitionRma(db, { rmaId: rma.id, to: RmaStatus.APPROVED });
    }
    if (from === RmaStatus.RECEIVED || from === RmaStatus.INSPECTED) {
      await transitionRma(db, { rmaId: rma.id, to: RmaStatus.RECEIVED });
    }
    if (from === RmaStatus.INSPECTED) {
      await transitionRma(db, { rmaId: rma.id, to: RmaStatus.INSPECTED });
    }
    await expect(
      transitionRma(db, { rmaId: rma.id, to, reason: 'forced' }),
    ).rejects.toThrow(/Illegal RMA transition/);
  });

  it('CREDITED is terminal — cannot transition out', async () => {
    const { inv, rma } = await newRma();
    await transitionRma(db, { rmaId: rma.id, to: RmaStatus.APPROVED });
    await transitionRma(db, { rmaId: rma.id, to: RmaStatus.RECEIVED });
    await transitionRma(db, { rmaId: rma.id, to: RmaStatus.INSPECTED });
    await creditFromRma(db, rma.id, {
      lines: [
        {
          invoiceLineId: inv.lines[0].id,
          qty: '5',
          unitPrice: '10',
          description: 'returned',
        },
      ],
    });
    await expect(
      transitionRma(db, { rmaId: rma.id, to: RmaStatus.REJECTED, reason: 'never' }),
    ).rejects.toThrow(/Illegal RMA transition/);
  });

  it('REJECTED is terminal — cannot transition out', async () => {
    const { rma } = await newRma();
    await transitionRma(db, {
      rmaId: rma.id,
      to: RmaStatus.REJECTED,
      reason: 'no go',
    });
    await expect(
      transitionRma(db, { rmaId: rma.id, to: RmaStatus.APPROVED }),
    ).rejects.toThrow(/Illegal RMA transition/);
  });

  it('Direct transition to CREDITED throws — must use creditFromRma', async () => {
    const { rma } = await newRma();
    await transitionRma(db, { rmaId: rma.id, to: RmaStatus.APPROVED });
    await transitionRma(db, { rmaId: rma.id, to: RmaStatus.RECEIVED });
    await transitionRma(db, { rmaId: rma.id, to: RmaStatus.INSPECTED });
    await expect(
      transitionRma(db, { rmaId: rma.id, to: RmaStatus.CREDITED }),
    ).rejects.toThrow(/Use creditFromRma/);
  });

  // ---------- Restocking fee resolution ----------

  it('No override + null default → CM has restockingFee=0', async () => {
    const { inv, rma } = await newRma();
    await transitionRma(db, { rmaId: rma.id, to: RmaStatus.APPROVED });
    await transitionRma(db, { rmaId: rma.id, to: RmaStatus.RECEIVED });
    await transitionRma(db, { rmaId: rma.id, to: RmaStatus.INSPECTED });
    const result = await creditFromRma(db, rma.id, {
      lines: [
        { invoiceLineId: inv.lines[0].id, qty: '5', unitPrice: '10', description: 'r' },
      ],
    });
    expect(result.creditMemo.restockingFee.toString()).toBe(
      new Prisma.Decimal('0').toString(),
    );
    expect(result.creditMemo.amount.toString()).toBe(new Prisma.Decimal('50').toString());
    expect(result.creditMemo.netCredit.toString()).toBe(new Prisma.Decimal('50').toString());
  });

  it('No override + default percent=10 → fee computed at 10% of gross', async () => {
    await setRestockingFeeDefault(db, { percent: '10' });
    const { inv, rma } = await newRma();
    await transitionRma(db, { rmaId: rma.id, to: RmaStatus.APPROVED });
    await transitionRma(db, { rmaId: rma.id, to: RmaStatus.RECEIVED });
    await transitionRma(db, { rmaId: rma.id, to: RmaStatus.INSPECTED });
    const result = await creditFromRma(db, rma.id, {
      lines: [
        { invoiceLineId: inv.lines[0].id, qty: '5', unitPrice: '10', description: 'r' },
      ],
    });
    // Per docs/06-invoicing-ar.md: amount = gross sales-returns
    // recognition (= lineGrossSum = 50), fee = 5, netCredit = amount - fee = 45.
    // Line invariant SUM(qty*unitPrice) === amount = 50 (fee NOT in line sum).
    expect(result.creditMemo.restockingFee.toString()).toBe(
      new Prisma.Decimal('5').toString(),
    );
    expect(result.creditMemo.amount.toString()).toBe(new Prisma.Decimal('50').toString());
    expect(result.creditMemo.netCredit.toString()).toBe(new Prisma.Decimal('45').toString());
  });

  it('Flat override + default percent → flat wins', async () => {
    await setRestockingFeeDefault(db, { percent: '10' });
    const { inv, rma } = await newRma({ fee: { flat: '5' } });
    await transitionRma(db, { rmaId: rma.id, to: RmaStatus.APPROVED });
    await transitionRma(db, { rmaId: rma.id, to: RmaStatus.RECEIVED });
    await transitionRma(db, { rmaId: rma.id, to: RmaStatus.INSPECTED });
    const result = await creditFromRma(db, rma.id, {
      lines: [
        { invoiceLineId: inv.lines[0].id, qty: '5', unitPrice: '10', description: 'r' },
      ],
    });
    expect(result.creditMemo.restockingFee.toString()).toBe(
      new Prisma.Decimal('5').toString(),
    );
  });

  // ---------- Atomic credit-from-RMA happy path ----------

  it('creditFromRma: atomic draft+confirm+link, RMA = CREDITED, qtyReturned bumps, JE balanced', async () => {
    const { inv, rma } = await newRma({ qty: '5' });
    await transitionRma(db, { rmaId: rma.id, to: RmaStatus.APPROVED });
    await transitionRma(db, { rmaId: rma.id, to: RmaStatus.RECEIVED });
    await transitionRma(db, { rmaId: rma.id, to: RmaStatus.INSPECTED });

    const result = await creditFromRma(db, rma.id, {
      lines: [
        { invoiceLineId: inv.lines[0].id, qty: '5', unitPrice: '10', description: 'returned' },
      ],
    });

    expect(result.rma.status).toBe(RmaStatus.CREDITED);
    expect(result.rma.creditedAt).not.toBeNull();
    expect(result.rma.creditMemoId).toBe(result.creditMemo.id);

    expect(result.creditMemo.status).toBe(CreditMemoStatus.CONFIRMED);
    expect(result.creditMemo.issuedAt).not.toBeNull();

    // The CM JE that creditFromRma indirectly produced is balanced.
    const cmJe = await db.journalEntry.findFirstOrThrow({
      where: { entityType: 'CreditMemo', entityId: result.creditMemo.id },
      include: { lines: true },
    });
    assertJournalEntryBalanced(cmJe);

    // qtyReturned bumped on the affected invoice line.
    const il = await db.invoiceLine.findUniqueOrThrow({
      where: { id: inv.lines[0].id },
    });
    expect(il.qtyReturned.toString()).toBe(new Prisma.Decimal('5').toString());
  });

  // ---------- Atomic credit-from-RMA failure paths ----------

  it('creditFromRma rejects when input customer mismatch (line invoiceLineId not in RMA)', async () => {
    const { rma } = await newRma();
    await transitionRma(db, { rmaId: rma.id, to: RmaStatus.APPROVED });
    await transitionRma(db, { rmaId: rma.id, to: RmaStatus.RECEIVED });
    await transitionRma(db, { rmaId: rma.id, to: RmaStatus.INSPECTED });
    await expect(
      creditFromRma(db, rma.id, {
        lines: [
          { invoiceLineId: 'not-on-this-rma', qty: '1', unitPrice: '10', description: 'x' },
        ],
      }),
    ).rejects.toThrow(/does not match any RMA line/);
    const after = await db.rma.findUniqueOrThrow({ where: { id: rma.id } });
    expect(after.status).toBe(RmaStatus.INSPECTED);
  });

  it('creditFromRma rejects when input qty exceeds RMA line qty', async () => {
    const { inv, rma } = await newRma({ qty: '5' });
    await transitionRma(db, { rmaId: rma.id, to: RmaStatus.APPROVED });
    await transitionRma(db, { rmaId: rma.id, to: RmaStatus.RECEIVED });
    await transitionRma(db, { rmaId: rma.id, to: RmaStatus.INSPECTED });
    await expect(
      creditFromRma(db, rma.id, {
        lines: [
          { invoiceLineId: inv.lines[0].id, qty: '6', unitPrice: '10', description: 'over' },
        ],
      }),
    ).rejects.toThrow(/exceeds RMA line qty/);
    const after = await db.rma.findUniqueOrThrow({ where: { id: rma.id } });
    expect(after.status).toBe(RmaStatus.INSPECTED);
    // qtyReturned was NOT bumped (atomic rollback).
    const il = await db.invoiceLine.findUniqueOrThrow({ where: { id: inv.lines[0].id } });
    expect(il.qtyReturned.toString()).toBe(new Prisma.Decimal('0').toString());
  });

  it('creditFromRma on a non-INSPECTED RMA throws', async () => {
    const { inv, rma } = await newRma();
    await expect(
      creditFromRma(db, rma.id, {
        lines: [
          { invoiceLineId: inv.lines[0].id, qty: '5', unitPrice: '10', description: 'x' },
        ],
      }),
    ).rejects.toThrow(/requires RMA in INSPECTED status/);
  });

  // ---------- Partial RMA (per CRITICAL #2) ----------

  it('Partial RMA: invoice line qty=10, RMA1 returns 3, RMA2 can return up to 7 more', async () => {
    const inv = await makeInvoice('10'); // total 100, line qty 10
    const il = inv.lines[0];

    // RMA #1 returns 3.
    const rma1 = await createRma(db, {
      customerId: customer.id,
      invoiceId: inv.id,
      lines: [{ invoiceLineId: il.id, qty: '3' }],
    });
    await transitionRma(db, { rmaId: rma1.id, to: RmaStatus.APPROVED });
    await transitionRma(db, { rmaId: rma1.id, to: RmaStatus.RECEIVED });
    await transitionRma(db, { rmaId: rma1.id, to: RmaStatus.INSPECTED });
    await creditFromRma(db, rma1.id, {
      lines: [{ invoiceLineId: il.id, qty: '3', unitPrice: '10', description: 'p1' }],
    });

    const ilAfter1 = await db.invoiceLine.findUniqueOrThrow({ where: { id: il.id } });
    expect(ilAfter1.qtyReturned.toString()).toBe(new Prisma.Decimal('3').toString());

    // RMA #2 for 7 more — succeeds.
    const rma2 = await createRma(db, {
      customerId: customer.id,
      invoiceId: inv.id,
      lines: [{ invoiceLineId: il.id, qty: '7' }],
    });
    expect(rma2.status).toBe(RmaStatus.PENDING);

    // RMA #3 for 8 — exceeds remaining (7) → throws.
    await expect(
      createRma(db, {
        customerId: customer.id,
        invoiceId: inv.id,
        lines: [{ invoiceLineId: il.id, qty: '8' }],
      }),
    ).rejects.toThrow(/exceeds remaining unreturned qty/);
  });

  // ---------- Concurrency ----------

  it('Two parallel transitionRma on same RMA → exactly one succeeds (FOR UPDATE)', async () => {
    const { rma } = await newRma();
    // Both attempt PENDING → REJECTED. After FOR UPDATE serializes them,
    // the first commits REJECTED; the second sees REJECTED (terminal) and
    // throws on REJECTED → REJECTED. Deterministic regardless of order.
    const results = await Promise.allSettled([
      transitionRma(db, { rmaId: rma.id, to: RmaStatus.REJECTED, reason: 'racer-a' }),
      transitionRma(db, { rmaId: rma.id, to: RmaStatus.REJECTED, reason: 'racer-b' }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);
  });

  it('Two parallel creditFromRma on same RMA → exactly one creates the CM', async () => {
    const { inv, rma } = await newRma({ qty: '5' });
    await transitionRma(db, { rmaId: rma.id, to: RmaStatus.APPROVED });
    await transitionRma(db, { rmaId: rma.id, to: RmaStatus.RECEIVED });
    await transitionRma(db, { rmaId: rma.id, to: RmaStatus.INSPECTED });
    const results = await Promise.allSettled([
      creditFromRma(db, rma.id, {
        lines: [
          { invoiceLineId: inv.lines[0].id, qty: '5', unitPrice: '10', description: 'a' },
        ],
      }),
      creditFromRma(db, rma.id, {
        lines: [
          { invoiceLineId: inv.lines[0].id, qty: '5', unitPrice: '10', description: 'b' },
        ],
      }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);
    const cms = await db.creditMemo.findMany({
      where: { customerId: customer.id, status: CreditMemoStatus.CONFIRMED },
    });
    expect(cms).toHaveLength(1);
  });

  // ---------- Audit ----------

  it('Each status change writes an RMA_STATUS_CHANGE audit row', async () => {
    const { rma } = await newRma();
    await transitionRma(db, { rmaId: rma.id, to: RmaStatus.APPROVED });
    await transitionRma(db, { rmaId: rma.id, to: RmaStatus.RECEIVED });
    const audits = await db.auditLog.findMany({
      where: {
        entityType: 'Rma',
        entityId: rma.id,
        action: AuditAction.RMA_STATUS_CHANGE,
      },
    });
    expect(audits).toHaveLength(2);
  });

  // ---------- Transition table sanity ----------

  it('RMA_TRANSITIONS table has expected shape', () => {
    expect(RMA_TRANSITIONS[RmaStatus.PENDING].sort()).toEqual([
      RmaStatus.APPROVED,
      RmaStatus.REJECTED,
    ].sort());
    expect(RMA_TRANSITIONS[RmaStatus.CREDITED]).toEqual([]);
    expect(RMA_TRANSITIONS[RmaStatus.REJECTED]).toEqual([]);
  });
});

async function wipe(db: PrismaClient): Promise<void> {
  const customers = await db.customer.findMany({
    where: { name: { startsWith: TAG } },
    select: { id: true },
  });
  const ids = customers.map((c) => c.id);
  if (ids.length === 0) return;

  // Drop RMAs first (they FK to invoices).
  const ourRmas = await db.rma.findMany({
    where: { customerId: { in: ids } },
    select: { id: true },
  });
  if (ourRmas.length > 0) {
    const rmaIds = ourRmas.map((r) => r.id);
    await db.rmaLine.deleteMany({ where: { rmaId: { in: rmaIds } } });
    await db.auditLog.deleteMany({
      where: { entityType: 'Rma', entityId: { in: rmaIds } },
    });
    await db.rma.deleteMany({ where: { id: { in: rmaIds } } });
  }

  // Drop CMs (RMAs may have linked them).
  const ourCms = await db.creditMemo.findMany({
    where: { customerId: { in: ids } },
    select: { id: true },
  });
  if (ourCms.length > 0) {
    const cmIds = ourCms.map((c) => c.id);
    const cmJes = await db.journalEntry.findMany({
      where: { entityType: 'CreditMemo', entityId: { in: cmIds } },
      select: { id: true },
    });
    if (cmJes.length > 0) {
      const jeIds = cmJes.map((j) => j.id);
      await db.journalEntryLine.deleteMany({ where: { journalEntryId: { in: jeIds } } });
      await db.journalEntry.deleteMany({ where: { id: { in: jeIds } } });
    }
    await db.creditApplication.deleteMany({ where: { creditMemoId: { in: cmIds } } });
    await db.creditMemoLine.deleteMany({ where: { creditMemoId: { in: cmIds } } });
    await db.auditLog.deleteMany({
      where: { entityType: 'CreditMemo', entityId: { in: cmIds } },
    });
    await db.creditMemo.deleteMany({ where: { id: { in: cmIds } } });
  }

  // Invoices.
  const invoices = await db.invoice.findMany({
    where: { customerId: { in: ids } },
    select: { id: true },
  });
  if (invoices.length > 0) {
    const invIds = invoices.map((i) => i.id);
    const jes = await db.journalEntry.findMany({
      where: { entityType: 'Invoice', entityId: { in: invIds } },
      select: { id: true },
    });
    if (jes.length > 0) {
      const jeIds = jes.map((j) => j.id);
      await db.journalEntryLine.deleteMany({ where: { journalEntryId: { in: jeIds } } });
      await db.journalEntry.deleteMany({ where: { id: { in: jeIds } } });
    }
    await db.creditApplication.deleteMany({ where: { invoiceId: { in: invIds } } });
    await db.auditLog.deleteMany({
      where: { entityType: 'Invoice', entityId: { in: invIds } },
    });
    await db.invoiceLine.deleteMany({ where: { invoiceId: { in: invIds } } });
    await db.invoice.deleteMany({ where: { id: { in: invIds } } });
  }

  // SOs + customer scaffolding.
  const ourSos = await db.salesOrder.findMany({
    where: { customerId: { in: ids } },
    select: { id: true },
  });
  const soIds = ourSos.map((s) => s.id);
  if (soIds.length > 0) {
    await db.auditLog.deleteMany({
      where: { entityType: 'SalesOrder', entityId: { in: soIds } },
    });
  }
  await db.salesOrderLine.deleteMany({ where: { salesOrder: { customerId: { in: ids } } } });
  await db.salesOrder.deleteMany({ where: { customerId: { in: ids } } });

  const variantIds = (
    await db.productVariant.findMany({
      where: { sku: { startsWith: TAG } },
      select: { id: true },
    })
  ).map((v) => v.id);
  if (variantIds.length > 0) {
    const ourMovements = await db.inventoryMovement.findMany({
      where: { variantId: { in: variantIds } },
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
    await db.inventoryMovement.deleteMany({ where: { variantId: { in: variantIds } } });
    await db.inventoryItem.deleteMany({ where: { variantId: { in: variantIds } } });
  }
  const ourAddresses = await db.customerAddress.findMany({
    where: { customerId: { in: ids } },
    select: { id: true },
  });
  const addressIds = ourAddresses.map((a) => a.id);
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
  await db.customer.deleteMany({ where: { id: { in: ids } } });
}
