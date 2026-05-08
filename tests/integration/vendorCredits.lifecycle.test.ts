import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AuditAction,
  BillPaymentStatus,
  Prisma,
  VendorCreditStatus,
} from '@/generated/tenant';
import type {
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
  applyVendorCreditToBill,
  cancelVendorCredit,
  confirmVendorCredit,
  createVendorCreditDraft,
  listVendorCredits,
  reverseVendorCreditApplication,
  softDeleteVendorCredit,
  updateVendorCredit,
} from '@/server/services/vendorCredits';
import { hasTenantDb, makeClient } from '../helpers/db';
import { upsertTestWarehouse } from '../helpers/warehouseStub';
import { upsertTestVendor } from '../helpers/vendorStub';
import { wipeBillArtifactsForVendors } from '../helpers/wipeBillArtifacts';

const suite = hasTenantDb ? describe : describe.skip;
const TAG = 'TEST-VC';

function assertBalanced(je: {
  lines: Array<{ debit: Prisma.Decimal; credit: Prisma.Decimal }>;
}): void {
  const dr = je.lines.reduce((acc, l) => acc.plus(l.debit), new Prisma.Decimal(0));
  const cr = je.lines.reduce((acc, l) => acc.plus(l.credit), new Prisma.Decimal(0));
  if (!dr.equals(cr)) {
    throw new Error(`JE not balanced: debits=${dr.toString()} credits=${cr.toString()}`);
  }
}

suite('VendorCredit lifecycle (slice D)', () => {
  let db: PrismaClient;
  let term: PaymentTerm;
  let vendor: Vendor;
  let otherVendor: Vendor;
  let product: Product;
  let variant: ProductVariant;

  beforeAll(async () => {
    db = makeClient();
    term = await db.paymentTerm.findFirstOrThrow({ where: { code: 'NET30' } });
    await upsertTestWarehouse(db, { code: `${TAG}-WH`, name: 'VC WH' });
    product = await db.product.upsert({
      where: { sku: `${TAG}-PROD` },
      create: { sku: `${TAG}-PROD`, name: 'VC Product' },
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
    vendor = await upsertTestVendor(db, {
      code: `${TAG}-VEN`,
      name: `${TAG} Vendor`,
    });
    otherVendor = await upsertTestVendor(db, {
      code: `${TAG}-VEN2`,
      name: `${TAG} Vendor 2`,
    });
    await db.vendor.update({
      where: { id: vendor.id },
      data: { paymentTermId: term.id },
    });
    await db.vendor.update({
      where: { id: otherVendor.id },
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

  async function makeConfirmedBill(forVendor: Vendor, amount: string) {
    const bill = await createBill(db, {
      vendorId: forVendor.id,
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

  // ---------- createVendorCreditDraft ----------

  it('createVendorCreditDraft: VCM-YYYY-NNNNN, status DRAFT, no JE', async () => {
    const vc = await createVendorCreditDraft(db, {
      vendorId: vendor.id,
      amount: '50',
      reason: 'damaged shipment',
      lines: [
        { description: 'damaged box A', amount: '30' },
        { description: 'damaged box B', amount: '20' },
      ],
    });
    expect(vc.number).toMatch(/^VCM-\d{4}-\d{5}$/);
    expect(vc.status).toBe(VendorCreditStatus.DRAFT);
    expect(vc.amount.toString()).toBe(new Prisma.Decimal('50').toString());
    expect(vc.lines).toHaveLength(2);
    const jes = await db.journalEntry.findMany({
      where: { entityType: 'VendorCredit', entityId: vc.id },
    });
    expect(jes).toHaveLength(0);
  });

  it('createVendorCreditDraft: line sum mismatch throws', async () => {
    await expect(
      createVendorCreditDraft(db, {
        vendorId: vendor.id,
        amount: '50',
        lines: [{ description: 'wrong', amount: '40' }],
      }),
    ).rejects.toThrow(/Line totals .* don't match credit amount/);
  });

  it('createVendorCreditDraft: rejects soft-deleted vendor', async () => {
    await db.vendor.update({
      where: { id: vendor.id },
      data: { deletedAt: new Date() },
    });
    await expect(
      createVendorCreditDraft(db, {
        vendorId: vendor.id,
        amount: '10',
        lines: [{ description: 'x', amount: '10' }],
      }),
    ).rejects.toThrow(/Vendor not found/);
  });

  // ---------- confirmVendorCredit ----------

  it('confirmVendorCredit: status flips, JE DR 2010 / CR 2030 balanced', async () => {
    const vc = await createVendorCreditDraft(db, {
      vendorId: vendor.id,
      amount: '50',
      lines: [{ description: 'item', amount: '50' }],
    });
    const after = await confirmVendorCredit(db, vc.id);
    expect(after.status).toBe(VendorCreditStatus.CONFIRMED);
    expect(after.confirmedAt).not.toBeNull();

    const je = await db.journalEntry.findFirstOrThrow({
      where: { entityType: 'VendorCredit', entityId: vc.id },
      include: { lines: { include: { account: true } } },
    });
    assertBalanced(je);
    expect(je.lines).toHaveLength(2);
    const ap = je.lines.find((l) => l.account.code === '2010');
    const vca = je.lines.find((l) => l.account.code === '2030');
    expect(ap?.debit.toString()).toBe(new Prisma.Decimal('50').toString());
    expect(vca?.credit.toString()).toBe(new Prisma.Decimal('50').toString());

    const audits = await db.auditLog.findMany({
      where: { entityType: 'VendorCredit', entityId: vc.id, action: AuditAction.VENDOR_CREDIT_CONFIRMED },
    });
    expect(audits).toHaveLength(1);
  });

  it('confirmVendorCredit on already-confirmed throws', async () => {
    const vc = await createVendorCreditDraft(db, {
      vendorId: vendor.id,
      amount: '10',
      lines: [{ description: 'x', amount: '10' }],
    });
    await confirmVendorCredit(db, vc.id);
    await expect(confirmVendorCredit(db, vc.id)).rejects.toThrow(/Cannot confirm/);
  });

  // ---------- applyVendorCreditToBill ----------

  it('applyVendorCreditToBill: NO JE posted, denorms updated, application row created', async () => {
    const bill = await makeConfirmedBill(vendor, '100');
    const vc = await createVendorCreditDraft(db, {
      vendorId: vendor.id,
      amount: '30',
      lines: [{ description: 'partial', amount: '30' }],
    });
    await confirmVendorCredit(db, vc.id);
    const application = await applyVendorCreditToBill(db, vc.id, {
      billId: bill.id,
      amount: '30',
    });
    expect(application.amount.toString()).toBe(new Prisma.Decimal('30').toString());
    expect(application.reversedAt).toBeNull();

    // Bill denorms.
    const billAfter = await db.bill.findUniqueOrThrow({ where: { id: bill.id } });
    expect(billAfter.amountCredited.toString()).toBe(new Prisma.Decimal('30').toString());
    expect(billAfter.paymentStatus).toBe(BillPaymentStatus.PARTIAL);

    // VC denorm.
    const vcAfter = await db.vendorCredit.findUniqueOrThrow({ where: { id: vc.id } });
    expect(vcAfter.appliedAmount.toString()).toBe(new Prisma.Decimal('30').toString());

    // NO new JE posted by apply (only the confirm JE exists).
    const jes = await db.journalEntry.findMany({
      where: { entityType: 'VendorCredit', entityId: vc.id },
    });
    expect(jes).toHaveLength(1);
    const appJes = await db.journalEntry.findMany({
      where: {
        entityType: 'VendorCreditApplication',
        entityId: application.id,
      },
    });
    expect(appJes).toHaveLength(0);

    // Audit row.
    const audits = await db.auditLog.findMany({
      where: {
        entityType: 'VendorCreditApplication',
        entityId: application.id,
        action: AuditAction.VENDOR_CREDIT_APPLIED,
      },
    });
    expect(audits).toHaveLength(1);
  });

  it('applying full VC amount flips bill to PAID', async () => {
    const bill = await makeConfirmedBill(vendor, '40');
    const vc = await createVendorCreditDraft(db, {
      vendorId: vendor.id,
      amount: '40',
      lines: [{ description: 'full credit', amount: '40' }],
    });
    await confirmVendorCredit(db, vc.id);
    await applyVendorCreditToBill(db, vc.id, { billId: bill.id, amount: '40' });
    const billAfter = await db.bill.findUniqueOrThrow({ where: { id: bill.id } });
    expect(billAfter.paymentStatus).toBe(BillPaymentStatus.PAID);
  });

  it('applyVendorCreditToBill: rejects cross-vendor', async () => {
    const otherBill = await makeConfirmedBill(otherVendor, '50');
    const vc = await createVendorCreditDraft(db, {
      vendorId: vendor.id,
      amount: '20',
      lines: [{ description: 'x', amount: '20' }],
    });
    await confirmVendorCredit(db, vc.id);
    await expect(
      applyVendorCreditToBill(db, vc.id, {
        billId: otherBill.id,
        amount: '20',
      }),
    ).rejects.toThrow(/Cross-vendor application/);
  });

  it('applyVendorCreditToBill: rejects amount > VC remaining', async () => {
    const bill = await makeConfirmedBill(vendor, '100');
    const vc = await createVendorCreditDraft(db, {
      vendorId: vendor.id,
      amount: '20',
      lines: [{ description: 'x', amount: '20' }],
    });
    await confirmVendorCredit(db, vc.id);
    await expect(
      applyVendorCreditToBill(db, vc.id, { billId: bill.id, amount: '30' }),
    ).rejects.toThrow(/exceeds VC remaining balance/);
  });

  it('applyVendorCreditToBill: rejects amount > bill remaining', async () => {
    const bill = await makeConfirmedBill(vendor, '20');
    const vc = await createVendorCreditDraft(db, {
      vendorId: vendor.id,
      amount: '50',
      lines: [{ description: 'x', amount: '50' }],
    });
    await confirmVendorCredit(db, vc.id);
    await expect(
      applyVendorCreditToBill(db, vc.id, { billId: bill.id, amount: '50' }),
    ).rejects.toThrow(/exceeds bill remaining balance/);
  });

  it('applyVendorCreditToBill: partial-unique-index blocks duplicate live application on (vc, bill)', async () => {
    const bill = await makeConfirmedBill(vendor, '100');
    const vc = await createVendorCreditDraft(db, {
      vendorId: vendor.id,
      amount: '50',
      lines: [{ description: 'x', amount: '50' }],
    });
    await confirmVendorCredit(db, vc.id);
    await applyVendorCreditToBill(db, vc.id, { billId: bill.id, amount: '20' });
    // Second live apply on same (vc, bill) hits the partial unique index.
    await expect(
      applyVendorCreditToBill(db, vc.id, { billId: bill.id, amount: '10' }),
    ).rejects.toThrow();
  });

  it('applyVendorCreditToBill: only CONFIRMED VCs can apply', async () => {
    const bill = await makeConfirmedBill(vendor, '50');
    const vc = await createVendorCreditDraft(db, {
      vendorId: vendor.id,
      amount: '30',
      lines: [{ description: 'x', amount: '30' }],
    });
    await expect(
      applyVendorCreditToBill(db, vc.id, { billId: bill.id, amount: '30' }),
    ).rejects.toThrow(/only CONFIRMED can be applied/);
  });

  // ---------- reverseVendorCreditApplication ----------

  it('reverseVendorCreditApplication: sets reversedAt, drops both denorms', async () => {
    const bill = await makeConfirmedBill(vendor, '100');
    const vc = await createVendorCreditDraft(db, {
      vendorId: vendor.id,
      amount: '30',
      lines: [{ description: 'x', amount: '30' }],
    });
    await confirmVendorCredit(db, vc.id);
    const app = await applyVendorCreditToBill(db, vc.id, {
      billId: bill.id,
      amount: '30',
    });
    await reverseVendorCreditApplication(db, app.id, 'wrong bill');

    const appAfter = await db.vendorCreditApplication.findUniqueOrThrow({
      where: { id: app.id },
    });
    expect(appAfter.reversedAt).not.toBeNull();

    const vcAfter = await db.vendorCredit.findUniqueOrThrow({ where: { id: vc.id } });
    expect(vcAfter.appliedAmount.toString()).toBe(new Prisma.Decimal('0').toString());

    const billAfter = await db.bill.findUniqueOrThrow({ where: { id: bill.id } });
    expect(billAfter.amountCredited.toString()).toBe(new Prisma.Decimal('0').toString());
    expect(billAfter.paymentStatus).toBe(BillPaymentStatus.UNPAID);
  });

  it('reverseVendorCreditApplication: idempotency — refuses second reverse', async () => {
    const bill = await makeConfirmedBill(vendor, '50');
    const vc = await createVendorCreditDraft(db, {
      vendorId: vendor.id,
      amount: '20',
      lines: [{ description: 'x', amount: '20' }],
    });
    await confirmVendorCredit(db, vc.id);
    const app = await applyVendorCreditToBill(db, vc.id, {
      billId: bill.id,
      amount: '20',
    });
    await reverseVendorCreditApplication(db, app.id, 'first');
    await expect(
      reverseVendorCreditApplication(db, app.id, 'second'),
    ).rejects.toThrow(/already reversed/);
  });

  it('after reversal, re-applying same (vc, bill) succeeds (partial unique index allows reversed-then-new)', async () => {
    const bill = await makeConfirmedBill(vendor, '100');
    const vc = await createVendorCreditDraft(db, {
      vendorId: vendor.id,
      amount: '30',
      lines: [{ description: 'x', amount: '30' }],
    });
    await confirmVendorCredit(db, vc.id);
    const app1 = await applyVendorCreditToBill(db, vc.id, {
      billId: bill.id,
      amount: '30',
    });
    await reverseVendorCreditApplication(db, app1.id, 'recompute');
    // Second live apply on same (vc, bill) now allowed because the
    // first one is reversedAt != null.
    const app2 = await applyVendorCreditToBill(db, vc.id, {
      billId: bill.id,
      amount: '30',
    });
    expect(app2.id).not.toBe(app1.id);
  });

  // ---------- cancelVendorCredit ----------

  it('cancelVendorCredit on DRAFT: status flip, no JE', async () => {
    const vc = await createVendorCreditDraft(db, {
      vendorId: vendor.id,
      amount: '20',
      lines: [{ description: 'x', amount: '20' }],
    });
    const after = await cancelVendorCredit(db, vc.id, { reason: 'mistake' });
    expect(after.status).toBe(VendorCreditStatus.CANCELLED);
    expect(after.cancelReason).toBe('mistake');
    const jes = await db.journalEntry.findMany({
      where: { entityType: 'VendorCredit', entityId: vc.id },
    });
    expect(jes).toHaveLength(0);
  });

  it('cancelVendorCredit on CONFIRMED unapplied: posts mirror JE', async () => {
    const vc = await createVendorCreditDraft(db, {
      vendorId: vendor.id,
      amount: '40',
      lines: [{ description: 'x', amount: '40' }],
    });
    await confirmVendorCredit(db, vc.id);
    await cancelVendorCredit(db, vc.id, { reason: 'vendor pulled credit' });

    const jes = await db.journalEntry.findMany({
      where: { entityType: 'VendorCredit', entityId: vc.id },
      include: { lines: { include: { account: true } } },
    });
    expect(jes).toHaveLength(2);
    for (const je of jes) assertBalanced(je);
    const cancelJe = jes.find((j) => j.description.startsWith('Cancel vendor credit'));
    expect(cancelJe).toBeDefined();
    const vca = cancelJe!.lines.find((l) => l.account.code === '2030');
    const ap = cancelJe!.lines.find((l) => l.account.code === '2010');
    expect(vca?.debit.toString()).toBe(new Prisma.Decimal('40').toString());
    expect(ap?.credit.toString()).toBe(new Prisma.Decimal('40').toString());
  });

  it('cancelVendorCredit on CONFIRMED with applied amount: refused', async () => {
    const bill = await makeConfirmedBill(vendor, '50');
    const vc = await createVendorCreditDraft(db, {
      vendorId: vendor.id,
      amount: '20',
      lines: [{ description: 'x', amount: '20' }],
    });
    await confirmVendorCredit(db, vc.id);
    await applyVendorCreditToBill(db, vc.id, { billId: bill.id, amount: '20' });
    await expect(
      cancelVendorCredit(db, vc.id, { reason: 'attempt' }),
    ).rejects.toThrow(/applied balance.*Reverse the applications first/);
  });

  // ---------- updateVendorCredit + softDeleteVendorCredit + listing ----------

  it('updateVendorCredit on DRAFT replaces lines, recomputes amount; CONFIRMED rejects', async () => {
    const vc = await createVendorCreditDraft(db, {
      vendorId: vendor.id,
      amount: '20',
      lines: [{ description: 'old', amount: '20' }],
    });
    const updated = await updateVendorCredit(db, vc.id, {
      amount: '50',
      lines: [
        { description: 'new1', amount: '30' },
        { description: 'new2', amount: '20' },
      ],
    });
    expect(updated.amount.toString()).toBe(new Prisma.Decimal('50').toString());
    expect(updated.lines).toHaveLength(2);

    await confirmVendorCredit(db, vc.id);
    await expect(
      updateVendorCredit(db, vc.id, { amount: '60' }),
    ).rejects.toThrow(/only DRAFT is editable/);
  });

  it('softDeleteVendorCredit on DRAFT marks deletedAt; on CONFIRMED throws', async () => {
    const vc = await createVendorCreditDraft(db, {
      vendorId: vendor.id,
      amount: '10',
      lines: [{ description: 'x', amount: '10' }],
    });
    const deleted = await softDeleteVendorCredit(db, vc.id);
    expect(deleted.deletedAt).not.toBeNull();

    const vc2 = await createVendorCreditDraft(db, {
      vendorId: vendor.id,
      amount: '10',
      lines: [{ description: 'x', amount: '10' }],
    });
    await confirmVendorCredit(db, vc2.id);
    await expect(softDeleteVendorCredit(db, vc2.id)).rejects.toThrow(
      /Cancel CONFIRMED credits instead/,
    );
  });

  it('listVendorCredits filters by vendor + status; excludes soft-deleted', async () => {
    const a = await createVendorCreditDraft(db, {
      vendorId: vendor.id,
      amount: '10',
      lines: [{ description: 'a', amount: '10' }],
    });
    const b = await createVendorCreditDraft(db, {
      vendorId: vendor.id,
      amount: '20',
      lines: [{ description: 'b', amount: '20' }],
    });
    await confirmVendorCredit(db, b.id);
    const c = await createVendorCreditDraft(db, {
      vendorId: otherVendor.id,
      amount: '30',
      lines: [{ description: 'c', amount: '30' }],
    });

    const ours = await listVendorCredits(db, { vendorId: vendor.id });
    const ids = ours.map((v) => v.id).sort();
    expect(ids).toEqual([a.id, b.id].sort());

    const drafts = await listVendorCredits(db, {
      vendorId: vendor.id,
      status: VendorCreditStatus.DRAFT,
    });
    expect(drafts.find((v) => v.id === a.id)).toBeDefined();
    expect(drafts.find((v) => v.id === b.id)).toBeUndefined();

    await softDeleteVendorCredit(db, c.id);
    const otherList = await listVendorCredits(db, { vendorId: otherVendor.id });
    expect(otherList.find((v) => v.id === c.id)).toBeUndefined();
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
