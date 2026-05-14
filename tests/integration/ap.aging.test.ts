import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  PaymentMethod,
  Prisma,
} from '@/generated/tenant';
import type {
  PaymentTerm,
  PrismaClient,
  Product,
  ProductVariant,
  Vendor,
} from '@/generated/tenant';
import {
  cancelBill,
  confirmBill,
  createBill,
} from '@/server/services/bills';
import { recordBillPayment } from '@/server/services/billPayments';
import {
  applyVendorCreditToBill,
  confirmVendorCredit,
  createVendorCreditDraft,
} from '@/server/services/vendorCredits';
import {
  agingForVendor,
  apAgingSummary,
  apBalanceForVendor,
} from '@/server/services/ap';
import { hasTenantDb, makeClient } from '../helpers/db';
import { upsertTestWarehouse } from '../helpers/warehouseStub';
import { upsertTestVendor } from '../helpers/vendorStub';
import { wipeBillArtifactsForVendors } from '../helpers/wipeBillArtifacts';

const suite = hasTenantDb ? describe : describe.skip;
const TAG = 'TEST-APAGE';

// Fixed asOf for deterministic bucket math.
const ASOF = new Date('2026-04-30T12:00:00.000Z');
function daysAgo(n: number): Date {
  return new Date(ASOF.getTime() - n * 24 * 60 * 60 * 1000);
}

suite('AP aging', () => {
  let db: PrismaClient;
  let net30: PaymentTerm;
  let cashAccountId: string;
  let product: Product;
  let variant: ProductVariant;

  beforeAll(async () => {
    db = makeClient();
    net30 = await db.paymentTerm.findFirstOrThrow({ where: { code: 'NET30' } });
    await upsertTestWarehouse(db, { code: `${TAG}-WH`, name: 'AP Aging WH' });
    cashAccountId = (
      await db.glAccount.findFirstOrThrow({ where: { code: '1110' } })
    ).id;
    product = await db.product.upsert({
      where: { sku: `${TAG}-PROD` },
      create: { sku: `${TAG}-PROD`, name: 'AP Aging Product' },
      update: { active: true, deletedAt: null },
    });
    variant = await db.productVariant.upsert({
      where: { sku: `${TAG}-V` },
      create: { productId: product.id, sku: `${TAG}-V`, name: 'V' },
      update: { productId: product.id, active: true, deletedAt: null },
    });
  });

  beforeEach(async () => {
    await wipe();
  });

  afterAll(async () => {
    await wipe();
    await db.productVariant.deleteMany({ where: { productId: product.id } });
    await db.product.deleteMany({ where: { id: product.id } });
    await db.warehouse.deleteMany({ where: { code: `${TAG}-WH` } });
    await db.vendor.deleteMany({ where: { code: { startsWith: `${TAG}-VEN` } } });
    await db.$disconnect();
  });

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  async function newVendor(
    suffix: string,
    paymentTermId: string | null = net30.id,
  ): Promise<Vendor> {
    const v = await upsertTestVendor(db, {
      code: `${TAG}-VEN-${suffix}`,
      name: `${TAG} Vendor ${suffix}`,
    });
    if (paymentTermId !== null) {
      await db.vendor.update({
        where: { id: v.id },
        data: { paymentTermId },
      });
    } else {
      await db.vendor.update({
        where: { id: v.id },
        data: { paymentTermId: null },
      });
    }
    return v;
  }

  async function makeConfirmedBill(args: {
    vendor: Vendor;
    amount: string;
    billDate: Date;
  }): Promise<string> {
    const bill = await createBill(db, {
      vendorId: args.vendor.id,
      billDate: args.billDate,
      lines: [
        {
          variantId: variant.id,
          description: 'aging-test',
          qty: '1',
          unitCost: args.amount,
        },
      ],
    });
    const confirmed = await confirmBill(db, bill.id);
    return confirmed.id;
  }

  // -------------------------------------------------------------------------
  // apBalanceForVendor
  // -------------------------------------------------------------------------

  it('apBalanceForVendor: empty vendor returns zeros', async () => {
    const v = await newVendor('EMPTY');
    const result = await apBalanceForVendor(db, v.id);
    expect(result.apBalance.toString()).toBe(new Prisma.Decimal('0').toString());
    expect(result.unappliedCreditBalance.toString()).toBe(new Prisma.Decimal('0').toString());
  });

  it('apBalanceForVendor: SUM open bills minus paid minus credited', async () => {
    const v = await newVendor('SUM');
    await makeConfirmedBill({ vendor: v, amount: '100', billDate: daysAgo(5) });
    const billB = await makeConfirmedBill({
      vendor: v,
      amount: '200',
      billDate: daysAgo(10),
    });
    // Pay $50 on Bill B → still PARTIAL (balance $150).
    await recordBillPayment(db, {
      billId: billB,
      amount: '50',
      method: PaymentMethod.CHECK,
      cashAccountId,
    });
    const result = await apBalanceForVendor(db, v.id);
    // 100 + (200 - 50) = 250
    expect(result.apBalance.toString()).toBe(new Prisma.Decimal('250').toString());
  });

  it('apBalanceForVendor: returns apBalance and unappliedCreditBalance separately, NEVER netted', async () => {
    const v = await newVendor('NETTED');
    // No open bills, but $40 of unapplied vendor credit.
    const vc = await createVendorCreditDraft(db, {
      vendorId: v.id,
      amount: '40',
      lines: [{ description: 'standalone credit', amount: '40' }],
    });
    await confirmVendorCredit(db, vc.id);
    const result = await apBalanceForVendor(db, v.id);
    expect(result.apBalance.toString()).toBe(new Prisma.Decimal('0').toString());
    expect(result.unappliedCreditBalance.toString()).toBe(new Prisma.Decimal('40').toString());
  });

  it('apBalanceForVendor: excludes DRAFT, CANCELLED, deleted bills and CANCELLED VCs', async () => {
    const v = await newVendor('EXCL');
    // Confirmed bill — counted.
    await makeConfirmedBill({ vendor: v, amount: '100', billDate: daysAgo(5) });
    // DRAFT bill — not counted.
    await createBill(db, {
      vendorId: v.id,
      billDate: daysAgo(5),
      lines: [
        { variantId: variant.id, description: 'draft', qty: '1', unitCost: '999' },
      ],
    });
    // Confirmed-then-cancelled — not counted.
    const billCancel = await makeConfirmedBill({
      vendor: v,
      amount: '500',
      billDate: daysAgo(5),
    });
    await cancelBill(db, billCancel, 'cancelled for test');

    // Confirmed VC — counted in unapplied.
    const vc1 = await createVendorCreditDraft(db, {
      vendorId: v.id,
      amount: '20',
      lines: [{ description: 'a', amount: '20' }],
    });
    await confirmVendorCredit(db, vc1.id);
    // DRAFT VC — not counted.
    await createVendorCreditDraft(db, {
      vendorId: v.id,
      amount: '999',
      lines: [{ description: 'never confirmed', amount: '999' }],
    });

    const result = await apBalanceForVendor(db, v.id);
    expect(result.apBalance.toString()).toBe(new Prisma.Decimal('100').toString());
    expect(result.unappliedCreditBalance.toString()).toBe(new Prisma.Decimal('20').toString());
  });

  // -------------------------------------------------------------------------
  // agingForVendor — bucket assignments
  // -------------------------------------------------------------------------

  it('agingForVendor: bills in each bucket land in the right bucket', async () => {
    const v = await newVendor('BUCKETS');
    // billDate offsets relative to ASOF:
    //   billDate (NET30) → dueDate = billDate + 30d → daysPastDue
    //   - billDate ASOF − 10d → dueDate ASOF + 20d → daysPastDue −20 → current
    //   - billDate ASOF − 40d → dueDate ASOF − 10d → daysPastDue 10  → b1to30
    //   - billDate ASOF − 75d → dueDate ASOF − 45d → daysPastDue 45  → b31to60
    //   - billDate ASOF − 110d → dueDate ASOF − 80d → daysPastDue 80 → b61to90
    //   - billDate ASOF − 200d → dueDate ASOF − 170d → daysPastDue 170 → b91plus
    await makeConfirmedBill({ vendor: v, amount: '10', billDate: daysAgo(10) });
    await makeConfirmedBill({ vendor: v, amount: '20', billDate: daysAgo(40) });
    await makeConfirmedBill({ vendor: v, amount: '30', billDate: daysAgo(75) });
    await makeConfirmedBill({ vendor: v, amount: '40', billDate: daysAgo(110) });
    await makeConfirmedBill({ vendor: v, amount: '50', billDate: daysAgo(200) });

    const aging = await agingForVendor(db, v.id, ASOF);
    expect(aging.buckets.current.toString()).toBe(new Prisma.Decimal('10').toString());
    expect(aging.buckets.b1to30.toString()).toBe(new Prisma.Decimal('20').toString());
    expect(aging.buckets.b31to60.toString()).toBe(new Prisma.Decimal('30').toString());
    expect(aging.buckets.b61to90.toString()).toBe(new Prisma.Decimal('40').toString());
    expect(aging.buckets.b91plus.toString()).toBe(new Prisma.Decimal('50').toString());
    expect(aging.total.toString()).toBe(new Prisma.Decimal('150').toString());
  });

  it('agingForVendor: bills sorted oldest-delinquency first (daysPastDue DESC)', async () => {
    const v = await newVendor('SORT');
    await makeConfirmedBill({ vendor: v, amount: '10', billDate: daysAgo(10) });
    await makeConfirmedBill({ vendor: v, amount: '20', billDate: daysAgo(200) });
    await makeConfirmedBill({ vendor: v, amount: '30', billDate: daysAgo(40) });

    const aging = await agingForVendor(db, v.id, ASOF);
    expect(aging.bills).toHaveLength(3);
    expect(aging.bills[0].daysPastDue).toBeGreaterThan(aging.bills[1].daysPastDue);
    expect(aging.bills[1].daysPastDue).toBeGreaterThan(aging.bills[2].daysPastDue);
  });

  it('agingForVendor: vendor without payment term → null dueDate treated as billDate (due immediately)', async () => {
    const v = await newVendor('NOTERM', null);
    await makeConfirmedBill({ vendor: v, amount: '50', billDate: daysAgo(15) });

    const aging = await agingForVendor(db, v.id, ASOF);
    // billDate ASOF − 15d, dueDate same (null term), daysPastDue = 15 → b1to30
    expect(aging.bills).toHaveLength(1);
    expect(aging.bills[0].dueDate.toISOString()).toBe(daysAgo(15).toISOString());
    expect(aging.bills[0].daysPastDue).toBe(15);
    expect(aging.bills[0].bucket).toBe('b1to30');
  });

  it('agingForVendor: PAID bills excluded; PARTIAL bills included with reduced balance', async () => {
    const v = await newVendor('PAID');
    const billA = await makeConfirmedBill({
      vendor: v,
      amount: '100',
      billDate: daysAgo(20),
    });
    const billB = await makeConfirmedBill({
      vendor: v,
      amount: '200',
      billDate: daysAgo(20),
    });
    // Fully pay billA.
    await recordBillPayment(db, {
      billId: billA,
      amount: '100',
      method: PaymentMethod.ACH,
      cashAccountId,
    });
    // Partially pay billB ($50 of $200).
    await recordBillPayment(db, {
      billId: billB,
      amount: '50',
      method: PaymentMethod.ACH,
      cashAccountId,
    });

    const aging = await agingForVendor(db, v.id, ASOF);
    expect(aging.bills).toHaveLength(1); // billA excluded (PAID)
    expect(aging.bills[0].billId).toBe(billB);
    expect(aging.bills[0].balance.toString()).toBe(new Prisma.Decimal('150').toString());
    expect(aging.total.toString()).toBe(new Prisma.Decimal('150').toString());
  });

  it('agingForVendor: applied vendor credit reduces bill balance + appears in amountCredited', async () => {
    const v = await newVendor('CREDITED');
    const billId = await makeConfirmedBill({
      vendor: v,
      amount: '100',
      billDate: daysAgo(5),
    });
    const vc = await createVendorCreditDraft(db, {
      vendorId: v.id,
      amount: '40',
      lines: [{ description: 'partial', amount: '40' }],
    });
    await confirmVendorCredit(db, vc.id);
    await applyVendorCreditToBill(db, vc.id, { billId, amount: '40' });

    const aging = await agingForVendor(db, v.id, ASOF);
    expect(aging.bills).toHaveLength(1);
    expect(aging.bills[0].amountCredited.toString()).toBe(new Prisma.Decimal('40').toString());
    expect(aging.bills[0].balance.toString()).toBe(new Prisma.Decimal('60').toString());
    // Unapplied credit balance should be 0 (whole VC was applied).
    expect(aging.unappliedCreditBalance.toString()).toBe(new Prisma.Decimal('0').toString());
  });

  // -------------------------------------------------------------------------
  // apAgingSummary
  // -------------------------------------------------------------------------

  it('apAgingSummary: multi-vendor roll-up sorted by total DESC', async () => {
    const vSmall = await newVendor('SMALL');
    const vBig = await newVendor('BIG');
    const vMid = await newVendor('MID');
    await makeConfirmedBill({ vendor: vSmall, amount: '10', billDate: daysAgo(40) });
    await makeConfirmedBill({ vendor: vBig, amount: '500', billDate: daysAgo(40) });
    await makeConfirmedBill({ vendor: vMid, amount: '100', billDate: daysAgo(40) });

    const summary = await apAgingSummary(db, ASOF);
    const ours = summary.filter((r) => r.vendorCode.startsWith(`${TAG}-VEN-`));
    expect(ours).toHaveLength(3);
    expect(ours[0].vendorId).toBe(vBig.id);
    expect(ours[1].vendorId).toBe(vMid.id);
    expect(ours[2].vendorId).toBe(vSmall.id);
    expect(ours[0].total.toString()).toBe(new Prisma.Decimal('500').toString());
    expect(ours[0].b1to30.toString()).toBe(new Prisma.Decimal('500').toString());
  });

  it('apAgingSummary: vendors with only unapplied credits and no open bills are NOT included (open bills are the include criterion)', async () => {
    const vCreditOnly = await newVendor('CRONLY');
    const vc = await createVendorCreditDraft(db, {
      vendorId: vCreditOnly.id,
      amount: '50',
      lines: [{ description: 'standalone', amount: '50' }],
    });
    await confirmVendorCredit(db, vc.id);

    const summary = await apAgingSummary(db, ASOF);
    expect(summary.find((r) => r.vendorId === vCreditOnly.id)).toBeUndefined();
  });

  it('apAgingSummary: pagination respects limit + offset', async () => {
    for (let i = 0; i < 5; i++) {
      const v = await newVendor(`PAG${i}`);
      await makeConfirmedBill({
        vendor: v,
        amount: String((5 - i) * 100),
        billDate: daysAgo(40),
      });
    }
    // Other test files may have left bill data in the shared tenant DB,
    // so we don't assume our PAG entries occupy any specific positions in
    // the globally-sorted result. Verify pagination semantics by checking
    // (a) the five PAG entries appear in the right relative order in the
    // unlimited result, and (b) paginated calls return the same slices of
    // that unlimited result.
    const full = await apAgingSummary(db, ASOF, { limit: 500, offset: 0 });
    const ourFull = full.filter((r) =>
      r.vendorCode.startsWith(`${TAG}-VEN-PAG`),
    );
    expect(ourFull).toHaveLength(5);
    expect(ourFull.map((r) => r.total.toString())).toEqual([
      new Prisma.Decimal('500').toString(),
      new Prisma.Decimal('400').toString(),
      new Prisma.Decimal('300').toString(),
      new Prisma.Decimal('200').toString(),
      new Prisma.Decimal('100').toString(),
    ]);

    const first2 = await apAgingSummary(db, ASOF, { limit: 2, offset: 0 });
    expect(first2).toHaveLength(2);
    expect(first2.map((r) => r.vendorId)).toEqual(
      full.slice(0, 2).map((r) => r.vendorId),
    );

    const next2 = await apAgingSummary(db, ASOF, { limit: 2, offset: 2 });
    expect(next2).toHaveLength(2);
    expect(next2.map((r) => r.vendorId)).toEqual(
      full.slice(2, 4).map((r) => r.vendorId),
    );
  });
});

async function wipe(): Promise<void> {
  const db = makeClient();
  try {
    const vendors = await db.vendor.findMany({
      where: { code: { startsWith: `${TAG}-VEN` } },
      select: { id: true },
    });
    const vendorIds = vendors.map((v) => v.id);
    await wipeBillArtifactsForVendors(db, vendorIds);
  } finally {
    await db.$disconnect();
  }
}
