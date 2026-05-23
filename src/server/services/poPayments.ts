import {
  AccountType,
  AuditAction,
  PaymentStatus,
  Prisma,
} from '@/generated/tenant';
import type {
  PoPayment,
  PoPaymentApplication,
  PrismaClient,
} from '@/generated/tenant';
import { audit, type AuditContext } from '@/lib/audit/audit';
import { post } from '@/lib/gl/post';
import { getNextSequence } from '@/lib/sequences/sequences';
import {
  recordPoPaymentInputSchema,
  voidPoPaymentInputSchema,
  type RecordPoPaymentInput,
  type VoidPoPaymentInput,
} from '@/lib/validation/purchasing';
import { recomputeBillDenormsTx } from './bills';

// =============================================================================
// PoPayment service. Money paid directly against a PO before a bill exists
// (prepay / import deposits). Spec: feature brief "PO Shipment Tracking +
// PO Direct Payments".
//
// Sequence: POPMT-YYYY-NNNNN.
//
// JE on record:  DR 1510 Vendor Deposits / CR <cashAccount>  (deposit asset)
// JE on apply:   DR 2010 AP            / CR 1510             (deposit consumed)
// JE on void:    per live application  DR 1510 / CR 2010 AP  (unwind apply)
//                then deposit cash leg  DR <cashAccount> / CR 1510
//
// Auto-apply: applyPoPaymentsToBillTx runs inside postReceipt right after a
// bill auto-confirms. It consumes the PO's unapplied deposits oldest-first,
// splitting a single deposit across the bill's remaining balance and
// leaving any remainder for the next bill from the same PO. Mirrors the
// VendorCredit ↔ VendorCreditApplication architecture.
// =============================================================================

const PO_PAYMENT_SEQUENCE_NAME = 'po_payment';
const PO_PAYMENT_PREFIX = 'POPMT';

const AP_ACCOUNT = '2010';
const VENDOR_DEPOSITS_ASSET = '1510';

export type PoPaymentResult = {
  poPayment: PoPayment;
};

// ---------------------------------------------------------------------------
// recordPoPayment — DR 1510 Vendor Deposits / CR <cashAccount>.
// ---------------------------------------------------------------------------

export async function recordPoPayment(
  db: PrismaClient,
  purchaseOrderId: string,
  input: RecordPoPaymentInput,
  ctx?: AuditContext,
): Promise<PoPaymentResult> {
  const data = recordPoPaymentInputSchema.parse(input);
  const amount = new Prisma.Decimal(data.amount);
  const paymentDate = data.paymentDate ?? new Date();

  return db.$transaction(async (tx) => {
    // Lock the PO so a concurrent receipt-time auto-apply can't race the
    // deposit becoming visible.
    await tx.$executeRaw`SELECT 1 FROM "PurchaseOrder" WHERE "id" = ${purchaseOrderId} FOR UPDATE`;
    const po = await tx.purchaseOrder.findFirst({
      where: { id: purchaseOrderId, deletedAt: null },
      select: {
        id: true,
        number: true,
        vendorId: true,
        vendor: { select: { name: true } },
      },
    });
    if (!po) throw new Error(`PurchaseOrder not found: ${purchaseOrderId}`);

    // Validate the cash account. ASSET (cash/bank) or LIABILITY (e.g. a
    // credit-card payable) — same rule as bill payments. Other types make
    // no sense as a deposit source.
    const cashAccount = await tx.glAccount.findUnique({
      where: { id: data.cashAccountId },
      select: { id: true, code: true, type: true, active: true, deletedAt: true },
    });
    if (!cashAccount || cashAccount.deletedAt) {
      throw new Error(`GlAccount not found: ${data.cashAccountId}`);
    }
    if (
      cashAccount.type !== AccountType.ASSET &&
      cashAccount.type !== AccountType.LIABILITY
    ) {
      throw new Error(
        `cashAccountId must point at an ASSET- or LIABILITY-type GlAccount; ${cashAccount.code} is ${cashAccount.type}`,
      );
    }
    if (!cashAccount.active) {
      throw new Error(`GlAccount ${cashAccount.code} is inactive`);
    }

    const seq = await getNextSequence(tx, {
      name: PO_PAYMENT_SEQUENCE_NAME,
      prefix: PO_PAYMENT_PREFIX,
      useYear: true,
    });

    const created = await tx.poPayment.create({
      data: {
        number: seq.formatted,
        purchaseOrderId: po.id,
        vendorId: po.vendorId,
        amount,
        method: data.method ?? null,
        cashAccountId: cashAccount.id,
        paymentDate,
        reference: data.reference ?? null,
        notes: data.notes ?? null,
        status: PaymentStatus.RECORDED,
        appliedAmount: new Prisma.Decimal(0),
        createdById: ctx?.userId ?? null,
      },
    });

    // Post the deposit JE: DR 1510 Vendor Deposits / CR <cashAccount>.
    const je = await post(tx, {
      entityType: 'PoPayment',
      entityId: created.id,
      description: `PO deposit ${created.number} — PO ${po.number} — ${po.vendor.name}`,
      postedAt: paymentDate,
      lines: [
        {
          accountCode: VENDOR_DEPOSITS_ASSET,
          debit: amount,
          memo: `PO deposit — PO#${po.number} — ${po.vendor.name}`,
        },
        {
          accountCode: cashAccount.code,
          credit: amount,
          memo: `Cash out — deposit ${created.number}${data.reference ? ` ref ${data.reference}` : ''}`,
        },
      ],
    });

    const poPayment = await tx.poPayment.update({
      where: { id: created.id },
      data: { journalEntryId: je.id },
    });

    await audit(tx, {
      action: AuditAction.PO_PAYMENT_RECORDED,
      entityType: 'PoPayment',
      entityId: poPayment.id,
      after: poPayment,
      ctx,
    });

    return { poPayment };
  });
}

// ---------------------------------------------------------------------------
// applyPoPaymentsToBillTx — consume the PO's unapplied deposits against a
// freshly-confirmed bill. Oldest-first, split-capable. Called inside
// postReceipt after confirmBillTx (same transaction).
//
// Returns the applications created (empty if the bill links to no PO with
// unapplied deposits, or is already fully settled).
// ---------------------------------------------------------------------------

export async function applyPoPaymentsToBillTx(
  tx: Prisma.TransactionClient,
  billId: string,
  ctx?: AuditContext,
): Promise<PoPaymentApplication[]> {
  const bill = await tx.bill.findUnique({
    where: { id: billId },
    select: {
      id: true,
      number: true,
      billDate: true,
      status: true,
      total: true,
      amountPaid: true,
      amountCredited: true,
      amountDeposited: true,
      deletedAt: true,
    },
  });
  // Only consume deposits against a live, confirmed bill carrying a balance.
  if (!bill || bill.deletedAt || bill.status !== 'CONFIRMED') return [];

  let billRemaining = bill.total
    .minus(bill.amountPaid)
    .minus(bill.amountCredited)
    .minus(bill.amountDeposited);
  if (billRemaining.lessThanOrEqualTo(0)) return [];

  // POs linked to this bill (BillPurchaseOrder join — populated at bill
  // create time from receiptLine → poLine → po).
  const poLinks = await tx.billPurchaseOrder.findMany({
    where: { billId },
    select: { purchaseOrderId: true },
  });
  if (poLinks.length === 0) return [];
  const poIds = poLinks.map((l) => l.purchaseOrderId);

  // Candidate deposits: RECORDED, not soft-deleted, on a linked PO, with
  // unapplied balance. Oldest-first by paymentDate then createdAt.
  const candidates = await tx.poPayment.findMany({
    where: {
      purchaseOrderId: { in: poIds },
      status: PaymentStatus.RECORDED,
      deletedAt: null,
    },
    orderBy: [{ paymentDate: 'asc' }, { createdAt: 'asc' }],
    select: { id: true },
  });

  const applications: PoPaymentApplication[] = [];

  for (const candidate of candidates) {
    if (billRemaining.lessThanOrEqualTo(0)) break;

    // Lock + re-read the deposit so a concurrent void can't double-spend it.
    await tx.$executeRaw`SELECT 1 FROM "PoPayment" WHERE "id" = ${candidate.id} FOR UPDATE`;
    const payment = await tx.poPayment.findUnique({
      where: { id: candidate.id },
      select: {
        id: true,
        number: true,
        status: true,
        amount: true,
        appliedAmount: true,
        deletedAt: true,
      },
    });
    if (!payment || payment.deletedAt || payment.status !== PaymentStatus.RECORDED) {
      continue;
    }
    const depositRemaining = payment.amount.minus(payment.appliedAmount);
    if (depositRemaining.lessThanOrEqualTo(0)) continue;

    const applyAmt = depositRemaining.lessThan(billRemaining)
      ? depositRemaining
      : billRemaining;

    const application = await tx.poPaymentApplication.create({
      data: {
        poPaymentId: payment.id,
        billId: bill.id,
        amount: applyAmt,
        appliedById: ctx?.userId ?? null,
        notes: `Auto-applied at receipt time to bill ${bill.number}`,
      },
    });

    await tx.poPayment.update({
      where: { id: payment.id },
      data: { appliedAmount: payment.appliedAmount.plus(applyAmt) },
    });

    // GL: reduce AP using the deposit asset. DR 2010 AP / CR 1510. Same
    // billDate as the confirm JE so it lands in the same period.
    await post(tx, {
      entityType: 'PoPaymentApplication',
      entityId: application.id,
      description: `Apply PO deposit ${payment.number} to bill ${bill.number}`,
      postedAt: bill.billDate,
      lines: [
        {
          accountCode: AP_ACCOUNT,
          debit: applyAmt,
          memo: `AP relief — deposit ${payment.number} applied to bill ${bill.number}`,
        },
        {
          accountCode: VENDOR_DEPOSITS_ASSET,
          credit: applyAmt,
          memo: `Vendor deposit consumed — bill ${bill.number}`,
        },
      ],
    });

    await audit(tx, {
      action: AuditAction.PO_PAYMENT_APPLIED,
      entityType: 'PoPaymentApplication',
      entityId: application.id,
      after: application,
      ctx,
    });

    billRemaining = billRemaining.minus(applyAmt);
    applications.push(application);
  }

  // Refresh the bill's amountDeposited + paymentStatus from the new rows.
  if (applications.length > 0) {
    await recomputeBillDenormsTx(tx, bill.id);
  }

  return applications;
}

// ---------------------------------------------------------------------------
// voidPoPayment — reverse a deposit. Cascade-reverses any live applications
// (DR 1510 / CR 2010 AP, restoring each bill's balance) then reverses the
// deposit cash leg (DR <cashAccount> / CR 1510). Keeps the row (REVERSED).
// ---------------------------------------------------------------------------

export async function voidPoPayment(
  db: PrismaClient,
  purchaseOrderId: string,
  poPaymentId: string,
  input: VoidPoPaymentInput,
  ctx?: AuditContext,
): Promise<PoPayment> {
  const data = voidPoPaymentInputSchema.parse(input);
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT 1 FROM "PoPayment" WHERE "id" = ${poPaymentId} FOR UPDATE`;
    const before = await tx.poPayment.findUnique({
      where: { id: poPaymentId },
      include: {
        cashAccount: { select: { code: true } },
        applications: { where: { reversedAt: null } },
      },
    });
    if (!before || before.deletedAt) {
      throw new Error(`PoPayment not found: ${poPaymentId}`);
    }
    if (before.purchaseOrderId !== purchaseOrderId) {
      throw new Error(
        `Deposit ${poPaymentId} does not belong to PurchaseOrder ${purchaseOrderId}`,
      );
    }
    if (before.status === PaymentStatus.REVERSED) {
      throw new Error('PoPayment is already REVERSED');
    }
    if (!before.cashAccount?.code) {
      throw new Error(
        'Cannot void a deposit whose cash account has been removed',
      );
    }

    const now = new Date();

    // 1. Cascade-reverse live applications. Each: DR 1510 / CR AP, restoring
    //    the bill's AP balance, then recompute that bill's denorms.
    for (const app of before.applications) {
      const bill = await tx.bill.findUniqueOrThrow({
        where: { id: app.billId },
        select: { number: true },
      });
      await tx.poPaymentApplication.update({
        where: { id: app.id },
        data: { reversedAt: now },
      });
      if (app.amount.greaterThan(0)) {
        await post(tx, {
          entityType: 'PoPaymentApplication',
          entityId: app.id,
          description: `Reverse PO deposit ${before.number} application to bill ${bill.number} (deposit voided)`,
          postedAt: now,
          lines: [
            {
              accountCode: VENDOR_DEPOSITS_ASSET,
              debit: app.amount,
              memo: `Restore vendor deposit — application reversed`,
            },
            {
              accountCode: AP_ACCOUNT,
              credit: app.amount,
              memo: `Restore AP — deposit ${before.number} application reversed`,
            },
          ],
        });
      }
      await recomputeBillDenormsTx(tx, app.billId);
      await audit(tx, {
        action: AuditAction.STATUS_CHANGE,
        entityType: 'PoPaymentApplication',
        entityId: app.id,
        before: { reversedAt: null },
        after: { reversedAt: now },
        ctx: { ...ctx, reason: `Deposit ${before.number} voided: ${data.reason}` },
      });
    }

    // 2. Reverse the deposit cash leg: DR <cashAccount> / CR 1510 for the
    //    full original amount. With the applications unwound above, 1510 is
    //    back to the full deposit; this returns it to zero and restores cash.
    if (before.amount.greaterThan(0)) {
      await post(tx, {
        entityType: 'PoPayment',
        entityId: before.id,
        description: `Reverse PO deposit ${before.number}: ${data.reason}`,
        postedAt: now,
        lines: [
          {
            accountCode: before.cashAccount.code,
            debit: before.amount,
            memo: `Cash returned — deposit ${before.number} voided`,
          },
          {
            accountCode: VENDOR_DEPOSITS_ASSET,
            credit: before.amount,
            memo: `Remove vendor deposit — ${before.number} voided`,
          },
        ],
      });
    }

    const after = await tx.poPayment.update({
      where: { id: poPaymentId },
      data: {
        status: PaymentStatus.REVERSED,
        reversedAt: now,
        reversedReason: data.reason,
        appliedAmount: new Prisma.Decimal(0),
      },
    });

    await audit(tx, {
      action: AuditAction.PO_PAYMENT_REVERSED,
      entityType: 'PoPayment',
      entityId: poPaymentId,
      before: { status: before.status },
      after: { status: after.status, reversedAt: after.reversedAt },
      ctx: { ...ctx, reason: data.reason },
    });

    return after;
  });
}

// ---------------------------------------------------------------------------
// Read paths
// ---------------------------------------------------------------------------

export async function listPoPayments(
  db: PrismaClient,
  purchaseOrderId: string,
): Promise<PoPayment[]> {
  return db.poPayment.findMany({
    where: { purchaseOrderId, deletedAt: null },
    orderBy: { paymentDate: 'desc' },
  });
}
