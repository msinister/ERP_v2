import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AuditAction,
  BillPaymentStatus,
  PaymentMethod,
  PaymentStatus,
  Prisma,
  VendorCreditStatus,
} from '@/generated/tenant';
import type {
  GlAccount,
  PaymentTerm,
  PrismaClient,
  Product,
  ProductVariant,
  Vendor,
} from '@/generated/tenant';
import {
  confirmBill,
  createBill,
} from '@/server/services/bills';
import {
  recordBillPayment,
  reverseBillPayment,
} from '@/server/services/billPayments';
import { hasTenantDb, makeClient } from '../helpers/db';
import { upsertTestWarehouse } from '../helpers/warehouseStub';
import { upsertTestVendor } from '../helpers/vendorStub';
import { wipeBillArtifactsForVendors } from '../helpers/wipeBillArtifacts';

const suite = hasTenantDb ? describe : describe.skip;
const TAG = 'TEST-BPMT';

function assertBalanced(je: {
  lines: Array<{ debit: Prisma.Decimal; credit: Prisma.Decimal }>;
}): void {
  const dr = je.lines.reduce((acc, l) => acc.plus(l.debit), new Prisma.Decimal(0));
  const cr = je.lines.reduce((acc, l) => acc.plus(l.credit), new Prisma.Decimal(0));
  if (!dr.equals(cr)) {
    throw new Error(`JE not balanced: debits=${dr.toString()} credits=${cr.toString()}`);
  }
}

suite('BillPayment lifecycle (slice D)', () => {
  let db: PrismaClient;
  let term: PaymentTerm;
  let vendor: Vendor;
  let warehouseId: string;
  let product: Product;
  let variant: ProductVariant;
  let cashAccount: GlAccount;

  beforeAll(async () => {
    db = makeClient();
    term = await db.paymentTerm.findFirstOrThrow({ where: { code: 'NET30' } });
    const wh = await upsertTestWarehouse(db, {
      code: `${TAG}-WH`,
      name: 'BPMT WH',
    });
    warehouseId = wh.id;
    product = await db.product.upsert({
      where: { sku: `${TAG}-PROD` },
      create: { sku: `${TAG}-PROD`, name: 'BPMT Product' },
      update: { active: true, deletedAt: null },
    });
    variant = await db.productVariant.upsert({
      where: { sku: `${TAG}-V` },
      create: { productId: product.id, sku: `${TAG}-V`, name: 'V' },
      update: { productId: product.id, active: true, deletedAt: null },
    });
    cashAccount = await db.glAccount.findFirstOrThrow({ where: { code: '1110' } });
  });

  beforeEach(async () => {
    await wipe();
    vendor = await upsertTestVendor(db, {
      code: `${TAG}-VEN`,
      name: `${TAG} Vendor`,
    });
    await db.vendor.update({
      where: { id: vendor.id },
      data: { paymentTermId: term.id },
    });
  });

  afterAll(async () => {
    await wipe();
    await db.productVariant.deleteMany({ where: { productId: product.id } });
    await db.product.deleteMany({ where: { id: product.id } });
    await db.warehouse.deleteMany({ where: { code: `${TAG}-WH` } });
    await db.vendor.deleteMany({ where: { code: { startsWith: `${TAG}-VEN` } } });
    await db.$disconnect();
  });

  async function makeConfirmedBill(amount: string) {
    const bill = await createBill(db, {
      vendorId: vendor.id,
      lines: [
        {
          variantId: variant.id,
          description: 'widget',
          qty: '1',
          unitCost: amount,
        },
      ],
    });
    return confirmBill(db, bill.id);
  }

  // ---------- Happy path: exact-amount payment ----------

  it('recordBillPayment exact-amount: BPMT-YYYY-NNNNN, JE DR 2010 / CR 1110, bill flips to PAID', async () => {
    const bill = await makeConfirmedBill('100');
    const result = await recordBillPayment(db, {
      billId: bill.id,
      amount: '100',
      method: PaymentMethod.CHECK,
      cashAccountId: cashAccount.id,
      reference: 'CHK-001',
    });
    expect(result.billPayment.number).toMatch(/^BPMT-\d{4}-\d{5}$/);
    expect(result.billPayment.status).toBe(PaymentStatus.RECORDED);
    expect(result.billPayment.amount.toString()).toBe(new Prisma.Decimal('100').toString());
    expect(result.overpaymentCredit).toBeNull();

    const billAfter = await db.bill.findUniqueOrThrow({ where: { id: bill.id } });
    expect(billAfter.amountPaid.toString()).toBe(new Prisma.Decimal('100').toString());
    expect(billAfter.paymentStatus).toBe(BillPaymentStatus.PAID);

    const je = await db.journalEntry.findFirstOrThrow({
      where: { entityType: 'BillPayment', entityId: result.billPayment.id },
      include: { lines: { include: { account: true } } },
    });
    assertBalanced(je);
    expect(je.lines).toHaveLength(2);
    const ap = je.lines.find((l) => l.account.code === '2010');
    const cash = je.lines.find((l) => l.account.code === '1110');
    expect(ap?.debit.toString()).toBe(new Prisma.Decimal('100').toString());
    expect(cash?.credit.toString()).toBe(new Prisma.Decimal('100').toString());

    const audits = await db.auditLog.findMany({
      where: { entityType: 'BillPayment', entityId: result.billPayment.id },
    });
    expect(audits.find((a) => a.action === AuditAction.BILL_PAYMENT_RECORDED)).toBeDefined();
  });

  // ---------- Partial payment ----------

  it('recordBillPayment partial: bill flips to PARTIAL, balance reflects remainder', async () => {
    const bill = await makeConfirmedBill('100');
    await recordBillPayment(db, {
      billId: bill.id,
      amount: '40',
      method: PaymentMethod.ACH,
      cashAccountId: cashAccount.id,
    });
    const billAfter = await db.bill.findUniqueOrThrow({ where: { id: bill.id } });
    expect(billAfter.amountPaid.toString()).toBe(new Prisma.Decimal('40').toString());
    expect(billAfter.paymentStatus).toBe(BillPaymentStatus.PARTIAL);
  });

  it('multiple partial payments accumulate to PAID', async () => {
    const bill = await makeConfirmedBill('100');
    await recordBillPayment(db, {
      billId: bill.id,
      amount: '60',
      method: PaymentMethod.ACH,
      cashAccountId: cashAccount.id,
    });
    await recordBillPayment(db, {
      billId: bill.id,
      amount: '40',
      method: PaymentMethod.WIRE,
      cashAccountId: cashAccount.id,
    });
    const billAfter = await db.bill.findUniqueOrThrow({ where: { id: bill.id } });
    expect(billAfter.amountPaid.toString()).toBe(new Prisma.Decimal('100').toString());
    expect(billAfter.paymentStatus).toBe(BillPaymentStatus.PAID);
  });

  // ---------- Overpayment → auto-VC ----------

  it('overpayment auto-creates a CONFIRMED VendorCredit with sourceTag, posts BOTH JEs (payment + VC confirm)', async () => {
    const bill = await makeConfirmedBill('100');
    const result = await recordBillPayment(db, {
      billId: bill.id,
      amount: '120',
      method: PaymentMethod.CHECK,
      cashAccountId: cashAccount.id,
      reference: 'CHK-OVER',
    });
    expect(result.overpaymentCredit).not.toBeNull();
    const vc = result.overpaymentCredit!;
    expect(vc.status).toBe(VendorCreditStatus.CONFIRMED);
    expect(vc.amount.toString()).toBe(new Prisma.Decimal('20').toString());
    expect(vc.sourceTag).toBe(`OVERPAYMENT:${result.billPayment.id}`);
    expect(vc.vendorId).toBe(vendor.id);

    // Bill: amountPaid CAPPED at total (the $20 excess lives on the VC).
    const billAfter = await db.bill.findUniqueOrThrow({ where: { id: bill.id } });
    expect(billAfter.amountPaid.toString()).toBe(new Prisma.Decimal('100').toString());
    expect(billAfter.paymentStatus).toBe(BillPaymentStatus.PAID);

    // BillPayment JE: full $120 (DR AP / CR Cash).
    const pmtJe = await db.journalEntry.findFirstOrThrow({
      where: { entityType: 'BillPayment', entityId: result.billPayment.id },
      include: { lines: { include: { account: true } } },
    });
    assertBalanced(pmtJe);
    const pmtAp = pmtJe.lines.find((l) => l.account.code === '2010');
    expect(pmtAp?.debit.toString()).toBe(new Prisma.Decimal('120').toString());

    // VC confirm JE: $20 (DR AP / CR VCA).
    const vcJe = await db.journalEntry.findFirstOrThrow({
      where: { entityType: 'VendorCredit', entityId: vc.id },
      include: { lines: { include: { account: true } } },
    });
    assertBalanced(vcJe);
    const vcAp = vcJe.lines.find((l) => l.account.code === '2010');
    const vcca = vcJe.lines.find((l) => l.account.code === '2030');
    expect(vcAp?.debit.toString()).toBe(new Prisma.Decimal('20').toString());
    expect(vcca?.credit.toString()).toBe(new Prisma.Decimal('20').toString());

    // VC confirm audit also written.
    const vcAudits = await db.auditLog.findMany({
      where: { entityType: 'VendorCredit', entityId: vc.id },
    });
    expect(vcAudits.find((a) => a.action === AuditAction.VENDOR_CREDIT_CONFIRMED)).toBeDefined();
  });

  // ---------- Validation rejections ----------

  it('rejects APPLIED_CREDIT method (vendor credits flow through their own endpoint)', async () => {
    const bill = await makeConfirmedBill('50');
    // Cast to bypass the TS refinement — the validation schema rejects
    // APPLIED_CREDIT at runtime; this test verifies that runtime guard.
    await expect(
      recordBillPayment(db, {
        billId: bill.id,
        amount: '50',
        method: PaymentMethod.APPLIED_CREDIT as unknown as typeof PaymentMethod.CHECK,
        cashAccountId: cashAccount.id,
      }),
    ).rejects.toThrow(/APPLIED_CREDIT is not valid/);
  });

  it('rejects payment on DRAFT bill', async () => {
    const bill = await createBill(db, {
      vendorId: vendor.id,
      lines: [
        { variantId: variant.id, description: 'x', qty: '1', unitCost: '50' },
      ],
    });
    await expect(
      recordBillPayment(db, {
        billId: bill.id,
        amount: '50',
        method: PaymentMethod.CHECK,
        cashAccountId: cashAccount.id,
      }),
    ).rejects.toThrow(/Cannot record payment on bill in status DRAFT/);
  });

  it('rejects non-ASSET cashAccountId (e.g., AP/2010 LIABILITY)', async () => {
    const apAccount = await db.glAccount.findFirstOrThrow({ where: { code: '2010' } });
    const bill = await makeConfirmedBill('50');
    await expect(
      recordBillPayment(db, {
        billId: bill.id,
        amount: '50',
        method: PaymentMethod.CHECK,
        cashAccountId: apAccount.id,
      }),
    ).rejects.toThrow(/cashAccountId must point at an ASSET-type GlAccount/);
  });

  // ---------- Reverse ----------

  it('reverseBillPayment: status → REVERSED, mirror JE posted, bill denorm reset', async () => {
    const bill = await makeConfirmedBill('100');
    const { billPayment } = await recordBillPayment(db, {
      billId: bill.id,
      amount: '100',
      method: PaymentMethod.CHECK,
      cashAccountId: cashAccount.id,
    });

    const reversed = await reverseBillPayment(db, billPayment.id, {
      reason: 'wrong vendor',
    });
    expect(reversed.status).toBe(PaymentStatus.REVERSED);
    expect(reversed.reversedAt).not.toBeNull();
    expect(reversed.reversedReason).toBe('wrong vendor');

    const billAfter = await db.bill.findUniqueOrThrow({ where: { id: bill.id } });
    expect(billAfter.amountPaid.toString()).toBe(new Prisma.Decimal('0').toString());
    expect(billAfter.paymentStatus).toBe(BillPaymentStatus.UNPAID);

    const jes = await db.journalEntry.findMany({
      where: { entityType: 'BillPayment', entityId: billPayment.id },
      include: { lines: { include: { account: true } } },
    });
    expect(jes).toHaveLength(2);
    const reverseJe = jes.find((j) => j.description.startsWith('Reverse bill payment'));
    expect(reverseJe).toBeDefined();
    assertBalanced(reverseJe!);
    const cash = reverseJe!.lines.find((l) => l.account.code === '1110');
    const ap = reverseJe!.lines.find((l) => l.account.code === '2010');
    expect(cash?.debit.toString()).toBe(new Prisma.Decimal('100').toString());
    expect(ap?.credit.toString()).toBe(new Prisma.Decimal('100').toString());
  });

  it('reverseBillPayment with overpayment-VC: cancels the unapplied VC inline', async () => {
    const bill = await makeConfirmedBill('100');
    const { billPayment, overpaymentCredit } = await recordBillPayment(db, {
      billId: bill.id,
      amount: '120',
      method: PaymentMethod.CHECK,
      cashAccountId: cashAccount.id,
    });
    expect(overpaymentCredit).not.toBeNull();

    await reverseBillPayment(db, billPayment.id, { reason: 'mistake' });

    const vcAfter = await db.vendorCredit.findUniqueOrThrow({
      where: { id: overpaymentCredit!.id },
    });
    expect(vcAfter.status).toBe(VendorCreditStatus.CANCELLED);
    expect(vcAfter.cancelReason).toMatch(/Source BillPayment .* reversed/);

    // VC cancel JE posted (mirror of confirm).
    const vcJes = await db.journalEntry.findMany({
      where: { entityType: 'VendorCredit', entityId: overpaymentCredit!.id },
    });
    expect(vcJes).toHaveLength(2); // confirm + cancel
  });

  it('reverseBillPayment refuses if overpayment-VC has been applied', async () => {
    const billA = await makeConfirmedBill('100');
    const billB = await makeConfirmedBill('30');
    const { billPayment, overpaymentCredit } = await recordBillPayment(db, {
      billId: billA.id,
      amount: '150',
      method: PaymentMethod.CHECK,
      cashAccountId: cashAccount.id,
    });
    expect(overpaymentCredit).not.toBeNull();

    // Apply some of the VC.
    const { applyVendorCreditToBill } = await import('@/server/services/vendorCredits');
    await applyVendorCreditToBill(db, overpaymentCredit!.id, {
      billId: billB.id,
      amount: '20',
    });

    await expect(
      reverseBillPayment(db, billPayment.id, { reason: 'oops' }),
    ).rejects.toThrow(/has been applied/);
  });

  it('reverseBillPayment idempotency: refuses second reverse', async () => {
    const bill = await makeConfirmedBill('50');
    const { billPayment } = await recordBillPayment(db, {
      billId: bill.id,
      amount: '50',
      method: PaymentMethod.ACH,
      cashAccountId: cashAccount.id,
    });
    await reverseBillPayment(db, billPayment.id, { reason: 'first' });
    await expect(
      reverseBillPayment(db, billPayment.id, { reason: 'second' }),
    ).rejects.toThrow(/already REVERSED/);
  });

  // ---------- Cancel guard ----------

  it('bill cancellation refuses when amountPaid > 0 (slice B guard exercised here for completeness)', async () => {
    const bill = await makeConfirmedBill('50');
    await recordBillPayment(db, {
      billId: bill.id,
      amount: '50',
      method: PaymentMethod.CASH,
      cashAccountId: cashAccount.id,
    });
    const { cancelBill } = await import('@/server/services/bills');
    await expect(cancelBill(db, bill.id, 'attempt')).rejects.toThrow(
      /applied payments or credits/,
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
