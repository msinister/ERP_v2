import {
  AccountType,
  AuditAction,
  BillStatus,
  PaymentStatus,
  Prisma,
  VendorCreditStatus,
} from '@/generated/tenant';
import type {
  BillPayment,
  PrismaClient,
  VendorCredit,
} from '@/generated/tenant';
import { audit, type AuditContext } from '@/lib/audit/audit';
import { post } from '@/lib/gl/post';
import { getNextSequence } from '@/lib/sequences/sequences';
import {
  recordBillPaymentInputSchema,
  reverseBillPaymentInputSchema,
  type RecordBillPaymentInput,
  type ReverseBillPaymentInput,
} from '@/lib/validation/ap';
import { recomputeBillDenormsTx } from './bills';

// =============================================================================
// BillPayment service. Records cash-out events against confirmed bills.
// Spec: docs/07-accounts-payable.md#payment-workflow.
//
// Sequence: BPMT-YYYY-NNNNN.
//
// JE on record:    DR 2010 AP / CR <cashAccountId> for the full payment amount
// JE on reverse:   mirror swap (DR cash / CR AP)
//
// Overpayment auto-VC: if amount > remaining balance, the excess
// auto-creates a CONFIRMED VendorCredit (sourceTag carries the
// BillPayment id for traceability). The VC's confirm posts its own JE
// (DR AP / CR VCA per spec docs/07:159).
//
// Net effect of overpayment:
//   - Cash CR by full amount (e.g., $120)
//   - AP DR by full amount, then DR by VC amount on the VC confirm,
//     net AP impact = -bill.total (correctly settles the bill in AP)
//   - VCA CR by overpayment amount (e.g., $20) — represents vendor
//     credit balance available for application
//   - Bill.amountPaid capped at bill.total
//
// Bill-payment vs vendor-credit-application: APPLIED_CREDIT method is
// rejected at validation. Vendor credit applications flow through
// applyVendorCreditToBillTx (vendorCredits.ts), not through this service.
// =============================================================================

const BILL_PAYMENT_SEQUENCE_NAME = 'bill_payment';
const BILL_PAYMENT_PREFIX = 'BPMT';
const VC_SEQUENCE_NAME = 'vendor_credit';
const VC_PREFIX = 'VCM';

const AP_ACCOUNT = '2010';
// 1410 "Vendor Credits" (ASSET). An overpayment recognizes a credit asset:
// DR 1410 / CR 2010 AP. The CR AP corrects the main payment JE — that JE
// debits AP the FULL payment, but only the bill portion settles AP; the
// overpaid excess is an asset (vendor owes us), not a payable relief.
const VENDOR_CREDITS_ASSET = '1410';

export type BillPaymentResult = {
  billPayment: BillPayment;
  // Set when an overpayment auto-created a vendor credit.
  overpaymentCredit: VendorCredit | null;
};

// ---------------------------------------------------------------------------
// recordBillPayment
// ---------------------------------------------------------------------------

export async function recordBillPayment(
  db: PrismaClient,
  input: RecordBillPaymentInput,
  ctx?: AuditContext,
): Promise<BillPaymentResult> {
  return db.$transaction((tx) => recordBillPaymentTx(tx, input, ctx));
}

// Tx-composable core. Runs inside a caller-supplied transaction so flows
// like logExpense can record a payment atomically alongside the bill
// create + confirm. recordBillPayment is the standalone wrapper.
export async function recordBillPaymentTx(
  tx: Prisma.TransactionClient,
  input: RecordBillPaymentInput,
  ctx?: AuditContext,
): Promise<BillPaymentResult> {
  const data = recordBillPaymentInputSchema.parse(input);
  const amount = new Prisma.Decimal(data.amount);
  const paymentDate = data.paymentDate ?? new Date();

  // Lock the bill so concurrent payment recording can't race the
  // overpayment-detection logic.
  await tx.$executeRaw`SELECT 1 FROM "Bill" WHERE "id" = ${data.billId} FOR UPDATE`;
  const bill = await tx.bill.findUnique({
    where: { id: data.billId },
  });
  if (!bill) throw new Error(`Bill not found: ${data.billId}`);
  if (bill.deletedAt) throw new Error('Bill is soft-deleted');
  if (bill.status !== BillStatus.CONFIRMED) {
    throw new Error(
      `Cannot record payment on bill in status ${bill.status} (only CONFIRMED accepts payments)`,
    );
  }

  // Validate cash account.
  const cashAccount = await tx.glAccount.findUnique({
    where: { id: data.cashAccountId },
    select: { id: true, code: true, type: true, active: true, deletedAt: true },
  });
  if (!cashAccount || cashAccount.deletedAt) {
    throw new Error(`GlAccount not found: ${data.cashAccountId}`);
  }
  // Allow ASSET (cash/bank, 1xxx) and LIABILITY (e.g. a credit-card
  // payable, 2xxx) — paying a bill on a credit card credits the card
  // liability rather than a cash account. Both keep the JE balanced
  // (DR AP / CR cashAccount); other types (EQUITY/REVENUE/EXPENSE)
  // make no sense as a payment source.
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

  // Compute remaining balance from current denorms — bill is locked
  // so this is the authoritative read.
  const remaining = bill.total
    .minus(bill.amountPaid)
    .minus(bill.amountCredited);

  // Allocate BPMT sequence + create the BillPayment row.
  const seq = await getNextSequence(tx, {
    name: BILL_PAYMENT_SEQUENCE_NAME,
    prefix: BILL_PAYMENT_PREFIX,
    useYear: true,
  });
  const billPayment = await tx.billPayment.create({
    data: {
      number: seq.formatted,
      billId: bill.id,
      vendorId: bill.vendorId,
      amount,
      method: data.method,
      cashAccountId: cashAccount.id,
      paymentDate,
      reference: data.reference ?? null,
      notes: data.notes ?? null,
      status: PaymentStatus.RECORDED,
      createdById: ctx?.userId ?? null,
    },
  });

  // Post the cash-out JE: DR AP / CR cash for the full amount.
  if (amount.greaterThan(0)) {
    await post(tx, {
      entityType: 'BillPayment',
      entityId: billPayment.id,
      description: `Bill payment ${billPayment.number} for bill ${bill.number}`,
      postedAt: paymentDate,
      lines: [
        {
          accountCode: AP_ACCOUNT,
          debit: amount,
          memo: `Settle AP — bill ${bill.number}`,
        },
        {
          accountCode: cashAccount.code,
          credit: amount,
          memo: `Cash out — ${data.method}${data.reference ? ` ref ${data.reference}` : ''}`,
        },
      ],
    });
  }

  // Overpayment? Auto-create + confirm a VendorCredit for the excess.
  let overpaymentCredit: VendorCredit | null = null;
  const overpaidBy = amount.minus(remaining);
  if (overpaidBy.greaterThan(0) && remaining.greaterThanOrEqualTo(0)) {
    // Allocate VCM sequence.
    const vcSeq = await getNextSequence(tx, {
      name: VC_SEQUENCE_NAME,
      prefix: VC_PREFIX,
      useYear: true,
    });
    overpaymentCredit = await tx.vendorCredit.create({
      data: {
        number: vcSeq.formatted,
        vendorId: bill.vendorId,
        status: VendorCreditStatus.CONFIRMED,
        creditDate: paymentDate,
        amount: overpaidBy,
        appliedAmount: new Prisma.Decimal(0),
        currency: bill.currency ?? 'USD',
        reason: `Overpayment from bill payment ${billPayment.number}`,
        notes: `Auto-created from BillPayment ${billPayment.number} on bill ${bill.number}`,
        createdById: ctx?.userId ?? null,
        confirmedAt: paymentDate,
        sourceTag: `OVERPAYMENT:${billPayment.id}`,
        lines: {
          create: [
            {
              lineNumber: 1,
              description: `Overpayment of $${overpaidBy.toString()} on bill ${bill.number}`,
              amount: overpaidBy,
            },
          ],
        },
      },
    });

    // Post the auto-VC's confirm JE: DR 1410 Vendor Credits / CR 2010 AP.
    // Differs from confirmVendorCredit's issue JE (which credits 5150
    // Purchase Returns): here the cash already left in the main payment JE
    // above, which debited AP the FULL amount. Only the bill portion should
    // relieve AP, so we credit AP back by the overpaid excess and recognize
    // it as a vendor-credit asset instead. Net AP relief = bill total. Kept
    // inline (not via confirmVendorCredit) to stay in this transaction.
    await post(tx, {
      entityType: 'VendorCredit',
      entityId: overpaymentCredit.id,
      description: `Confirm vendor credit ${overpaymentCredit.number} (overpayment from BPMT ${billPayment.number})`,
      postedAt: paymentDate,
      lines: [
        {
          accountCode: VENDOR_CREDITS_ASSET,
          debit: overpaidBy,
          memo: `Vendor credit asset (overpayment) — bill ${bill.number}`,
        },
        {
          accountCode: AP_ACCOUNT,
          credit: overpaidBy,
          memo: `Correct AP — overpaid excess is an asset, not bill settlement`,
        },
      ],
    });

    await audit(tx, {
      action: AuditAction.VENDOR_CREDIT_CONFIRMED,
      entityType: 'VendorCredit',
      entityId: overpaymentCredit.id,
      after: overpaymentCredit,
      ctx,
    });
  }

  // Recompute bill denorms (caps amountPaid at bill.total — the
  // overpayment portion lives on the VC, not on bill.amountPaid).
  await recomputeBillDenormsTx(tx, bill.id);

  await audit(tx, {
    action: AuditAction.BILL_PAYMENT_RECORDED,
    entityType: 'BillPayment',
    entityId: billPayment.id,
    after: billPayment,
    ctx,
  });

  return { billPayment, overpaymentCredit };
}

// ---------------------------------------------------------------------------
// reverseBillPayment
// ---------------------------------------------------------------------------

export async function reverseBillPayment(
  db: PrismaClient,
  billPaymentId: string,
  input: ReverseBillPaymentInput,
  ctx?: AuditContext,
): Promise<BillPayment> {
  const data = reverseBillPaymentInputSchema.parse(input);
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT 1 FROM "BillPayment" WHERE "id" = ${billPaymentId} FOR UPDATE`;
    const before = await tx.billPayment.findUnique({
      where: { id: billPaymentId },
      include: { cashAccount: { select: { code: true } } },
    });
    if (!before) throw new Error(`BillPayment not found: ${billPaymentId}`);
    if (before.deletedAt) throw new Error('BillPayment is soft-deleted');
    if (before.status === PaymentStatus.REVERSED) {
      throw new Error('BillPayment is already REVERSED');
    }
    if (!before.cashAccount?.code) {
      throw new Error(
        'Cannot reverse a BillPayment whose cashAccount has been removed',
      );
    }

    // Refuse if a non-reversed overpayment VC exists AND has been
    // applied (partially or fully). Mirrors the AR-side rule that you
    // can't reverse a payment whose credit has been consumed.
    const overpaymentVc = await tx.vendorCredit.findFirst({
      where: {
        sourceTag: `OVERPAYMENT:${before.id}`,
        status: VendorCreditStatus.CONFIRMED,
      },
      select: { id: true, number: true, appliedAmount: true },
    });
    if (overpaymentVc && overpaymentVc.appliedAmount.greaterThan(0)) {
      throw new Error(
        `Cannot reverse BillPayment ${before.number}: linked vendor credit ${overpaymentVc.number} has been applied. Reverse the credit applications first.`,
      );
    }

    const now = new Date();

    // If an overpayment VC exists (and is unapplied), cancel it inline
    // so the reverse flow leaves no orphan credit. Posts the mirror of the
    // overpayment issue JE — DR 2010 AP / CR 1410 — undoing the asset and
    // the AP correction. Stays inside the same transaction.
    if (overpaymentVc) {
      await post(tx, {
        entityType: 'VendorCredit',
        entityId: overpaymentVc.id,
        description: `Cancel vendor credit ${overpaymentVc.number} (BillPayment ${before.number} reversed)`,
        postedAt: now,
        lines: [
          {
            accountCode: AP_ACCOUNT,
            debit: overpaymentVc.appliedAmount.equals(0)
              ? // No application — full credit amount unwinds.
                (
                  await tx.vendorCredit.findUniqueOrThrow({
                    where: { id: overpaymentVc.id },
                    select: { amount: true },
                  })
                ).amount
              : overpaymentVc.appliedAmount,
            memo: `Reverse AP correction (overpayment unwound)`,
          },
          {
            accountCode: VENDOR_CREDITS_ASSET,
            credit: overpaymentVc.appliedAmount.equals(0)
              ? (
                  await tx.vendorCredit.findUniqueOrThrow({
                    where: { id: overpaymentVc.id },
                    select: { amount: true },
                  })
                ).amount
              : overpaymentVc.appliedAmount,
            memo: `Remove vendor credit asset — overpayment unwound`,
          },
        ],
      });
      await tx.vendorCredit.update({
        where: { id: overpaymentVc.id },
        data: {
          status: VendorCreditStatus.CANCELLED,
          cancelledAt: now,
          cancelReason: `Source BillPayment ${before.number} reversed: ${data.reason}`,
        },
      });
      await audit(tx, {
        action: AuditAction.STATUS_CHANGE,
        entityType: 'VendorCredit',
        entityId: overpaymentVc.id,
        before: { status: VendorCreditStatus.CONFIRMED },
        after: { status: VendorCreditStatus.CANCELLED },
        ctx: { ...ctx, reason: `Source BillPayment ${before.number} reversed` },
      });
    }

    // Post the reversal JE for the original payment: mirror swap.
    if (before.amount.greaterThan(0)) {
      await post(tx, {
        entityType: 'BillPayment',
        entityId: before.id,
        description: `Reverse bill payment ${before.number}: ${data.reason}`,
        postedAt: now,
        lines: [
          {
            accountCode: before.cashAccount.code,
            debit: before.amount,
            memo: `Cash returned — payment reversal`,
          },
          {
            accountCode: AP_ACCOUNT,
            credit: before.amount,
            memo: `Restore AP — payment reversal`,
          },
        ],
      });
    }

    const after = await tx.billPayment.update({
      where: { id: billPaymentId },
      data: {
        status: PaymentStatus.REVERSED,
        reversedAt: now,
        reversedReason: data.reason,
      },
    });

    // Recompute the source bill's denorms now that this payment is
    // excluded from the SUM.
    await recomputeBillDenormsTx(tx, before.billId);

    await audit(tx, {
      action: AuditAction.BILL_PAYMENT_REVERSED,
      entityType: 'BillPayment',
      entityId: billPaymentId,
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

export async function getBillPayment(
  db: PrismaClient,
  billPaymentId: string,
): Promise<BillPayment | null> {
  return db.billPayment.findFirst({
    where: { id: billPaymentId, deletedAt: null },
  });
}

export type BillPaymentListFilters = {
  billId?: string;
  vendorId?: string;
  status?: PaymentStatus;
  paymentDateFrom?: Date;
  paymentDateTo?: Date;
  skip?: number;
  take?: number;
};

export async function listBillPayments(
  db: PrismaClient,
  filters: BillPaymentListFilters = {},
): Promise<BillPayment[]> {
  const {
    billId,
    vendorId,
    status,
    paymentDateFrom,
    paymentDateTo,
    skip = 0,
    take = 100,
  } = filters;
  const dateFilter: { gte?: Date; lte?: Date } = {};
  if (paymentDateFrom) dateFilter.gte = paymentDateFrom;
  if (paymentDateTo) dateFilter.lte = paymentDateTo;
  return db.billPayment.findMany({
    where: {
      deletedAt: null,
      ...(billId ? { billId } : {}),
      ...(vendorId ? { vendorId } : {}),
      ...(status ? { status } : {}),
      ...(paymentDateFrom || paymentDateTo ? { paymentDate: dateFilter } : {}),
    },
    orderBy: { paymentDate: 'desc' },
    skip,
    take: Math.min(take, 500),
  });
}
