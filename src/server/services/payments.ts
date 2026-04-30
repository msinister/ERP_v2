import {
  AuditAction,
  CreditApplicationKind,
  CreditMemoStatus,
  InvoiceStatus,
  PaymentMethod,
  PaymentStatus,
  Prisma,
} from '@/generated/tenant';
import type {
  CreditApplication,
  Payment,
  PrismaClient,
} from '@/generated/tenant';
import { audit, type AuditContext } from '@/lib/audit/audit';
import { post } from '@/lib/gl/post';
import { getNextSequence } from '@/lib/sequences/sequences';
import {
  applyCreditInputSchema,
  recordPaymentInputSchema,
  reversePaymentInputSchema,
  type ApplyCreditInput,
  type RecordPaymentInput,
  type ReversePaymentInput,
} from '@/lib/validation/invoicing';
import { recomputeAmountPaidForInvoice } from './invoices';

// =============================================================================
// Payments service.
//
// recordPayment is the canonical entry point for receiving customer money.
// applyPaymentToInvoice / applyCreditToInvoice are the discrete one-line
// applications. reversePayment undoes a recorded payment.
//
// JE creation goes through lib/gl/post — never tx.journalEntry.create.
// Direct mutation of Invoice.amountPaid / amountCredited is forbidden;
// every mutation routes through invoices.recomputeAmountPaidForInvoice.
//
// IMPORTANT — APPLIED_CREDIT method semantics: a recordPayment with
// method=APPLIED_CREDIT does NOT post a cash-receipt JE. Cash didn't
// move; the customer is consuming existing CreditMemo credit. The
// Payment row exists for audit trail. Each application entry is
// internally implemented as a CreditApplication of
// kind=CREDIT_TO_INVOICE drawn FIFO from the customer's confirmed
// CMs (oldest first), bumping CM.appliedAmount and the invoice's
// amountCredited (NOT amountPaid). Documented inline below.
// =============================================================================

const PAYMENT_SEQUENCE_NAME = 'payment';
const PAYMENT_PREFIX = 'PMT';
const CASH_ACCOUNT = '1110';
const AR_ACCOUNT = '1210';

export type PaymentWithApplications = Payment & { applications: CreditApplication[] };

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function lockPayment(
  tx: Prisma.TransactionClient,
  paymentId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT 1 FROM "Payment" WHERE "id" = ${paymentId} FOR UPDATE`;
}

async function lockCreditMemo(
  tx: Prisma.TransactionClient,
  creditMemoId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT 1 FROM "CreditMemo" WHERE "id" = ${creditMemoId} FOR UPDATE`;
}

/**
 * Customer's available CreditMemo credit at this moment — sum of
 * (CM.netCredit − CM.appliedAmount) over CONFIRMED, non-voided,
 * non-deleted CMs. Used by APPLIED_CREDIT validation.
 */
async function getAvailableCmCredit(
  tx: Prisma.TransactionClient,
  customerId: string,
): Promise<Prisma.Decimal> {
  const cms = await tx.creditMemo.findMany({
    where: {
      customerId,
      status: CreditMemoStatus.CONFIRMED,
      deletedAt: null,
    },
    select: { netCredit: true, appliedAmount: true },
  });
  return cms.reduce(
    (acc, c) => acc.plus(c.netCredit).minus(c.appliedAmount),
    new Prisma.Decimal(0),
  );
}

// ---------------------------------------------------------------------------
// applyPaymentToInvoice (Tx variant + public wrapper)
// ---------------------------------------------------------------------------

async function applyPaymentToInvoiceTx(
  tx: Prisma.TransactionClient,
  paymentId: string,
  invoiceId: string,
  amount: Prisma.Decimal,
  ctx?: AuditContext,
): Promise<CreditApplication> {
  await lockPayment(tx, paymentId);
  const payment = await tx.payment.findUnique({ where: { id: paymentId } });
  if (!payment) throw new Error(`Payment not found: ${paymentId}`);
  if (payment.deletedAt) throw new Error('Payment is soft-deleted');
  if (payment.status !== PaymentStatus.RECORDED) {
    throw new Error(`Cannot apply payment in status ${payment.status}`);
  }

  const invoice = await tx.invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice) throw new Error(`Invoice not found: ${invoiceId}`);
  if (invoice.deletedAt) throw new Error('Invoice is soft-deleted');
  if (invoice.customerId !== payment.customerId) {
    throw new Error(
      `Cross-customer application: payment customer ${payment.customerId} != invoice customer ${invoice.customerId}`,
    );
  }
  if (invoice.status === InvoiceStatus.VOIDED) {
    throw new Error('Cannot apply payment to a VOIDED invoice');
  }

  // Don't overapply.
  const newApplied = payment.appliedAmount.plus(amount);
  if (newApplied.greaterThan(payment.amount)) {
    throw new Error(
      `Application would overapply payment ${payment.number}: applied=${payment.appliedAmount.toString()} + ${amount.toString()} > amount=${payment.amount.toString()}`,
    );
  }

  // Friendly precheck for the partial-unique invariant. The DB index
  // is the authoritative guard but the human-readable error here is
  // worth the extra query.
  const existing = await tx.creditApplication.findFirst({
    where: { paymentId, invoiceId, reversedAt: null },
  });
  if (existing) {
    throw new Error(
      `Payment ${payment.number} already partially applied to invoice ${invoice.number}. Reverse the existing application first if you need to adjust.`,
    );
  }

  const app = await tx.creditApplication.create({
    data: {
      kind: CreditApplicationKind.PAYMENT_TO_INVOICE,
      paymentId,
      invoiceId,
      amount,
      appliedById: ctx?.userId ?? null,
    },
  });

  await tx.payment.update({
    where: { id: paymentId },
    data: { appliedAmount: newApplied },
  });

  await recomputeAmountPaidForInvoice(tx, invoiceId);

  await audit(tx, {
    action: AuditAction.CREATE,
    entityType: 'CreditApplication',
    entityId: app.id,
    after: app,
    ctx,
  });
  return app;
}

export async function applyPaymentToInvoice(
  db: PrismaClient,
  paymentId: string,
  invoiceId: string,
  amount: Prisma.Decimal | string | number,
  ctx?: AuditContext,
): Promise<CreditApplication> {
  return db.$transaction((tx) =>
    applyPaymentToInvoiceTx(tx, paymentId, invoiceId, new Prisma.Decimal(amount), ctx),
  );
}

// ---------------------------------------------------------------------------
// applyCreditToInvoice (Tx variant + public wrapper)
// ---------------------------------------------------------------------------

async function applyCreditToInvoiceTx(
  tx: Prisma.TransactionClient,
  creditMemoId: string,
  invoiceId: string,
  amount: Prisma.Decimal,
  ctx?: AuditContext,
  // When set, the CreditApplication row carries BOTH creditMemoId
  // and paymentId — used by the APPLIED_CREDIT method on
  // recordPayment so reversePayment can find these rows via the
  // Payment.applications relation. kind stays CREDIT_TO_INVOICE so
  // recomputeAmountPaid bumps the invoice's amountCredited (not
  // amountPaid), per spec.
  applicationPaymentId?: string,
): Promise<CreditApplication> {
  await lockCreditMemo(tx, creditMemoId);
  const cm = await tx.creditMemo.findUnique({ where: { id: creditMemoId } });
  if (!cm) throw new Error(`CreditMemo not found: ${creditMemoId}`);
  if (cm.deletedAt) throw new Error('CreditMemo is soft-deleted');
  if (cm.status !== CreditMemoStatus.CONFIRMED) {
    throw new Error(`Cannot apply credit memo in status ${cm.status}`);
  }

  const invoice = await tx.invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice) throw new Error(`Invoice not found: ${invoiceId}`);
  if (invoice.deletedAt) throw new Error('Invoice is soft-deleted');
  if (invoice.customerId !== cm.customerId) {
    throw new Error(
      `Cross-customer credit application: CM customer ${cm.customerId} != invoice customer ${invoice.customerId}`,
    );
  }
  if (invoice.status === InvoiceStatus.VOIDED) {
    throw new Error('Cannot apply credit to a VOIDED invoice');
  }

  const newApplied = cm.appliedAmount.plus(amount);
  if (newApplied.greaterThan(cm.netCredit)) {
    throw new Error(
      `Application would overapply credit memo ${cm.number}: applied=${cm.appliedAmount.toString()} + ${amount.toString()} > netCredit=${cm.netCredit.toString()}`,
    );
  }

  const existing = await tx.creditApplication.findFirst({
    where: { creditMemoId, invoiceId, reversedAt: null },
  });
  if (existing) {
    throw new Error(
      `Credit memo ${cm.number} already partially applied to invoice ${invoice.number}. Reverse the existing application first if you need to adjust.`,
    );
  }

  const app = await tx.creditApplication.create({
    data: {
      kind: CreditApplicationKind.CREDIT_TO_INVOICE,
      creditMemoId,
      // Optionally tied to a Payment row too (the APPLIED_CREDIT method
      // path) so the reverse path can find these rows via
      // Payment.applications. The partial unique index on
      // (paymentId, invoiceId) WHERE reversedAt IS NULL gracefully
      // permits this since we already pre-checked uniqueness above.
      paymentId: applicationPaymentId ?? null,
      invoiceId,
      amount,
      appliedById: ctx?.userId ?? null,
    },
  });

  await tx.creditMemo.update({
    where: { id: creditMemoId },
    data: { appliedAmount: newApplied },
  });

  await recomputeAmountPaidForInvoice(tx, invoiceId);

  await audit(tx, {
    action: AuditAction.CREATE,
    entityType: 'CreditApplication',
    entityId: app.id,
    after: app,
    ctx,
  });
  return app;
}

export async function applyCreditToInvoice(
  db: PrismaClient,
  input: ApplyCreditInput,
  ctx?: AuditContext,
): Promise<CreditApplication> {
  const data = applyCreditInputSchema.parse(input);
  return db.$transaction(async (tx) => {
    if (data.paymentId) {
      return applyPaymentToInvoiceTx(
        tx,
        data.paymentId,
        data.invoiceId,
        new Prisma.Decimal(data.amount),
        ctx,
      );
    }
    return applyCreditToInvoiceTx(
      tx,
      data.creditMemoId!,
      data.invoiceId,
      new Prisma.Decimal(data.amount),
      ctx,
    );
  });
}

// ---------------------------------------------------------------------------
// FIFO consumption of CM credit for APPLIED_CREDIT-method payments
// ---------------------------------------------------------------------------

/**
 * Walk the customer's CONFIRMED non-voided CMs in confirmedAt-ascending
 * order, drawing down `requestedAmount` of credit and applying it to
 * the target invoice. Each CM hit produces its own CreditApplication
 * row of kind=CREDIT_TO_INVOICE linked to BOTH the CM and the
 * APPLIED_CREDIT Payment (so reversePayment can find these via
 * Payment.applications). Returns the applications created.
 */
async function applyFifoCmCreditTx(
  tx: Prisma.TransactionClient,
  customerId: string,
  invoiceId: string,
  requestedAmount: Prisma.Decimal,
  appliedCreditPaymentId: string,
  appliedCreditPaymentNumber: string,
  ctx?: AuditContext,
): Promise<CreditApplication[]> {
  const cms = await tx.creditMemo.findMany({
    where: {
      customerId,
      status: CreditMemoStatus.CONFIRMED,
      deletedAt: null,
    },
    orderBy: [{ issuedAt: 'asc' }, { createdAt: 'asc' }],
  });

  const apps: CreditApplication[] = [];
  let remaining = requestedAmount;
  for (const cm of cms) {
    if (remaining.lessThanOrEqualTo(0)) break;
    const available = cm.netCredit.minus(cm.appliedAmount);
    if (available.lessThanOrEqualTo(0)) continue;
    const draw = available.lessThan(remaining) ? available : remaining;
    const app = await applyCreditToInvoiceTx(
      tx,
      cm.id,
      invoiceId,
      draw,
      { ...ctx, reason: `via APPLIED_CREDIT payment ${appliedCreditPaymentNumber}` },
      appliedCreditPaymentId,
    );
    apps.push(app);
    remaining = remaining.minus(draw);
  }

  if (remaining.greaterThan(0)) {
    // Should not happen if the upfront balance check ran, but guard
    // anyway to surface any drift between check-time and consume-time.
    throw new Error(
      `Insufficient credit balance during FIFO consumption: ${remaining.toString()} short`,
    );
  }
  return apps;
}

// ---------------------------------------------------------------------------
// recordPayment
// ---------------------------------------------------------------------------

export async function recordPayment(
  db: PrismaClient,
  input: RecordPaymentInput,
  ctx?: AuditContext,
): Promise<PaymentWithApplications> {
  const data = recordPaymentInputSchema.parse(input);
  return db.$transaction(async (tx) => {
    const customer = await tx.customer.findFirst({
      where: { id: data.customerId, deletedAt: null },
    });
    if (!customer) throw new Error(`Customer not found: ${data.customerId}`);

    const seq = await getNextSequence(tx, {
      name: PAYMENT_SEQUENCE_NAME,
      prefix: PAYMENT_PREFIX,
      useYear: true,
    });

    const amount = new Prisma.Decimal(data.amount);
    const payment = await tx.payment.create({
      data: {
        number: seq.formatted,
        customerId: data.customerId,
        method: data.method,
        status: PaymentStatus.RECORDED,
        amount,
        appliedAmount: new Prisma.Decimal(0),
        currency: data.currency ?? 'USD',
        receivedAt: data.receivedAt ?? new Date(),
        reference: data.reference ?? null,
        notes: data.notes ?? null,
      },
    });

    await audit(tx, {
      action: AuditAction.CREATE,
      entityType: 'Payment',
      entityId: payment.id,
      after: payment,
      ctx,
    });

    if (data.method === PaymentMethod.APPLIED_CREDIT) {
      // 1. Validate sufficient CM credit available.
      const available = await getAvailableCmCredit(tx, data.customerId);
      if (available.lessThan(amount)) {
        throw new Error(
          `Insufficient credit balance: customer has ${available.toString()} but APPLIED_CREDIT payment requires ${amount.toString()}`,
        );
      }
      // 2. Per application, walk CMs FIFO and create CREDIT_TO_INVOICE
      //    applications. The Payment row itself stays at appliedAmount=0;
      //    its applications are the CM-linked applications, not
      //    PAYMENT_TO_INVOICE rows linked to this synthetic Payment.
      // 3. NO cash-receipt JE — cash didn't move.
      for (const app of data.applications!) {
        await applyFifoCmCreditTx(
          tx,
          data.customerId,
          app.invoiceId,
          new Prisma.Decimal(app.amount),
          payment.id,
          payment.number,
          ctx,
        );
      }
    } else {
      // Standard cash-receipt path. JE first so the GL records the
      // receipt before any application drift. Apps next.
      await post(tx, {
        entityType: 'Payment',
        entityId: payment.id,
        description: `Payment ${payment.number} from ${customer.name}`,
        lines: [
          { accountCode: CASH_ACCOUNT, debit: amount, memo: 'Cash receipt' },
          { accountCode: AR_ACCOUNT, credit: amount, memo: 'AR — payment received' },
        ],
      });
      if (data.applications && data.applications.length > 0) {
        for (const app of data.applications) {
          await applyPaymentToInvoiceTx(
            tx,
            payment.id,
            app.invoiceId,
            new Prisma.Decimal(app.amount),
            ctx,
          );
        }
      }
    }

    const final = await tx.payment.findUniqueOrThrow({
      where: { id: payment.id },
      include: { applications: true },
    });
    return final;
  });
}

// ---------------------------------------------------------------------------
// reversePayment
// ---------------------------------------------------------------------------

export async function reversePayment(
  db: PrismaClient,
  input: ReversePaymentInput,
  ctx?: AuditContext,
): Promise<PaymentWithApplications> {
  const data = reversePaymentInputSchema.parse(input);
  return db.$transaction(async (tx) => {
    await lockPayment(tx, data.paymentId);
    const before = await tx.payment.findUnique({
      where: { id: data.paymentId },
      include: { applications: true },
    });
    if (!before) throw new Error(`Payment not found: ${data.paymentId}`);
    if (before.deletedAt) throw new Error('Payment is soft-deleted');
    if (before.status === PaymentStatus.REVERSED) {
      throw new Error('Payment is already REVERSED');
    }

    const customer = await tx.customer.findUniqueOrThrow({
      where: { id: before.customerId },
    });

    // Mark all non-reversed applications as reversed; recompute each
    // affected invoice.
    const affectedInvoiceIds = new Set<string>();
    const now = new Date();
    for (const app of before.applications) {
      if (app.reversedAt != null) continue;
      await tx.creditApplication.update({
        where: { id: app.id },
        data: { reversedAt: now },
      });
      affectedInvoiceIds.add(app.invoiceId);
    }
    for (const invoiceId of affectedInvoiceIds) {
      await recomputeAmountPaidForInvoice(tx, invoiceId);
    }

    const after = await tx.payment.update({
      where: { id: data.paymentId },
      data: {
        status: PaymentStatus.REVERSED,
        reversedAt: now,
        reversedReason: data.reason,
        appliedAmount: new Prisma.Decimal(0),
      },
      include: { applications: true },
    });

    // Reversal JE — only for non-APPLIED_CREDIT payments. APPLIED_CREDIT
    // payments never posted a cash-receipt JE in the first place; their
    // CM-linked applications above are now reversed, so the original CM
    // confirmation JE remains in effect (the CM still has its credit).
    if (before.method !== PaymentMethod.APPLIED_CREDIT) {
      await post(tx, {
        entityType: 'Payment',
        entityId: data.paymentId,
        description: `Reversal of payment ${before.number}: ${data.reason}`,
        lines: [
          { accountCode: AR_ACCOUNT, debit: before.amount, memo: 'AR — payment reversed' },
          { accountCode: CASH_ACCOUNT, credit: before.amount, memo: 'Cash reversed' },
        ],
      });
    }

    await audit(tx, {
      action: AuditAction.PAYMENT_REVERSED,
      entityType: 'Payment',
      entityId: data.paymentId,
      before: { status: before.status },
      after: { status: after.status, reversedAt: after.reversedAt },
      ctx: { ...ctx, reason: data.reason },
    });

    void customer;
    return after;
  });
}

// ---------------------------------------------------------------------------
// Read paths
// ---------------------------------------------------------------------------

export async function getPayment(
  db: PrismaClient,
  paymentId: string,
): Promise<PaymentWithApplications | null> {
  return db.payment.findFirst({
    where: { id: paymentId, deletedAt: null },
    include: { applications: true },
  });
}

export type PaymentListFilters = {
  customerId?: string;
  status?: PaymentStatus | PaymentStatus[];
  receivedAtFrom?: Date;
  receivedAtTo?: Date;
  q?: string; // matches number or reference (case-insensitive)
  skip?: number;
  take?: number;
};

export async function listPayments(
  db: PrismaClient,
  filters: PaymentListFilters = {},
): Promise<PaymentWithApplications[]> {
  const {
    customerId,
    status,
    receivedAtFrom,
    receivedAtTo,
    q,
    skip = 0,
    take = 100,
  } = filters;
  const dateFilter: { gte?: Date; lte?: Date } = {};
  if (receivedAtFrom) dateFilter.gte = receivedAtFrom;
  if (receivedAtTo) dateFilter.lte = receivedAtTo;
  return db.payment.findMany({
    where: {
      deletedAt: null,
      ...(customerId ? { customerId } : {}),
      ...(status
        ? { status: Array.isArray(status) ? { in: status } : status }
        : {}),
      ...(receivedAtFrom || receivedAtTo ? { receivedAt: dateFilter } : {}),
      ...(q
        ? {
            OR: [
              { number: { contains: q, mode: 'insensitive' as const } },
              { reference: { contains: q, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    },
    include: { applications: true },
    orderBy: { receivedAt: 'desc' },
    skip,
    take: Math.min(take, 500),
  });
}
